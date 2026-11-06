import type { Db } from "@paperclipai/db";
import { credentialPool, credentialPoolCooldowns, toolConnections, usageRequestLogs } from "@paperclipai/db";
import { aiConnectionMetadataSchema } from "@paperclipai/shared";
import { and, asc, eq, lte } from "drizzle-orm";
import { logActivity } from "./activity-log.js";
import {
  PROBE_DEFER_MS,
  PROBE_LEAD_MS,
  nextCooldownProbeWakeAt,
  resolvePoolSlotValue,
} from "./ai-credential-pool.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";
import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { registerDeadlineWork } from "./deadline-work.js";
import { registerIdleLocalWorkProbe } from "./idle-local-work.js";
import { logger } from "../middleware/logger.js";
import { usageProviderAndBillerFromModel } from "../vendor/paperclip-runner/index.js";

const poolLeaseActor = { actorType: "system" as const, actorId: "key_pool" };

interface DueCooldownRow {
  cooldownId: string;
  companyId: string;
  connectionId: string;
  slot: number;
  model: string;
  lastRunId: string | null;
  baseUrl: string | null;
  secretRef: string;
}

/** A due row that can be probed honestly: it carries the 429-triggering
 * run for usage attribution and a gateway base URL to call. */
type ProbeTarget = DueCooldownRow & { baseUrl: string; lastRunId: string };

export interface KeyPoolCooldownProbeOptions {
  signal?: AbortSignal;
  /** Test seam: the upstream chat-completions caller. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * One sweep of the key-pool probe worker (ticket 03): daily cooldowns are
 * released only by proof, so every `daily_cooldown` row whose deadline is due
 * within the probe lead window gets a minimal real request (`max_tokens: 1`)
 * against the same (slot, model) pair that 429'd. A 200 proves quota recovery
 * and releases the pair; a 429 (or any other answered status) defers the next
 * probe by the probe defer window; a network error leaves the row untouched so
 * the worker's retry re-probes it. The probe consumes real quota, so each
 * answered probe is recorded as a usage request log row attributed to the run
 * whose 429 started this cooldown (`lastRunId`) with `app: "key_pool_probe"` —
 * the spend is visible instead of silently off the books. Rows that cannot be
 * probed at all (no lease attribution, or a connection that is not an
 * api-key gateway) stay cooling: release stays evidence-driven, never
 * time-driven, and operator rotation/removal clears the row outright.
 */
export async function probeDueSlotCooldowns(
  db: Db,
  now: Date = new Date(),
  options: KeyPoolCooldownProbeOptions = {},
): Promise<number> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const dueRows = await db
    .select({
      cooldownId: credentialPoolCooldowns.id,
      companyId: credentialPoolCooldowns.companyId,
      connectionId: credentialPoolCooldowns.connectionId,
      slot: credentialPoolCooldowns.slot,
      model: credentialPoolCooldowns.model,
      lastRunId: credentialPoolCooldowns.lastRunId,
      config: toolConnections.config,
      secretRef: credentialPool.secretRef,
    })
    .from(credentialPoolCooldowns)
    .innerJoin(toolConnections, eq(toolConnections.id, credentialPoolCooldowns.connectionId))
    .innerJoin(credentialPool, and(
      eq(credentialPool.companyId, credentialPoolCooldowns.companyId),
      eq(credentialPool.connectionId, credentialPoolCooldowns.connectionId),
      eq(credentialPool.slot, credentialPoolCooldowns.slot),
    ))
    .where(and(
      eq(credentialPoolCooldowns.state, "daily_cooldown"),
      lte(credentialPoolCooldowns.cooldownUntil, new Date(now.getTime() + PROBE_LEAD_MS)),
    ))
    .orderBy(asc(credentialPoolCooldowns.cooldownUntil));
  const due: DueCooldownRow[] = dueRows.map((row) => {
    const metadata = aiConnectionMetadataSchema.safeParse(row.config?.ai);
    return {
      cooldownId: row.cooldownId,
      companyId: row.companyId,
      connectionId: row.connectionId,
      slot: row.slot,
      model: row.model,
      lastRunId: row.lastRunId,
      secretRef: row.secretRef,
      baseUrl: metadata.success
        && metadata.data.method === "api_key"
        && metadata.data.routing?.kind === "gateway"
        && metadata.data.routing.baseUrl
        ? metadata.data.routing.baseUrl
        : null,
    };
  });
  let probed = 0;
  for (const row of due) {
    if (options.signal?.aborted) break;
    // Without the 429-triggering run there is no honest run attribution for
    // the probe's usage row; leave the pair cooling rather than widening the
    // usage log's run contract (documented ticket-03 limitation).
    if (row.lastRunId === null) continue;
    if (row.baseUrl === null) {
      logger.warn({ connectionId: row.connectionId, slot: row.slot, model: row.model },
        "Key pool probe skipped: connection is not an api-key gateway");
      continue;
    }
    const target: ProbeTarget = { ...row, baseUrl: row.baseUrl, lastRunId: row.lastRunId };
    try {
      const status = await probeOnce(db, target, now, fetchImpl, options.signal);
      probed += 1;
      if (status === 200) await releaseCooldown(db, row, now);
      else await deferCooldown(db, row, now, status);
    } catch (error) {
      // Network/secret failure: leave the row's state and deadline alone —
      // the worker's retry re-probes it after retryMs.
      logger.warn({ err: error, connectionId: row.connectionId, slot: row.slot, model: row.model },
        "Key pool probe failed without state change");
    }
  }
  return probed;
}

/** One real upstream request for the cooled (slot, model) pair, returning the
 * answered HTTP status (or throwing on transport/credential failure). The
 * probe's usage row is written only when the upstream answered. */
async function probeOnce(
  db: Db,
  row: ProbeTarget,
  now: Date,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<number> {
  const keyValue = await resolvePoolSlotValue(db, row.companyId, row.connectionId,
    { id: row.cooldownId, slot: row.slot, label: null, secretRef: row.secretRef },
    { responsibleUserId: null, heartbeatRunId: row.lastRunId });
  const requestId = `keypool-probe-${row.cooldownId}-${now.getTime()}`;
  const response = await fetchImpl(`${row.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${keyValue}` },
    body: JSON.stringify({ model: row.model, messages: [{ role: "user", content: "ping" }], max_tokens: 1 }),
    // Hard bound (review F4): a silent upstream must never hang the sweep. The
    // caller's abort wins first; the 60s timeout backs it — the runner proxy
    // gives full agent traffic 600s (provider-proxy.ts), but a 1-token probe
    // needs a fraction of that. A timed-out fetch rejects, so the sweep leaves
    // the row untouched for the worker's retry (upstream silence is not quota
    // evidence).
    signal: AbortSignal.any([
      ...(signal ? [signal] : []),
      AbortSignal.timeout(60_000),
    ]),
  });
  const body = await response.json().catch(() => null);
  const usage = (body as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } } | null)?.usage;
  // Review F3: derive provider/biller from the model form the usage log
  // stores — normal rows record the routed `paperclip/<model>` string
  // (biller "paperclip"), so the bare cooldown id must not split the same
  // model into a second billing group on the Usage page. (Assumes the
  // opencode_local routed form; ticket 04's metadata.connectionId
  // groundwork narrows this.)
  const { provider, biller } = usageProviderAndBillerFromModel(`paperclip/${row.model}`);
  await db.insert(usageRequestLogs).values({
    companyId: row.companyId,
    runId: row.lastRunId,
    app: "key_pool_probe",
    provider,
    biller,
    model: row.model,
    inputTokens: typeof usage?.prompt_tokens === "number" ? usage.prompt_tokens : null,
    outputTokens: typeof usage?.completion_tokens === "number" ? usage.completion_tokens : null,
    httpStatus: response.status,
    requestId,
    occurredAt: now,
    metadata: { probe: true, keySlot: row.slot },
  }).onConflictDoNothing();
  return response.status;
}

/** Probe 200: quota is back — the pair returns to healthy and becomes
 * assignable again immediately. */
async function releaseCooldown(db: Db, row: DueCooldownRow, now: Date): Promise<void> {
  await db.update(credentialPoolCooldowns).set({
    state: "healthy", cooldownUntil: null, cooldownReason: null, lastProbeAt: now, updatedAt: now,
  }).where(eq(credentialPoolCooldowns.id, row.cooldownId));
  await logActivity(db, {
    companyId: row.companyId,
    ...poolLeaseActor,
    action: "ai_connection.key_slot_probe_released",
    entityType: "tool_connection",
    entityId: row.connectionId,
    details: { slot: row.slot, model: row.model, probeStatus: 200 },
  }).catch((error) => logger.warn({ err: error, connectionId: row.connectionId }, "Key slot probe release activity log pending"));
}

/** Probe 429 (or any other answered status): still cooling — the next probe
 * waits one defer window. A 429 keeps the pair's daily semantics; nothing
 * shortens a daily cooldown but a 200. */
async function deferCooldown(db: Db, row: DueCooldownRow, now: Date, status: number): Promise<void> {
  const deferUntil = new Date(now.getTime() + PROBE_DEFER_MS);
  await db.update(credentialPoolCooldowns).set({
    cooldownUntil: deferUntil, lastProbeAt: now, updatedAt: now,
  }).where(eq(credentialPoolCooldowns.id, row.cooldownId));
  await logActivity(db, {
    companyId: row.companyId,
    ...poolLeaseActor,
    action: "ai_connection.key_slot_probe_deferred",
    entityType: "tool_connection",
    entityId: row.connectionId,
    details: { slot: row.slot, model: row.model, probeStatus: status, deferUntil: deferUntil.toISOString() },
  }).catch((error) => logger.warn({ err: error, connectionId: row.connectionId }, "Key slot probe defer activity log pending"));
}

/**
 * The Key pool cooldown probe worker, wired like the usage-request retention
 * worker: a deadline task on the delivery coordinator whose `run` sweeps the
 * due daily cooldowns and whose `next` re-probes the earliest surviving
 * deadline. Producers signal the queue when a daily cooldown is written so a
 * table that was empty (no deadline) is learned without a restart; the 30s
 * notification coalesce keeps a burst of 429 classifications from driving a
 * full deadline probe per row. An idle-work probe reports the tracked
 * deadline state so idle-sleep-safety keeps the evidence that a sweep is
 * still pending.
 *
 * The probe functions are injectable because the cooldown state machine sits
 * deep inside the server's cyclic service graph, where module mocks do not
 * reliably reach transitive importers; tests pass stubs here instead.
 */
export interface KeyPoolCooldownWorkDeps {
  runDueProbes: (db: Db, now: Date, options: { signal?: AbortSignal }) => Promise<number>;
  nextWakeAt: (db: Db) => Promise<number | null>;
}

export function registerKeyPoolCooldownWork(
  db: Db,
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  canRun: () => boolean,
  deps: KeyPoolCooldownWorkDeps = {
    runDueProbes: probeDueSlotCooldowns,
    nextWakeAt: nextCooldownProbeWakeAt,
  },
) {
  let deadline: number | null | undefined;

  const unregister = registerIdleLocalWorkProbe(() =>
    deadline === undefined ? "unknown" : deadline === null ? "none" : "present",
  );
  const worker = registerDeadlineWork(coordinator, DELIVERY_QUEUES.keyPoolCooldown, {
    canRun,
    retryMs: 30_000,
    notificationCoalesceMs: 30_000,
    onSettled: () => {
      deadline = undefined;
    },
    run: (signal) =>
      signal.aborted
        ? Promise.resolve()
        : deps.runDueProbes(db, new Date(), { signal }).then(() => undefined),
    next: async () => {
      deadline = await deps.nextWakeAt(db);
      return deadline;
    },
  });
  return {
    ...worker,
    stop: async () => {
      unregister();
      await worker.stop();
    },
  };
}
