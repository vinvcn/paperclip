import { and, asc, eq, isNull, lt, or } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type {
  AiConnectionKeySlot,
  AiConnectionKeySlotCreate,
  AiConnectionKeySlotList,
  AiConnectionKeySlotUpdate,
} from "@paperclipai/shared";
import { type Db, companySecretBindings, companySecrets, credentialPool, toolConnections } from "@paperclipai/db";
import { conflict, notFound, unprocessable, HttpError } from "../errors.js";
import { logActivity } from "./activity-log.js";
import { secretService } from "./secrets.js";
import { logger } from "../middleware/logger.js";
import { credentialPoolSlotConfigPath } from "./connection-credential-bindings.js";

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
}

/**
 * Crashed runs never reach their terminal lease release, so their slot is
 * reclaimed by this TTL instead. It must comfortably exceed any ordinary run
 * (the terminal release is the normal path; an expired lease merely admits the
 * next run once the deadline passes).
 */
export const POOL_LEASE_TTL_MS = 2 * 60 * 60 * 1000 + 5 * 60 * 1000;

const poolLeaseActor = { actorType: "system" as const, actorId: "key_pool" };

type PoolSlotRow = typeof credentialPool.$inferSelect;

function mostStaleFirst(a: PoolSlotRow, b: PoolSlotRow) {
  const aAt = a.lastAssignedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  const bAt = b.lastAssignedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  return aAt - bAt || a.slot - b.slot;
}

function poolExhaustedError(rows: PoolSlotRow[]): HttpError {
  // Snapshot for the operator: who occupies each slot and when it recovers
  // (lease expiry or cooldown end). Never a key value.
  const summary = rows.map((row) => {
    const parts = [`slot ${row.slot}: ${row.enabled ? row.state : "disabled"}`];
    if (row.activeRunId) {
      parts.push(`leased by run ${row.activeRunId}${row.leaseAgentId ? ` (agent ${row.leaseAgentId})` : ""}${row.leaseExpiresAt ? ` until ${row.leaseExpiresAt.toISOString()}` : ""}`);
    } else if (row.state !== "healthy" && row.cooldownUntil) {
      parts.push(`cooldown until ${row.cooldownUntil.toISOString()}`);
    }
    return parts.join(", ");
  }).join("; ");
  return unprocessable(`No key slot of this connection's pool is available (${summary})`, {
    code: "provider_key_pool_exhausted",
  });
}

/**
 * Ticket-02 assignment matrix: pin → sticky (cache affinity) → exclusive lease
 * (least recently used) → fast-fail. Callers and the fall-through contract:
 * a connection with no pool, or with zero enabled slots, returns null so the
 * original single-credential path serves the request unchanged; a pool with
 * enabled slots that cannot serve throws `provider_key_pool_exhausted` with a
 * pool snapshot. Without a lease context the matrix only selects — no lease or
 * stickiness writes.
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
  if (!runId) {
    // Ephemeral selection for a resolution outside a run: pin, then sticky,
    // then least-recently-used — no lease is taken and stickiness stays put.
    const pinned = lease?.pinnedSlot != null ? enabled.find((row) => row.slot === lease.pinnedSlot) : undefined;
    const healthy = enabled.filter((row) => row.state === "healthy");
    const sticky = lease?.agentId
      ? [...healthy].sort((a, b) => (b.lastAssignedAt?.getTime() ?? 0) - (a.lastAssignedAt?.getTime() ?? 0))
        .find((row) => row.lastAssignedAgentId === lease.agentId)
      : undefined;
    const chosen = pinned ?? sticky ?? [...healthy].sort(mostStaleFirst)[0];
    if (!chosen) throw poolExhaustedError(rows);
    return { id: chosen.id, slot: chosen.slot, label: chosen.label, secretRef: chosen.secretRef };
  }
  const agentId = lease?.agentId ?? null;
  const now = new Date();
  // A lease is taken (or refreshed) by a conditional UPDATE that re-checks
  // every eligibility criterion atomically — two runs can never hold the same
  // slot because the second UPDATE re-reads the committed row and matches
  // nothing (exclusive-lease cap of 1 active run per slot).
  const takeLease = async (slotId: string) => {
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
          or(
            isNull(credentialPool.activeRunId),
            eq(credentialPool.activeRunId, runId),
            lt(credentialPool.leaseExpiresAt, now),
          ),
        ),
      )
      .returning();
    return row ?? null;
  };
  const logLease = (slot: number, pinned: boolean, expiresAt: Date) =>
    logActivity(db, {
      companyId,
      ...poolLeaseActor,
      action: "ai_connection.key_slot_leased",
      entityType: "tool_connection",
      entityId: connectionId,
      runId,
      agentId,
      details: { slot, pinned, leaseExpiresAt: expiresAt.toISOString() },
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
    // lease of another run.
    if (pinned.state !== "healthy") {
      await logActivity(db, {
        companyId,
        ...poolLeaseActor,
        action: "ai_connection.key_slot_pin_cooldown",
        entityType: "tool_connection",
        entityId: connectionId,
        runId,
        agentId,
        details: { slot: pinned.slot, state: pinned.state, cooldownUntil: pinned.cooldownUntil?.toISOString() ?? null },
      }).catch((error) => logger.warn({ err: error, companyId, connectionId, runId }, "Pinned cooldown slot activity log pending"));
      logger.warn({ companyId, connectionId, runId, slot: pinned.slot, state: pinned.state },
        "Pinned key slot is in cooldown and will be used anyway");
    }
    const taken = await takeLease(pinned.id);
    if (taken) {
      await logLease(taken.slot, true, taken.leaseExpiresAt!);
      return { id: taken.id, slot: taken.slot, label: taken.label, secretRef: taken.secretRef };
    }
    throw poolExhaustedError(await db
      .select()
      .from(credentialPool)
      .where(and(eq(credentialPool.companyId, companyId), eq(credentialPool.connectionId, connectionId)))
      .orderBy(asc(credentialPool.slot)));
  }
  // Sticky: the agent's last slot keeps its prompt cache (key = account) while
  // it is healthy and free. A slot leased by this same run still counts — a
  // credential re-resolution inside one run must land on the same slot.
  if (agentId) {
    const sticky = [...enabled]
      .filter((row) => row.state === "healthy" && row.lastAssignedAgentId === agentId)
      .sort((a, b) => (b.lastAssignedAt?.getTime() ?? Number.NEGATIVE_INFINITY) - (a.lastAssignedAt?.getTime() ?? Number.NEGATIVE_INFINITY) || a.slot - b.slot);
    for (const candidate of sticky) {
      const taken = await takeLease(candidate.id);
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
    .filter((row) => row.state === "healthy" && (!row.activeRunId || row.activeRunId === runId
      || (row.leaseExpiresAt !== null && row.leaseExpiresAt < now)))
    .sort(mostStaleFirst);
  for (const candidate of free) {
    const taken = await takeLease(candidate.id);
    if (taken) {
      await logLease(taken.slot, false, taken.leaseExpiresAt!);
      return { id: taken.id, slot: taken.slot, label: taken.label, secretRef: taken.secretRef };
    }
  }
  throw poolExhaustedError(await db
    .select()
    .from(credentialPool)
    .where(and(eq(credentialPool.companyId, companyId), eq(credentialPool.connectionId, connectionId)))
    .orderBy(asc(credentialPool.slot)));
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

function slotView(row: typeof credentialPool.$inferSelect): AiConnectionKeySlot {
  return {
    id: row.id,
    slot: row.slot,
    label: row.label,
    enabled: row.enabled,
    state: row.state,
    cooldownUntil: row.cooldownUntil?.toISOString() ?? null,
    cooldownReason: row.cooldownReason,
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

  async function listSlots(companyId: string, connectionId: string): Promise<AiConnectionKeySlotList> {
    await connectionRow(companyId, connectionId);
    const rows = await db
      .select()
      .from(credentialPool)
      .where(and(eq(credentialPool.companyId, companyId), eq(credentialPool.connectionId, connectionId)))
      .orderBy(asc(credentialPool.slot));
    return { connectionId, slots: rows.map(slotView) };
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
        return slotView(row!);
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
      if (input.keyValue !== undefined) await bindSlotSecret(tx, companyId, connectionId, input.slot, patch.secretRef!);
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
      return slotView(next!);
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
