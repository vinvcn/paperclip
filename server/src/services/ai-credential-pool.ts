import { and, asc, eq, gt, gte, desc, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  type AiConnectionKeySlot,
  type AiConnectionKeySlotCreate,
  type AiConnectionKeySlotList,
  type AiConnectionKeySlotUpdate,
  type CredentialPoolSlotState,
  type KeyPoolFailureSlotView,
  type KeyPoolFailureSnapshot,
  readKeyPoolFailureSnapshot,
} from "@paperclipai/shared";
import {
  type Db,
  agents,
  companySecretBindings,
  companySecrets,
  credentialPool,
  credentialPoolCooldowns,
  toolConnections,
  usageRequestLogs,
} from "@paperclipai/db";
import { conflict, notFound, unprocessable, HttpError } from "../errors.js";
import { logActivity } from "./activity-log.js";
import { secretService } from "./secrets.js";
import { logger } from "../middleware/logger.js";
import { credentialPoolSlotConfigPath } from "./connection-credential-bindings.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";

/** The credential_pool row chosen to serve the next credential resolution. */
export interface AssignablePoolSlot {
  id: string;
  slot: number;
  label: string | null;
  secretRef: string;
}

export type PoolSlotActor = { actorType: "user" | "agent" | "system"; actorId: string };

/** Run-scoped assignment inputs. A heartbeatRunId turns the resolution into an
 * exclusive lease (activeRunId) released at the run's terminal write; without
 * one the resolution only selects (no lease, no stickiness writes). */
export interface PoolSlotAssignmentContext {
  agentId: string | null;
  heartbeatRunId: string | null;
  /** Key-slot pin (agent adapterConfig.keySlot or task override): assignment
   * uses this slot unconditionally — cooldown included (warn logged) — but a
   * disabled slot stays off and a missing slot fails the run. */
  pinnedSlot?: number | null;
  /** One-shot avoid (ticket 06): the retry wake of a run that failed on a
   * pooled key asks the matrix to skip that slot — the wake carries the failed
   * slot and every assignment of the resulting run filters it out (sticky and
   * lease lanes; the pin outranks it). The avoid lives in the run's own wake
   * context, so a later manual assignment sees the normal matrix again; the
   * bounded auto-retry lineage rebuilds its snapshot from this one and
   * inherits the avoid (harmless: the failed slot is cooling anyway, and the
   * 429/exhausted codes are outside the auto-retry lists). */
  avoidSlot?: number | null;
  /** Target model of the resolution. Cooldowns are tracked per (slot, model)
   * because NIM quota is counted per key × model (plan §10): the matrix checks
   * the target model's cooldown instead of the deprecated slot-level column.
   * Absent model (e.g. account-identity resolutions) skips cooldown filtering. */
  model?: string | null;
}

/**
 * Crashed runs never reach their terminal lease release, so their slot is
 * reclaimed by this TTL instead. It must comfortably exceed any ordinary run
 * (the terminal release is the normal path; an expired lease merely admits the
 * next run once the deadline passes).
 */
export const POOL_LEASE_TTL_MS = 2 * 60 * 60 * 1000 + 5 * 60 * 1000;

/**
 * Cooldown state machine constants (ticket 03, all values are decided):
 * a 429 on (slot, model) classifies as RPM when the pair saw real traffic in
 * the window (>= 2 requests) and as the daily limit otherwise; the probe
 * worker verifies daily recoveries from 5 minutes before the deadline onward
 * and defers by 2 hours per probe that does not prove recovery.
 */
export const COOLDOWN_WINDOW_MS = 60_000;
/** Minimum requests by the pair inside the window for an RPM classification. */
export const COOLDOWN_WINDOW_THRESHOLD = 2;
export const RPM_COOLDOWN_MIN_MS = 90_000;
export const DAILY_COOLDOWN_MS = 24 * 60 * 60 * 1000;
export const PROBE_LEAD_MS = 5 * 60 * 1000;
export const PROBE_DEFER_MS = 2 * 60 * 60 * 1000;

/**
 * The cooldown store's key: the bare upstream model id. Usage rows record the
 * full routed model string the runner's capture sink saw (`input.options.model`,
 * which carries the managed `paperclip/` prefix for gateway connections — the
 * production usage log has only prefixed rows), but the probe worker addresses
 * the gateway with the bare upstream body model, so cooldown rows strip the
 * prefix. The window count queries by the usage row's stored string instead
 * (review F1): the classifier receives exactly what the row records.
 */
export function cooldownModelKey(model: string | null | undefined): string | null {
  if (!model) return null;
  return model.startsWith("paperclip/") ? model.slice("paperclip/".length) : model;
}

export type PoolCooldownRow = typeof credentialPoolCooldowns.$inferSelect;

/**
 * Whether a (slot, model) cooldown still withholds assignment eligibility at
 * `now`. `daily_cooldown` cools until the probe worker proves recovery; an
 * `rpm_cooldown` becomes assignable the moment its deadline passes — the
 * deadline IS the transition (the 60s window has closed, no probe needed and
 * no write required). This query-time rule is pinned by the ticket-03 tests.
 */
export function slotCooldownActive(row: Pick<PoolCooldownRow, "state" | "cooldownUntil">, now: Date): boolean {
  if (row.state === "daily_cooldown") return true;
  if (row.state === "rpm_cooldown") return row.cooldownUntil !== null && row.cooldownUntil > now;
  return false;
}

const poolLeaseActor = { actorType: "system" as const, actorId: "key_pool" };

type PoolSlotRow = typeof credentialPool.$inferSelect;

function mostStaleFirst(a: PoolSlotRow, b: PoolSlotRow) {
  const aAt = a.lastAssignedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  const bAt = b.lastAssignedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  return aAt - bAt || a.slot - b.slot;
}

/** Display state of one slot for the target model, derived from the (slot,
 * model) cooldown rows — the credential_pool state column is deprecated. */
function slotDisplayState(
  cooldownBySlot: Map<number, PoolCooldownRow>,
  row: PoolSlotRow,
  enabled: boolean,
  now: Date,
): string {
  if (!enabled) return "disabled";
  const cooldown = cooldownBySlot.get(row.slot);
  return cooldown && slotCooldownActive(cooldown, now) ? cooldown.state : "healthy";
}

/** Structured per-slot display for failure presentation (shared contract). */
function poolSlotFailureViews(
  rows: PoolSlotRow[],
  cooldownBySlot: Map<number, PoolCooldownRow>,
  now: Date,
  agentNames: Map<string, string> = new Map(),
): KeyPoolFailureSlotView[] {
  return rows.map((row) => {
    const cooldown = cooldownBySlot.get(row.slot);
    const active = cooldown && slotCooldownActive(cooldown, now) ? cooldown : null;
    return {
      slot: row.slot,
      state: (!row.enabled ? "disabled" : active ? active.state : "healthy") as KeyPoolFailureSlotView["state"],
      model: active?.model ?? null,
      cooldownUntil: active?.cooldownUntil?.toISOString() ?? null,
      leasedByRunId: row.activeRunId,
      leasedByAgentId: row.leaseAgentId,
      leasedByAgentName: row.leaseAgentId ? agentNames.get(row.leaseAgentId) ?? null : null,
    };
  });
}

/** The lease holder's agent name keeps the exhaustion copy readable ("key 5 is
 * in use by agent Chief"); unresolved names degrade to the raw id rendering. */
async function poolLeaseAgentNames(db: Db, companyId: string, agentIds: (string | null)[]): Promise<Map<string, string>> {
  const ids = [...new Set(agentIds.filter((id): id is string => Boolean(id)))];
  if (!ids.length) return new Map();
  const rows = await db.select({ id: agents.id, name: agents.name }).from(agents)
    .where(and(eq(agents.companyId, companyId), inArray(agents.id, ids)));
  return new Map(rows.map((row) => [row.id, row.name]));
}

async function poolExhaustedError(
  db: Db,
  companyId: string,
  connectionId: string,
  modelKey: string | null,
  now: Date,
): Promise<HttpError> {
  // Fresh read at failure time: leases and cooldowns may have changed since
  // the matrix pre-screened these rows.
  const rows = await db
    .select()
    .from(credentialPool)
    .where(and(eq(credentialPool.companyId, companyId), eq(credentialPool.connectionId, connectionId)))
    .orderBy(asc(credentialPool.slot));
  const cooldowns = modelKey
    ? await db
      .select()
      .from(credentialPoolCooldowns)
      .where(and(
        eq(credentialPoolCooldowns.companyId, companyId),
        eq(credentialPoolCooldowns.connectionId, connectionId),
        eq(credentialPoolCooldowns.model, modelKey),
      ))
    : [];
  const cooldownBySlot = new Map(cooldowns.map((row) => [row.slot, row]));
  const agentNames = await poolLeaseAgentNames(db, companyId, rows.map((row) => row.leaseAgentId));
  // Snapshot for the operator: who occupies each slot and when it recovers
  // (lease expiry or cooldown end). Never a key value.
  const summary = rows.map((row) => {
    const parts = [`slot ${row.slot}: ${slotDisplayState(cooldownBySlot, row, row.enabled, now)}`];
    if (row.activeRunId) {
      parts.push(`leased by run ${row.activeRunId}${row.leaseAgentId ? ` (agent ${row.leaseAgentId})` : ""}${row.leaseExpiresAt ? ` until ${row.leaseExpiresAt.toISOString()}` : ""}`);
    } else {
      const cooldown = cooldownBySlot.get(row.slot);
      if (cooldown && cooldown.state !== "healthy" && cooldown.cooldownUntil) {
        parts.push(`cooldown until ${cooldown.cooldownUntil.toISOString()}`);
      }
    }
    return parts.join(", ");
  }).join("; ");
  return unprocessable(`No key slot of this connection's pool is available (${summary})`, {
    code: "provider_key_pool_exhausted",
    // Structured pool snapshot for the failure marker's copy; the same facts
    // the text summary carries, without any secret material. The connection id
    // lets the interruption projection refresh live pool state later.
    connectionId,
    ...(modelKey ? { model: modelKey } : {}),
    pool: poolSlotFailureViews(rows, cooldownBySlot, now, agentNames),
  });
}

/**
 * Ticket-02 assignment matrix with ticket-03 (slot, model) eligibility: pin →
 * sticky (cache affinity) → exclusive lease (least recently used) → fast-fail.
 * Callers and the fall-through contract: a connection with no pool, or with
 * zero enabled slots, returns null so the original single-credential path
 * serves the request unchanged; a pool with enabled slots that cannot serve
 * throws `provider_key_pool_exhausted` with a pool snapshot. Without a lease
 * context the matrix only selects — no lease or stickiness writes.
 *
 * Cooldown eligibility is read from the (slot, model) cooldown rows for the
 * target model (plan §10: NIM quota is per key × model); the slot-level state
 * column on credential_pool is deprecated and never consulted here.
 */
export async function selectAssignablePoolSlot(
  db: Db,
  companyId: string,
  connectionId: string,
  lease?: PoolSlotAssignmentContext,
): Promise<AssignablePoolSlot | null> {
  const rows = await db
    .select()
    .from(credentialPool)
    .where(and(eq(credentialPool.companyId, companyId), eq(credentialPool.connectionId, connectionId)))
    .orderBy(asc(credentialPool.slot));
  if (!rows.length) return null;
  const enabled = rows.filter((row) => row.enabled);
  // Zero enabled slots means the operator switched the pool off: keep the
  // ticket-01 fall-through to the single credential instead of failing runs.
  if (!enabled.length) return null;
  const runId = lease?.heartbeatRunId ?? null;
  const modelKey = cooldownModelKey(lease?.model);
  // The one-shot avoid: a pinned slot outranks it, every other lane filters it.
  const avoidSlot = lease?.avoidSlot != null && Number.isInteger(lease.avoidSlot) && lease.avoidSlot >= 1
    ? lease.avoidSlot
    : null;
  const notAvoided = (row: PoolSlotRow) => row.slot !== avoidSlot;
  const now = new Date();
  const cooldowns = modelKey
    ? await db
      .select()
      .from(credentialPoolCooldowns)
      .where(and(
        eq(credentialPoolCooldowns.companyId, companyId),
        eq(credentialPoolCooldowns.connectionId, connectionId),
        eq(credentialPoolCooldowns.model, modelKey),
      ))
    : [];
  const cooldownBySlot = new Map(cooldowns.map((row) => [row.slot, row]));
  const assignable = (row: PoolSlotRow) => {
    const cooldown = cooldownBySlot.get(row.slot);
    return !cooldown || !slotCooldownActive(cooldown, now);
  };
  const exhausted = async () => poolExhaustedError(db, companyId, connectionId, modelKey, now);
  if (!runId) {
    // Ephemeral selection for a resolution outside a run: pin, then sticky,
    // then least-recently-used — no lease is taken and stickiness stays put.
    const pinned = lease?.pinnedSlot != null ? enabled.find((row) => row.slot === lease.pinnedSlot) : undefined;
    const healthy = enabled.filter((row) => assignable(row) && notAvoided(row));
    const sticky = lease?.agentId
      ? [...healthy].sort((a, b) => (b.lastAssignedAt?.getTime() ?? 0) - (a.lastAssignedAt?.getTime() ?? 0))
        .find((row) => row.lastAssignedAgentId === lease.agentId)
      : undefined;
    const chosen = pinned ?? sticky ?? [...healthy].sort(mostStaleFirst)[0];
    if (!chosen) throw await exhausted();
    return { id: chosen.id, slot: chosen.slot, label: chosen.label, secretRef: chosen.secretRef };
  }
  const agentId = lease?.agentId ?? null;
  // A lease is taken (or refreshed) by a conditional UPDATE that re-checks
  // every eligibility criterion atomically — two runs can never hold the same
  // slot because the second UPDATE re-reads the committed row and matches
  // nothing (exclusive-lease cap of 1 active run per slot).
  const takeLease = (slotId: string, respectCooldown: boolean) => takePoolSlotLease(db, {
    companyId, connectionId, slotId, runId, agentId, modelKey, now, respectCooldown,
  });
  const logLease = (slot: number, pinned: boolean, expiresAt: Date) =>
    logActivity(db, {
      companyId,
      ...poolLeaseActor,
      action: "ai_connection.key_slot_leased",
      entityType: "tool_connection",
      entityId: connectionId,
      runId,
      agentId,
      details: { slot, model: modelKey, pinned, leaseExpiresAt: expiresAt.toISOString(), ...(avoidSlot != null ? { avoidedSlot: avoidSlot } : {}) },
    }).catch((error) => logger.warn({ err: error, companyId, connectionId, runId }, "Key slot lease activity log pending"));
  if (lease?.pinnedSlot != null) {
    const pinned = rows.find((row) => row.slot === lease.pinnedSlot);
    if (!pinned) {
      throw unprocessable(`The pinned key slot ${lease.pinnedSlot} does not exist on this connection's key pool`, {
        code: "ai_connection_pinned_slot_unavailable",
      });
    }
    if (!pinned.enabled) {
      throw unprocessable(`The pinned key slot ${lease.pinnedSlot} is disabled on this connection's key pool`, {
        code: "ai_connection_pinned_slot_unavailable",
      });
    }
    // Pin bypasses the cooldown state machine unconditionally (risk accepted by
    // the operator), but never the operator's enabled switch or the exclusive
    // lease of another run. The warn judges the pinned slot for the target
    // model only — another model's cooldown does not shame this pin.
    const pinnedCooldown = modelKey ? cooldownBySlot.get(pinned.slot) : undefined;
    if (pinnedCooldown && slotCooldownActive(pinnedCooldown, now)) {
      await logActivity(db, {
        companyId,
        ...poolLeaseActor,
        action: "ai_connection.key_slot_pin_cooldown",
        entityType: "tool_connection",
        entityId: connectionId,
        runId,
        agentId,
        details: {
          slot: pinned.slot,
          model: pinnedCooldown.model,
          state: pinnedCooldown.state,
          cooldownUntil: pinnedCooldown.cooldownUntil?.toISOString() ?? null,
        },
      }).catch((error) => logger.warn({ err: error, companyId, connectionId, runId }, "Pinned cooldown slot activity log pending"));
      logger.warn({ companyId, connectionId, runId, slot: pinned.slot, model: pinnedCooldown.model, state: pinnedCooldown.state },
        "Pinned key slot is in cooldown and will be used anyway");
    }
    const taken = await takeLease(pinned.id, false);
    if (taken) {
      await logLease(taken.slot, true, taken.leaseExpiresAt!);
      return { id: taken.id, slot: taken.slot, label: taken.label, secretRef: taken.secretRef };
    }
    throw await exhausted();
  }
  // Sticky: the agent's last slot keeps its prompt cache (key = account) while
  // it is assignable for the target model and free. A slot leased by this same
  // run still counts — a credential re-resolution inside one run must land on
  // the same slot.
  if (agentId) {
    const sticky = [...enabled]
      .filter((row) => assignable(row) && notAvoided(row) && row.lastAssignedAgentId === agentId)
      .sort((a, b) => (b.lastAssignedAt?.getTime() ?? Number.NEGATIVE_INFINITY) - (a.lastAssignedAt?.getTime() ?? Number.NEGATIVE_INFINITY) || a.slot - b.slot);
    for (const candidate of sticky) {
      const taken = await takeLease(candidate.id, true);
      if (taken) {
        await logLease(taken.slot, false, taken.leaseExpiresAt!);
        return { id: taken.id, slot: taken.slot, label: taken.label, secretRef: taken.secretRef };
      }
    }
  }
  // Exclusive lease: least recently used first (NULL lastAssignedAt = never
  // used). Each conditional UPDATE re-checks eligibility atomically, so a
  // candidate another run just claimed simply fails and the next is tried.
  const free = [...enabled]
    .filter((row) => assignable(row) && notAvoided(row) && (!row.activeRunId || row.activeRunId === runId
      || (row.leaseExpiresAt !== null && row.leaseExpiresAt < now)))
    .sort(mostStaleFirst);
  for (const candidate of free) {
    const taken = await takeLease(candidate.id, true);
    if (taken) {
      await logLease(taken.slot, false, taken.leaseExpiresAt!);
      return { id: taken.id, slot: taken.slot, label: taken.label, secretRef: taken.secretRef };
    }
  }
  throw await exhausted();
}

/**
 * The exclusive-lease claim behind the matrix (review F8): a conditional
 * UPDATE whose WHERE re-checks the whole eligibility — the operator's enabled
 * switch, the lease availability, and, when a target model is given, the
 * (slot, model) cooldown — so a cooldown writer (classifier or probe) or an
 * operator toggle that commits between the matrix's pre-screen and this
 * UPDATE cannot be raced into a lease. `respectCooldown: false` is the pin
 * path only, which uses a cooling slot deliberately (warn logged upstream).
 */
export async function takePoolSlotLease(
  db: Db,
  params: {
    companyId: string;
    connectionId: string;
    slotId: string;
    runId: string;
    agentId: string | null;
    modelKey?: string | null;
    now: Date;
    respectCooldown: boolean;
  },
): Promise<PoolSlotRow | null> {
  const { companyId, connectionId, slotId, runId, agentId, modelKey, now, respectCooldown } = params;
  const cooldownRecheck = modelKey && respectCooldown
    ? sql`not exists (select 1 from ${credentialPoolCooldowns} where ${credentialPoolCooldowns.companyId} = ${companyId} and ${credentialPoolCooldowns.connectionId} = ${connectionId} and ${credentialPoolCooldowns.slot} = ${credentialPool.slot} and ${credentialPoolCooldowns.model} = ${modelKey} and (${credentialPoolCooldowns.state} = 'daily_cooldown' or (${credentialPoolCooldowns.state} = 'rpm_cooldown' and ${gt(credentialPoolCooldowns.cooldownUntil, now)})))`
    : undefined;
  const [row] = await db
    .update(credentialPool)
    .set({
      activeRunId: runId,
      leaseExpiresAt: new Date(now.getTime() + POOL_LEASE_TTL_MS),
      leaseAgentId: agentId,
      lastAssignedAgentId: agentId,
      lastAssignedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(credentialPool.id, slotId),
        eq(credentialPool.enabled, true),
        or(
          isNull(credentialPool.activeRunId),
          eq(credentialPool.activeRunId, runId),
          lt(credentialPool.leaseExpiresAt, now),
        ),
        cooldownRecheck,
      ),
    )
    .returning();
  return row ?? null;
}

/** Resolves the pooled key value through the same encrypted company-secret path as the grant credential. */
export async function resolvePoolSlotValue(
  db: Db,
  companyId: string,
  connectionId: string,
  slot: AssignablePoolSlot,
  attribution?: { responsibleUserId?: string | null; heartbeatRunId?: string | null },
): Promise<string> {
  const [secret] = await db
    .select()
    .from(companySecrets)
    .where(and(eq(companySecrets.id, slot.secretRef), eq(companySecrets.companyId, companyId)));
  if (!secret || secret.status !== "active" || secret.scope !== "company")
    throw unprocessable("Reconnect this AI account", { code: "ai_connection_credential_missing" });
  return secretService(db).resolveSecretValue(companyId, secret.id, "latest", {
    consumerType: "tool_connection",
    consumerId: connectionId,
    configPath: credentialPoolSlotConfigPath(slot.slot),
    actorType: "system",
    actorId: null,
    // Audit attribution mirrors the grant credential() path: the responsible
    // user behind the run that consumed this pooled key.
    responsibleUserId: attribution?.responsibleUserId ?? null,
    heartbeatRunId: attribution?.heartbeatRunId ?? null,
  });
}

/**
 * Terminal runs release their exclusive lease (success, failure, cancellation
 * and setup failure all land here). Idempotent by run: a run without a lease
 * updates nothing. Crashed runs are reclaimed by the lease TTL instead.
 */
export async function releaseRunPoolLease(db: Db, runId: string): Promise<number> {
  const released = await db
    .update(credentialPool)
    .set({ activeRunId: null, leaseExpiresAt: null, leaseAgentId: null, updatedAt: new Date() })
    .where(eq(credentialPool.activeRunId, runId))
    .returning({
      companyId: credentialPool.companyId,
      connectionId: credentialPool.connectionId,
      slot: credentialPool.slot,
    });
  for (const row of released) {
    await logActivity(db, {
      companyId: row.companyId,
      ...poolLeaseActor,
      action: "ai_connection.key_slot_released",
      entityType: "tool_connection",
      entityId: row.connectionId,
      runId,
      details: { slot: row.slot },
    }).catch((error) => logger.warn({ err: error, companyId: row.companyId, connectionId: row.connectionId, runId }, "Key slot release activity log pending"));
  }
  return released.length;
}

/**
 * One (slot, model) cooldown write, shared by the 429 classifier and the probe
 * worker: upserts the cooldown row and, for daily cooldowns, signals the probe
 * queue in the same transaction so the worker learns a deadline that may be
 * the table's first. Callers add their own activity log with their specific
 * evidence (classification vs probe outcome).
 */
export async function recordSlotCooldown(
  db: Db,
  input: {
    companyId: string;
    connectionId: string;
    slot: number;
    model: string;
    state: "rpm_cooldown" | "daily_cooldown";
    cooldownUntil: Date;
    cooldownReason: string;
    runId?: string | null;
  },
): Promise<void> {
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .insert(credentialPoolCooldowns)
      .values({
        companyId: input.companyId,
        connectionId: input.connectionId,
        slot: input.slot,
        model: input.model,
        state: input.state,
        cooldownUntil: input.cooldownUntil,
        cooldownReason: input.cooldownReason,
        lastRunId: input.runId ?? null,
      })
      .onConflictDoUpdate({
        target: [
          credentialPoolCooldowns.companyId,
          credentialPoolCooldowns.connectionId,
          credentialPoolCooldowns.slot,
          credentialPoolCooldowns.model,
        ],
        set: {
          state: input.state,
          cooldownUntil: input.cooldownUntil,
          cooldownReason: input.cooldownReason,
          lastRunId: input.runId ?? null,
          updatedAt: now,
        },
      });
    if (input.state === "daily_cooldown") await notifyDeliveryWork(tx, DELIVERY_QUEUES.keyPoolCooldown);
  });
}

/** Counted shape of a 429 classification's evidence for the activity log. */
export interface KeySlot429Classification {
  state: "rpm_cooldown" | "daily_cooldown";
  cooldownUntil: Date;
  windowCount: number;
  retryAfterSeconds: number | null;
}

/**
 * The 429 classification hook (ticket 03), invoked by recordForRun after a
 * 429 usage row lands. NIM quota is counted per key × model, so the pair is
 * classified from its own 60s window: >= 2 requests (real traffic, any
 * status — including this row) that still ends in 429 means an RPM limit;
 * a 429 with an empty window means the daily limit. The window counts usage
 * rows carrying `metadata.keySlot` for the pair (ticket 04 populates it; rows
 * without it cannot be attributed and stay uncounted), matched by the model
 * form the row stores: `ctx.model` is the routed string the usage row itself
 * records (`paperclip/<model>` for managed gateway traffic), while the
 * cooldown row stores the bare upstream id for the probe (review F1).
 *
 * The window is narrowed to the pool's connection (review F2): usage rows
 * carry `metadata.connectionId` (ticket 04), so two pools in one company
 * sharing a slot number and model never count each other's traffic. The
 * cooldown row is found through the run's exclusive lease — `ctx.connectionId`
 * (the row's own attribution, when present) demands the exact pool, and a row
 * without it falls back to (run, slot). In both shapes the counted rows must
 * belong to the lease row's connection. A 429 whose run no longer matches its
 * lease (TTL reclaimed, terminal sweep after release) stays unclassified —
 * the next 429 on the pair reclassifies.
 */
export async function classifyKeySlot429(
  db: Db,
  ctx: {
    companyId: string;
    runId: string;
    keySlot: number;
    /** The usage row's own connection attribution (ticket 04); null on pre-ticket-04 rows. */
    connectionId?: string | null;
    model: string;
    retryAfterSeconds?: number | null;
    now?: Date;
  },
): Promise<KeySlot429Classification | null> {
  const now = ctx.now ?? new Date();
  // The cooldown row keeps the bare upstream id (the probe needs it); the
  // window count below uses the usage row's stored model form.
  const model = cooldownModelKey(ctx.model);
  if (!model) return null;
  const [leaseRow] = await db
    .select()
    .from(credentialPool)
    .where(and(
      eq(credentialPool.companyId, ctx.companyId),
      eq(credentialPool.activeRunId, ctx.runId),
      eq(credentialPool.slot, ctx.keySlot),
      ...(ctx.connectionId ? [eq(credentialPool.connectionId, ctx.connectionId)] : []),
    ))
    .limit(1);
  if (!leaseRow) return null;
  const [counted] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(usageRequestLogs)
    .where(and(
      eq(usageRequestLogs.companyId, ctx.companyId),
      // Review F1: count by the model form the usage row stores. Usage rows
      // record the full routed model string the capture sink saw
      // (`paperclip/<model>` for managed gateway traffic — production 429
      // rows are 24/24 prefixed), and `ctx.model` is that same string handed
      // over by recordForRun, so this equality is the storage's own identity.
      eq(usageRequestLogs.model, ctx.model),
      gte(usageRequestLogs.occurredAt, new Date(now.getTime() - COOLDOWN_WINDOW_MS)),
      sql`${usageRequestLogs.metadata}->>'keySlot' = ${String(ctx.keySlot)}`,
      // Review F2: only rows attributable to this pool's connection feed the
      // window — a same-company pool sharing the slot number and model must
      // not have its traffic counted here (and vice versa).
      sql`${usageRequestLogs.metadata}->>'connectionId' = ${leaseRow.connectionId}`,
    ));
  const windowCount = counted?.total ?? 0;
  if (windowCount >= COOLDOWN_WINDOW_THRESHOLD) {
    // max(90s, retry-after): the header wins only when it asks for longer.
    const retryAfterSeconds = ctx.retryAfterSeconds != null && ctx.retryAfterSeconds > 0
      ? ctx.retryAfterSeconds
      : null;
    const durationMs = Math.max(RPM_COOLDOWN_MIN_MS, (retryAfterSeconds ?? 0) * 1000);
    const classification: KeySlot429Classification = {
      state: "rpm_cooldown",
      cooldownUntil: new Date(now.getTime() + durationMs),
      windowCount,
      retryAfterSeconds,
    };
    await recordSlotCooldown(db, {
      companyId: ctx.companyId,
      connectionId: leaseRow.connectionId,
      slot: ctx.keySlot,
      model,
      state: classification.state,
      cooldownUntil: classification.cooldownUntil,
      cooldownReason: "rpm",
      runId: ctx.runId,
    });
    await logClassification(db, ctx, leaseRow.connectionId, model, classification);
    return classification;
  }
  const classification: KeySlot429Classification = {
    state: "daily_cooldown",
    cooldownUntil: new Date(now.getTime() + DAILY_COOLDOWN_MS),
    windowCount,
    retryAfterSeconds: null,
  };
  await recordSlotCooldown(db, {
    companyId: ctx.companyId,
    connectionId: leaseRow.connectionId,
    slot: ctx.keySlot,
    model,
    state: classification.state,
    cooldownUntil: classification.cooldownUntil,
    cooldownReason: "daily",
    runId: ctx.runId,
  });
  await logClassification(db, ctx, leaseRow.connectionId, model, classification);
  return classification;
}

/** The classification's evidence: keySlot, model, window count, retry-after. */
function logClassification(
  db: Db,
  ctx: { companyId: string; runId: string; keySlot: number },
  connectionId: string,
  model: string,
  classification: KeySlot429Classification,
) {
  return logActivity(db, {
    companyId: ctx.companyId,
    ...poolLeaseActor,
    action: "ai_connection.key_slot_cooldown",
    entityType: "tool_connection",
    entityId: connectionId,
    runId: ctx.runId,
    details: {
      slot: ctx.keySlot,
      model,
      state: classification.state,
      cooldownUntil: classification.cooldownUntil.toISOString(),
      windowCount: classification.windowCount,
      retryAfterSeconds: classification.retryAfterSeconds,
    },
  }).catch((error) => logger.warn({ err: error, connectionId, model }, "Key slot cooldown activity log pending"));
}

/**
 * The probe worker's deadline: the earliest `daily_cooldown` deadline that is
 * within the probe lead window (or already due). rpm_cooldown rows never
 * appear — they recover by eligibility alone; released (healthy) rows have no
 * deadline. Null means the worker has no obligation.
 */
export async function nextCooldownProbeDeadline(db: Db, now: Date = new Date()): Promise<number | null> {
  const [row] = await db
    .select({ until: credentialPoolCooldowns.cooldownUntil })
    .from(credentialPoolCooldowns)
    .where(and(
      eq(credentialPoolCooldowns.state, "daily_cooldown"),
      lte(credentialPoolCooldowns.cooldownUntil, new Date(now.getTime() + PROBE_LEAD_MS)),
    ))
    .orderBy(asc(credentialPoolCooldowns.cooldownUntil))
    .limit(1);
  return row?.until?.getTime() ?? null;
}

/**
 * The probe worker's coordinator wake time: the earliest daily cooldown's
 * deadline in absolute terms — future-dated rows included, so a fresh 24h
 * cooldown is learned once and wakes the worker at its deadline instead of
 * sleeping through it (deadline-work probes only re-run on wake signals).
 */
export async function nextCooldownProbeWakeAt(db: Db): Promise<number | null> {
  const [row] = await db
    .select({ until: credentialPoolCooldowns.cooldownUntil })
    .from(credentialPoolCooldowns)
    .where(eq(credentialPoolCooldowns.state, "daily_cooldown"))
    .orderBy(asc(credentialPoolCooldowns.cooldownUntil))
    .limit(1);
  return row?.until?.getTime() ?? null;
}

/** A failed run's rate-limit classification: the dedicated errorCode plus the
 * snapshot the failure marker renders. */
export interface RunRateLimitFailure {
  errorCode: "provider_rate_limited";
  snapshot: KeyPoolFailureSnapshot;
}

/**
 * Terminal classification of a run-internal 429 (ticket 05): the run's latest
 * provider request row is the terminal signal — the driver fails the turn on
 * the 429 it forwards, so no later agent request can exist for a rate-limited
 * terminal; if a later request succeeded the run failed for another reason.
 * Probe rows never count (the probe worker writes them against the original
 * run's id, long after the run went terminal). The (slot, model) cooldown row
 * (ticket 03's classifier output, keyed by the same pair the usage row
 * attributes) supplies the recovery facts; without it the snapshot degrades
 * and the copy never invents a recovery time.
 */
export async function classifyRunRateLimitFailure(
  db: Db,
  ctx: { companyId: string; runId: string; now?: Date },
): Promise<RunRateLimitFailure | null> {
  const now = ctx.now ?? new Date();
  const [latest] = await db
    .select({
      httpStatus: usageRequestLogs.httpStatus,
      model: usageRequestLogs.model,
      metadata: usageRequestLogs.metadata,
    })
    .from(usageRequestLogs)
    .where(and(
      eq(usageRequestLogs.companyId, ctx.companyId),
      eq(usageRequestLogs.runId, ctx.runId),
      sql`(${usageRequestLogs.app} is null or ${usageRequestLogs.app} <> 'key_pool_probe')`,
    ))
    .orderBy(desc(usageRequestLogs.occurredAt), desc(usageRequestLogs.id))
    .limit(1);
  if (!latest || latest.httpStatus !== 429) return null;
  const keySlot = typeof latest.metadata?.keySlot === "number" ? latest.metadata.keySlot : null;
  const connectionId = typeof latest.metadata?.connectionId === "string" ? latest.metadata.connectionId : null;
  const model = cooldownModelKey(latest.model);
  const snapshot: KeyPoolFailureSnapshot = { reason: "rate_limited" };
  if (connectionId) snapshot.connectionId = connectionId;
  if (model) snapshot.model = model;
  if (keySlot !== null) snapshot.slot = keySlot;
  if (keySlot !== null && connectionId && model) {
    const [cooldown] = await db
      .select()
      .from(credentialPoolCooldowns)
      .where(and(
        eq(credentialPoolCooldowns.companyId, ctx.companyId),
        eq(credentialPoolCooldowns.connectionId, connectionId),
        eq(credentialPoolCooldowns.slot, keySlot),
        eq(credentialPoolCooldowns.model, model),
      ))
      .limit(1);
    if (cooldown && slotCooldownActive(cooldown, now)) {
      // slotCooldownActive guarantees a non-healthy state; keep the assignment
      // honest for the compiler anyway.
      snapshot.state = cooldown.state === "healthy" ? null : cooldown.state;
      snapshot.cooldownUntil = cooldown.cooldownUntil?.toISOString() ?? null;
    }
  }
  return { errorCode: "provider_rate_limited", snapshot };
}

/**
 * The interruption projection's pool snapshot for a failed run (ticket 05):
 * live pool state for the run's recorded failure, falling back to the
 * snapshot persisted on the run at terminal time. `persisted` is the run's
 * `resultJson.keyPoolFailure`.
 */
export async function runKeyPoolFailureSnapshot(
  db: Db,
  ctx: { companyId: string; runId: string; errorCode: string | null; persisted: unknown; now?: Date },
): Promise<KeyPoolFailureSnapshot | null> {
  const now = ctx.now ?? new Date();
  const persisted = readKeyPoolFailureSnapshot(ctx.persisted);
  if (ctx.errorCode === "provider_rate_limited") {
    const live = await classifyRunRateLimitFailure(db, { companyId: ctx.companyId, runId: ctx.runId, now });
    if (live) return live.snapshot;
    return persisted?.reason === "rate_limited" ? persisted : { reason: "rate_limited" };
  }
  if (ctx.errorCode === "provider_key_pool_exhausted") {
    if (persisted?.reason !== "pool_exhausted") return persisted;
    if (!persisted.connectionId) return persisted;
    const rows = await db
      .select()
      .from(credentialPool)
      .where(and(eq(credentialPool.companyId, ctx.companyId), eq(credentialPool.connectionId, persisted.connectionId)))
      .orderBy(asc(credentialPool.slot));
    if (!rows.length) return persisted;
    const modelKey = cooldownModelKey(persisted.model);
    const cooldowns = modelKey
      ? await db
        .select()
        .from(credentialPoolCooldowns)
        .where(and(
          eq(credentialPoolCooldowns.companyId, ctx.companyId),
          eq(credentialPoolCooldowns.connectionId, persisted.connectionId),
          eq(credentialPoolCooldowns.model, modelKey),
        ))
      : [];
    const cooldownBySlot = new Map(cooldowns.map((row) => [row.slot, row]));
    const agentNames = await poolLeaseAgentNames(db, ctx.companyId, rows.map((row) => row.leaseAgentId));
    return {
      reason: "pool_exhausted",
      connectionId: persisted.connectionId,
      ...(persisted.model ? { model: persisted.model } : {}),
      slots: poolSlotFailureViews(rows, cooldownBySlot, now, agentNames),
    };
  }
  return null;
}

/** Display cooldown of one slot, derived from its (slot, model) cooldown rows:
 * the most severe active cooldown wins (daily over rpm), ties go to the
 * earliest deadline. No active cooldown displays as healthy. */
function deriveSlotCooldown(
  cooldownRows: PoolCooldownRow[],
  slot: number,
  now: Date,
): { state: CredentialPoolSlotState; cooldownUntil: string | null; cooldownReason: string | null } {
  const active = cooldownRows
    .filter((row) => row.slot === slot && slotCooldownActive(row, now))
    .sort((a, b) => rankCooldownState(b.state) - rankCooldownState(a.state)
      || (a.cooldownUntil?.getTime() ?? 0) - (b.cooldownUntil?.getTime() ?? 0)
      || a.model.localeCompare(b.model));
  const cooldown = active[0];
  return cooldown
    ? { state: cooldown.state, cooldownUntil: cooldown.cooldownUntil?.toISOString() ?? null, cooldownReason: cooldown.cooldownReason }
    : { state: "healthy", cooldownUntil: null, cooldownReason: null };
}

function rankCooldownState(state: CredentialPoolSlotState): number {
  return state === "daily_cooldown" ? 2 : state === "rpm_cooldown" ? 1 : 0;
}

function slotView(row: typeof credentialPool.$inferSelect, cooldownRows: PoolCooldownRow[], now: Date): AiConnectionKeySlot {
  const cooldown = deriveSlotCooldown(cooldownRows, row.slot, now);
  return {
    id: row.id,
    slot: row.slot,
    label: row.label,
    enabled: row.enabled,
    state: cooldown.state,
    cooldownUntil: cooldown.cooldownUntil,
    cooldownReason: cooldown.cooldownReason,
    activeRunId: row.activeRunId,
    leaseExpiresAt: row.leaseExpiresAt?.toISOString() ?? null,
    leaseAgentId: row.leaseAgentId,
    lastAssignedAgentId: row.lastAssignedAgentId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function aiCredentialPoolService(db: Db) {
  /** The secret name is unique per company, so a slot that was re-created after
   * an earlier removal (or whose old secret survived a failed cleanup) never
   * collides with a previous generation. */
  const slotSecretName = (connectionId: string, slot: number) =>
    `ai-pool-${connectionId.slice(0, 8)}-slot-${slot}-${randomUUID().slice(0, 8)}`;

  /** Bindings live under the connection's tool_connection target. They are
   * recreated wholesale by syncConnectionCredentialBindings on reconnects and
   * metadata edits (which reads this table), so here they only need to track
   * the slot's current secret. */
  const bindSlotSecret = async (
    tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
    companyId: string,
    connectionId: string,
    slot: number,
    secretId: string,
  ) => {
    const configPath = credentialPoolSlotConfigPath(slot);
    await tx
      .insert(companySecretBindings)
      .values({
        companyId,
        secretId,
        targetType: "tool_connection",
        targetId: connectionId,
        configPath,
        required: true,
        projectionClass: "unclassified",
      })
      .onConflictDoUpdate({
        target: [
          companySecretBindings.companyId,
          companySecretBindings.targetType,
          companySecretBindings.targetId,
          companySecretBindings.configPath,
        ],
        set: { secretId, updatedAt: new Date() },
      });
  };

  async function connectionRow(companyId: string, connectionId: string) {
    const [connection] = await db
      .select()
      .from(toolConnections)
      .where(
        and(
          eq(toolConnections.companyId, companyId),
          eq(toolConnections.id, connectionId),
          eq(toolConnections.connectionPurpose, "ai"),
        ),
      );
    if (!connection) throw notFound("AI connection not found");
    return connection;
  }

  async function slotRow(companyId: string, connectionId: string, slot: number) {
    const [row] = await db
      .select()
      .from(credentialPool)
      .where(
        and(
          eq(credentialPool.companyId, companyId),
          eq(credentialPool.connectionId, connectionId),
          eq(credentialPool.slot, slot),
        ),
      );
    if (!row) throw notFound("Key slot not found");
    return row;
  }

  /** Cooldown rows of the connection feed the per-slot display state. */
  const cooldownRows = async (connectionId: string) =>
    db
      .select()
      .from(credentialPoolCooldowns)
      .where(eq(credentialPoolCooldowns.connectionId, connectionId));

  async function listSlots(companyId: string, connectionId: string): Promise<AiConnectionKeySlotList> {
    await connectionRow(companyId, connectionId);
    const now = new Date();
    const rows = await db
      .select()
      .from(credentialPool)
      .where(and(eq(credentialPool.companyId, companyId), eq(credentialPool.connectionId, connectionId)))
      .orderBy(asc(credentialPool.slot));
    const cooldowns = await cooldownRows(connectionId);
    return { connectionId, slots: rows.map((row) => slotView(row, cooldowns, now)) };
  }

  async function addSlot(companyId: string, connectionId: string, input: AiConnectionKeySlotCreate, actor: PoolSlotActor) {
    await connectionRow(companyId, connectionId);
    const existing = await db
      .select({ id: credentialPool.id })
      .from(credentialPool)
      .where(and(eq(credentialPool.companyId, companyId), eq(credentialPool.connectionId, connectionId), eq(credentialPool.slot, input.slot)));
    if (existing.length) throw conflict(`Key slot ${input.slot} already exists for this connection`);
    try {
      return await db.transaction(async (tx) => {
        const secret = await secretService(tx).create(
          companyId,
          { name: slotSecretName(connectionId, input.slot), provider: "local_encrypted", value: input.keyValue },
          { userId: actor.actorType === "user" ? actor.actorId : null },
        );
        const [row] = await tx
          .insert(credentialPool)
          .values({ companyId, connectionId, slot: input.slot, label: input.label ?? null, secretRef: secret.id })
          .returning();
        await bindSlotSecret(tx, companyId, connectionId, input.slot, secret.id);
        await logActivity(tx as unknown as Db, {
          companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          action: "ai_connection.key_slot_added",
          entityType: "tool_connection",
          entityId: connectionId,
          details: { slot: input.slot, secretId: secret.id },
        });
        return slotView(row!, [], new Date());
      });
    } catch (error) {
      // A concurrent add for the same slot loses the unique constraint race.
      if ((error as { cause?: { code?: string } })?.cause?.code === "23505")
        throw conflict(`Key slot ${input.slot} already exists for this connection`);
      throw error;
    }
  }

  async function updateSlot(companyId: string, connectionId: string, input: AiConnectionKeySlotUpdate, actor: PoolSlotActor) {
    await connectionRow(companyId, connectionId);
    let replacedSecretRef: string | null = null;
    const updated = await db.transaction(async (tx) => {
      const row = await slotRow(companyId, connectionId, input.slot);
      const patch: Partial<typeof credentialPool.$inferInsert> = { updatedAt: new Date() };
      if (input.label !== undefined) patch.label = input.label;
      if (input.enabled !== undefined) patch.enabled = input.enabled;
      if (input.keyValue !== undefined) {
        // Replacing a key writes a fresh company secret and repoints the slot,
        // so the previous encrypted generation stays intact for audit.
        const secret = await secretService(tx).create(
          companyId,
          { name: slotSecretName(connectionId, input.slot), provider: "local_encrypted", value: input.keyValue },
          { userId: actor.actorType === "user" ? actor.actorId : null },
        );
        patch.secretRef = secret.id;
        replacedSecretRef = row.secretRef;
      }
      const [next] = await tx
        .update(credentialPool)
        .set(patch)
        .where(eq(credentialPool.id, row.id))
        .returning();
      if (input.keyValue !== undefined) {
        // A new key is a new account with fresh quota: its (slot, model)
        // cooldown rows describe the previous key and are discarded.
        await tx.delete(credentialPoolCooldowns).where(and(
          eq(credentialPoolCooldowns.companyId, companyId),
          eq(credentialPoolCooldowns.connectionId, connectionId),
          eq(credentialPoolCooldowns.slot, input.slot),
        ));
        await bindSlotSecret(tx, companyId, connectionId, input.slot, patch.secretRef!);
      }
      await logActivity(tx as unknown as Db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: "ai_connection.key_slot_updated",
        entityType: "tool_connection",
        entityId: connectionId,
        details: {
          slot: input.slot,
          ...(input.label !== undefined ? { label: input.label } : {}),
          ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
          keyRotated: input.keyValue !== undefined,
        },
      });
      return slotView(next!, await cooldownRows(connectionId), new Date());
    });
    if (replacedSecretRef) {
      await secretService(db)
        .remove(replacedSecretRef)
        .catch((error) => logger.warn({ err: error, companyId, connectionId }, "Replaced pool key secret cleanup pending"));
    }
    return updated;
  }

  async function removeSlot(companyId: string, connectionId: string, slot: number, actor: PoolSlotActor) {
    await connectionRow(companyId, connectionId);
    let removedSecretRef: string | null = null;
    await db.transaction(async (tx) => {
      const row = await slotRow(companyId, connectionId, slot);
      if (row.activeRunId) throw conflict("Key slot is in use by an active run");
      removedSecretRef = row.secretRef;
      await tx.delete(credentialPool).where(eq(credentialPool.id, row.id));
      // The slot's (slot, model) cooldowns belong to its removed key.
      await tx.delete(credentialPoolCooldowns).where(and(
        eq(credentialPoolCooldowns.companyId, companyId),
        eq(credentialPoolCooldowns.connectionId, connectionId),
        eq(credentialPoolCooldowns.slot, slot),
      ));
      await tx.delete(companySecretBindings).where(and(
        eq(companySecretBindings.companyId, companyId),
        eq(companySecretBindings.targetType, "tool_connection"),
        eq(companySecretBindings.targetId, connectionId),
        eq(companySecretBindings.configPath, credentialPoolSlotConfigPath(slot)),
      ));
      await logActivity(tx as unknown as Db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: "ai_connection.key_slot_removed",
        entityType: "tool_connection",
        entityId: connectionId,
        details: { slot },
      });
    });
    if (removedSecretRef) {
      await secretService(db)
        .remove(removedSecretRef)
        .catch((error) => logger.warn({ err: error, companyId, connectionId }, "Removed pool key secret cleanup pending"));
    }
  }

  return { listSlots, addSlot, updateSlot, removeSlot };
}
