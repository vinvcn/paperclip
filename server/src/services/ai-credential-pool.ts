import { and, asc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type {
  AiConnectionKeySlot,
  AiConnectionKeySlotCreate,
  AiConnectionKeySlotList,
  AiConnectionKeySlotUpdate,
} from "@paperclipai/shared";
import { type Db, companySecretBindings, companySecrets, credentialPool, toolConnections } from "@paperclipai/db";
import { conflict, notFound, unprocessable } from "../errors.js";
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

/**
 * Ticket-01 assignment rule: the lowest enabled healthy slot, in deterministic
 * slot order. Ticket 02 replaces this function with the full matrix
 * (pin → sticky → exclusive lease → fast-fail); its callers and the
 * "no assignable slot → fall through to the single credential" contract are
 * the stable seam.
 */
export async function selectAssignablePoolSlot(
  db: Db,
  companyId: string,
  connectionId: string,
): Promise<AssignablePoolSlot | null> {
  const [slot] = await db
    .select({ id: credentialPool.id, slot: credentialPool.slot, label: credentialPool.label, secretRef: credentialPool.secretRef })
    .from(credentialPool)
    .where(
      and(
        eq(credentialPool.companyId, companyId),
        eq(credentialPool.connectionId, connectionId),
        eq(credentialPool.enabled, true),
        eq(credentialPool.state, "healthy"),
      ),
    )
    .orderBy(asc(credentialPool.slot))
    .limit(1);
  return slot ?? null;
}

/** Resolves the pooled key value through the same encrypted company-secret path as the grant credential. */
export async function resolvePoolSlotValue(
  db: Db,
  companyId: string,
  connectionId: string,
  slot: AssignablePoolSlot,
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
  });
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
