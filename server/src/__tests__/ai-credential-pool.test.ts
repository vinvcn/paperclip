// Key pool foundation (ticket 01): credential_pool table, pool-backed
// runtimeCredential resolution, slot CRUD API. Real keys never appear here;
// every credential in this file is a fixture value.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, desc, eq } from "drizzle-orm";
import {
  agents,
  companies,
  companyMemberships,
  connectionGrants,
  createDb,
  credentialPool,
  credentialPoolCooldowns,
  companySecrets,
  companySecretVersions,
  heartbeatRuns,
  toolConnections,
  usageRequestLogs,
  type Db,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "@paperclipai/db/test-embedded-postgres";
import { aiConnectionService } from "../services/ai-connections.js";
import {
  PROBE_DEFER_MS,
  classifyKeySlot429,
  nextCooldownProbeDeadline,
  releaseRunPoolLease,
  takePoolSlotLease,
} from "../services/ai-credential-pool.js";
import { probeDueSlotCooldowns } from "../services/key-pool-cooldown-work.js";
import { secretService } from "../services/secrets.js";
import { prepareManagedAiRuntime } from "../services/ai-connection-runtime.js";
import { credentialPoolSlotConfigPath, syncConnectionCredentialBindings } from "../services/connection-credential-bindings.js";
import { activityLog, secretAccessEvents } from "@paperclipai/db";
import express from "express";
import request from "supertest";
import { aiConnectionRoutes } from "../routes/ai-connections.js";

let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
let home: string;
const companyId = randomUUID();
const userId = "keypool-owner";

beforeAll(async () => {
  home = await realpath(await mkdtemp(path.join(os.tmpdir(), "paperclip-keypool-tests-")));
  vi.stubEnv("PAPERCLIP_HOME", home);
  vi.stubEnv("PAPERCLIP_INSTANCE_ID", "ai-credential-pool-fixture");
  database = await startEmbeddedPostgresTestDatabase("paperclip-keypool-db-");
  db = createDb(database.connectionString);
  await db.insert(companies).values({ id: companyId, name: "Key pool tests", issuePrefix: "KPT" });
  await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "member" });
}, 90000);
afterAll(async () => { await database?.cleanup(); vi.unstubAllEnvs(); if (home) await rm(home, { recursive: true, force: true }); });

/** A gateway connection like the NVIDIA NIM preset: OpenAI-compatible custom
 * HTTPS base URL + a bearer key (the wizard's "Chat Completions API" preset). */
async function createGatewayConnectionForUser(owner: string, name: string, key: string) {
  const service = aiConnectionService(db);
  return service.save(companyId, owner, {
    provider: "openai", method: "api_key", ownership: "shared", name,
    apiKey: key, agentIds: [], allAgents: true,
    routing: { kind: "gateway", protocol: "chat", baseUrl: "https://integrate.api.nvidia.example/v1", auth: "bearer", models: [] },
  } as never, key);
}

/** NIM-style upstream model ids. Usage rows record the full routed model
 * string the runner's capture sink saw — `paperclip/<model>` for managed
 * gateway traffic (review F1: production 429 rows are 24/24 prefixed, bare
 * ids match nothing) — so usage fixtures insert the prefixed form, while
 * cooldown rows keep this bare id (the probe addresses the gateway with the
 * bare upstream body model). */
const MODEL_A = "meta/llama-3.3-70b-instruct";
const MODEL_B = "meta/qwen3-coder-480b";

/** Insert one (slot, model) cooldown row — the ticket-03 cooldown store. */
const coolSlot = async (
  connectionId: string,
  slot: number,
  model: string,
  state: "rpm_cooldown" | "daily_cooldown",
  cooldownUntil: Date | null,
  reason = state === "rpm_cooldown" ? "rpm" : "daily",
) => {
  await db.insert(credentialPoolCooldowns).values({
    companyId, connectionId, slot, model, state, cooldownUntil, cooldownReason: reason,
  }).onConflictDoUpdate({
    target: [credentialPoolCooldowns.companyId, credentialPoolCooldowns.connectionId, credentialPoolCooldowns.slot, credentialPoolCooldowns.model],
    set: { state, cooldownUntil, cooldownReason: reason, updatedAt: new Date() },
  });
};

describe("credential_pool schema", () => {
  it("stores pool slots for an AI connection and enforces the unique slot constraint", async () => {
    const account = await createGatewayConnectionForUser(userId, "NIM gateway", "fixture-connection-key");
    const [secret, secret2] = await Promise.all([
      secretService(db).create(companyId, { name: `ai-pool-fixture-slot-1`, provider: "local_encrypted", value: "fixture-nvapi-key-1" }, { userId }),
      secretService(db).create(companyId, { name: `ai-pool-fixture-slot-2`, provider: "local_encrypted", value: "fixture-nvapi-key-2" }, { userId }),
    ]);
    await db.insert(credentialPool).values([
      { companyId, connectionId: account.connectionId, slot: 1, label: "primary", secretRef: secret.id },
      { companyId, connectionId: account.connectionId, slot: 2, secretRef: secret2.id },
    ]);
    const slots = await db.select().from(credentialPool).where(and(eq(credentialPool.companyId, companyId), eq(credentialPool.connectionId, account.connectionId)));
    expect(slots.map((row) => row.slot).sort()).toEqual([1, 2]);
    expect(slots.every((row) => row.state === "healthy" && row.enabled && row.activeRunId === null)).toBe(true);
    // (companyId, connectionId, slot) is unique.
    await expect(db.insert(credentialPool).values({ companyId, connectionId: account.connectionId, slot: 1, secretRef: secret2.id })).rejects.toMatchObject({ cause: { code: "23505" } });
    // The slot FK points at the AI connection entity.
    await expect(db.insert(credentialPool).values({ companyId, connectionId: randomUUID(), slot: 3, secretRef: secret.id })).rejects.toMatchObject({ cause: { code: "23503" } });
    // Only the three ticket states are legal.
    await expect(db.insert(credentialPool).values({ companyId, connectionId: account.connectionId, slot: 4, secretRef: secret.id, state: "retired" as never })).rejects.toMatchObject({ cause: { code: "23514" } });
    await expect(db.insert(credentialPool).values({ companyId, connectionId: account.connectionId, slot: 0, secretRef: secret.id })).rejects.toMatchObject({ cause: { code: "23514" } });
  });

  it("keeps the pool key encrypted at rest (ciphertext never equals the plaintext)", async () => {
    const plaintext = "fixture-nvapi-key-1";
    const [secret] = await db.select().from(companySecrets).where(and(eq(companySecrets.companyId, companyId), eq(companySecrets.name, "ai-pool-fixture-slot-1")));
    expect(secret).toBeDefined();
    const [version] = await db.select().from(companySecretVersions).where(eq(companySecretVersions.secretId, secret!.id)).orderBy(companySecretVersions.version);
    expect(version).toBeDefined();
    const stored = JSON.stringify(version?.material ?? version ?? {});
    expect(stored).not.toContain(plaintext);
  });
});

describe("runtimeCredential pool assignment", () => {
  it("resolves a pooled connection's key from its lowest healthy slot and falls back when the pool cannot serve", async () => {
    const owner = "keypool-runtime-user";
    await db.insert(companyMemberships).values({ companyId, principalId: owner, principalType: "user", status: "active", membershipRole: "member" });
    const service = aiConnectionService(db);
    const connectionKey = "fixture-connection-single-key";
    const account = await createGatewayConnectionForUser(owner, "Pooled NIM gateway", connectionKey);
    const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, account.connectionId));
    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, account.grantId));
    const row = { connection, grant };

    // No pool: the original single-credential path is untouched.
    await expect(service.runtimeCredential(row)).resolves.toMatchObject({ value: connectionKey, keySlot: null });

    // Pool with slots 2 and 1 (inserted out of order): selection is slot-ascending
    // for an untouched pool (no lease context → selection only, no lease writes).
    const slotSecrets = new Map<number, string>();
    for (const [slot, value] of [[2, "fixture-nvapi-key-b"], [1, "fixture-nvapi-key-a"]] as const) {
      const secret = await secretService(db).create(companyId, { name: `ai-pool-runtime-${account.connectionId.slice(0, 8)}-slot-${slot}`, provider: "local_encrypted", value }, { userId });
      await db.insert(credentialPool).values({ companyId, connectionId: account.connectionId, slot, secretRef: secret.id });
      slotSecrets.set(slot, value);
    }
    // Directly inserted rows still resolve after the connection's binding sync
    // (reconnects and metadata edits recreate pool slot bindings from this path).
    await syncConnectionCredentialBindings(db, connection);
    await expect(service.runtimeCredential(row)).resolves.toMatchObject({ value: slotSecrets.get(1), keySlot: 1 });

    // Disabling the selected slot moves selection to the next enabled slot.
    await db.update(credentialPool).set({ enabled: false }).where(and(eq(credentialPool.companyId, companyId), eq(credentialPool.connectionId, account.connectionId), eq(credentialPool.slot, 1)));
    await expect(service.runtimeCredential(row)).resolves.toMatchObject({ value: slotSecrets.get(2), keySlot: 2 });

    // Zero enabled slots: the pool is switched off, so the connection's own
    // credential serves again (ticket-01 fall-through, kept by ticket 02).
    await db.update(credentialPool).set({ enabled: false }).where(and(eq(credentialPool.companyId, companyId), eq(credentialPool.connectionId, account.connectionId), eq(credentialPool.slot, 2)));
    await expect(service.runtimeCredential(row)).resolves.toMatchObject({ value: connectionKey, keySlot: null });
  });

  it("fast-fails provider_key_pool_exhausted when enabled slots exist but none can serve", async () => {
    const owner = "keypool-exhausted-user";
    await db.insert(companyMemberships).values({ companyId, principalId: owner, principalType: "user", status: "active", membershipRole: "member" });
    const service = aiConnectionService(db);
    const connectionKey = "fixture-connection-exhausted-key";
    const account = await createGatewayConnectionForUser(owner, "Exhausted NIM gateway", connectionKey);
    const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, account.connectionId));
    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, account.grantId));
    const row = { connection, grant };
    const [agent] = await db.insert(agents).values({ companyId, name: "Exhausted holder" }).returning({ id: agents.id });
    const [runRow] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent!.id }).returning({ id: heartbeatRuns.id });
    const slotSecret = await secretService(db).create(companyId, { name: `ai-pool-exhausted-${account.connectionId.slice(0, 8)}-slot-1`, provider: "local_encrypted", value: "fixture-nvapi-key-exhausted" }, { userId });
    await db.insert(credentialPool).values({ companyId, connectionId: account.connectionId, slot: 1, secretRef: slotSecret.id });
    const poolScope = and(eq(credentialPool.companyId, companyId), eq(credentialPool.connectionId, account.connectionId));
    // The only enabled slot is in cooldown for the target model: the matrix
    // fails fast instead of silently falling back to the single credential
    // (ticket-01 contract change, re-judged per model since ticket 03).
    await coolSlot(account.connectionId, 1, MODEL_A, "daily_cooldown", new Date(Date.now() + 3_600_000));
    await expect(service.runtimeCredential(row, { pool: { model: MODEL_A } })).rejects.toMatchObject({ details: { code: "provider_key_pool_exhausted" } });
    await expect(service.runtimeCredential(row, { pool: { model: MODEL_A } })).rejects.toThrow(/slot 1: daily_cooldown, cooldown until/);
    // Re-enabled but leased by another run's exclusive lease: a run-scoped
    // resolution fast-fails with the occupancy snapshot. (A resolution without
    // a run selects read-only and ignores occupancy by design.)
    const [holderAgent] = await db.insert(agents).values({ companyId, name: "Exhausted lease holder" }).returning({ id: agents.id });
    const [holderRun] = await db.insert(heartbeatRuns).values({ companyId, agentId: holderAgent!.id }).returning({ id: heartbeatRuns.id });
    const [callerAgent] = await db.insert(agents).values({ companyId, name: "Exhausted caller" }).returning({ id: agents.id });
    const [callerRun] = await db.insert(heartbeatRuns).values({ companyId, agentId: callerAgent!.id }).returning({ id: heartbeatRuns.id });
    await db.update(credentialPool).set({ state: "healthy", cooldownUntil: null, cooldownReason: null }).where(poolScope);
    await db.delete(credentialPoolCooldowns).where(and(eq(credentialPoolCooldowns.companyId, companyId), eq(credentialPoolCooldowns.connectionId, account.connectionId)));
    await db.update(credentialPool).set({ activeRunId: holderRun!.id, leaseExpiresAt: new Date(Date.now() + 600_000), leaseAgentId: holderAgent!.id }).where(poolScope);
    await expect(service.runtimeCredential(row, { pool: { heartbeatRunId: callerRun!.id, agentId: callerAgent!.id, model: MODEL_A } })).rejects.toThrow(new RegExp(`slot 1: healthy, leased by run ${holderRun!.id} \\(agent ${holderAgent!.id}\\) until`));
    await expect(service.runtimeCredential(row, { pool: { heartbeatRunId: callerRun!.id, agentId: callerAgent!.id, model: MODEL_A } })).rejects.toMatchObject({ details: { code: "provider_key_pool_exhausted" } });
  });

  it("projects the pool-resolved key into the existing managed routing projection", async () => {
    const owner = "keypool-projection-user";
    await db.insert(companyMemberships).values({ companyId, principalId: owner, principalType: "user", status: "active", membershipRole: "member" });
    const service = aiConnectionService(db);
    const account = await service.save(companyId, owner, {
      provider: "openai", method: "api_key", ownership: "shared", name: "Projected NIM gateway",
      apiKey: "fixture-connection-projected", agentIds: [], allAgents: true,
      routing: { kind: "gateway", protocol: "chat", baseUrl: "https://integrate.api.nvidia.example/v1", auth: "bearer", models: [{ id: "meta/llama-3.3-70b-instruct" }] },
    } as never, "fixture-connection-projected");
    const pooledKey = "fixture-nvapi-key-projected";
    const secret = await secretService(db).create(companyId, { name: `ai-pool-projected-slot-1`, provider: "local_encrypted", value: pooledKey }, { userId });
    await db.insert(credentialPool).values({ companyId, connectionId: account.connectionId, slot: 1, secretRef: secret.id });
    const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, account.connectionId));
    await syncConnectionCredentialBindings(db, connection);
    const runtime = await prepareManagedAiRuntime(db, {
      companyId, agentId: randomUUID(), responsibleUserId: owner, adapterType: "paperclip_runner",
      binding: { provider: "openai", method: "api_key", mode: "shared", connectionId: account.connectionId, grantId: account.grantId },
      config: { provider: "opencode", model: "paperclip/meta/llama-3.3-70b-instruct" },
    });
    try {
      const env = runtime.config.env as Record<string, string>;
      expect(env.PAPERCLIP_AI_PROVIDER_KEY).toBe(pooledKey);
      expect(env.PAPERCLIP_AI_PROVIDER_URL).toBe("https://integrate.api.nvidia.example/v1");
      expect(env.PAPERCLIP_AI_PROVIDER_KEY).not.toContain("fixture-connection-projected");
      // The selected slot travels with the credential for usage attribution.
      expect(env.PAPERCLIP_AI_PROVIDER_KEY_SLOT).toBe("1");
      // The pool's owning connection rides the same channel (ticket 04 review F2).
      expect(env.PAPERCLIP_AI_PROVIDER_CONNECTION_ID).toBe(account.connectionId);
      expect(runtime.keySlot).toBe(1);
      // The warm-session identity binds the slot: a different slot on a later
      // run invalidates the stored session instead of reusing its captured key.
      expect(runtime.sessionIdentity).toContain("pool-slot-1");
    } finally { await runtime.cleanup(); }
  });

  it("attributes pooled key access to the grant's responsible user and the consuming run (ticket-01 review F3)", async () => {
    const owner = "keypool-attributed-user";
    await db.insert(companyMemberships).values({ companyId, principalId: owner, principalType: "user", status: "active", membershipRole: "member" });
    const service = aiConnectionService(db);
    // A personal grant carries the responsible user — the same attribution
    // source the grant credential() path passes as audit context.
    const account = await service.save(companyId, owner, {
      provider: "openai", method: "api_key", ownership: "personal", name: "Attributed NIM gateway",
      apiKey: "fixture-connection-attributed", agentIds: [], allAgents: true,
      routing: { kind: "gateway", protocol: "chat", baseUrl: "https://integrate.api.nvidia.example/v1", auth: "bearer", models: [] },
    } as never, "fixture-connection-attributed");
    const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, account.connectionId));
    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, account.grantId));
    expect(grant).toMatchObject({ kind: "user", subjectUserId: owner });
    const [agent] = await db.insert(agents).values({ companyId, name: "Attributed runner" }).returning({ id: agents.id });
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent!.id }).returning({ id: heartbeatRuns.id });
    const pooledKey = "fixture-nvapi-key-attributed";
    const secret = await secretService(db).create(companyId, { name: "ai-pool-attributed-slot-1", provider: "local_encrypted", value: pooledKey }, { userId: owner });
    await db.insert(credentialPool).values({ companyId, connectionId: account.connectionId, slot: 1, secretRef: secret.id });
    await syncConnectionCredentialBindings(db, connection);
    await expect(service.runtimeCredential({ connection, grant }, { pool: { heartbeatRunId: run!.id, agentId: agent!.id } }))
      .resolves.toMatchObject({ value: pooledKey, keySlot: 1 });
    const [event] = await db.select().from(secretAccessEvents)
      .where(eq(secretAccessEvents.secretId, secret!.id))
      .orderBy(desc(secretAccessEvents.createdAt))
      .limit(1);
    expect(event).toMatchObject({
      responsibleUserId: owner,
      heartbeatRunId: run!.id,
      consumerType: "tool_connection",
      consumerId: account.connectionId,
      configPath: credentialPoolSlotConfigPath(1),
      outcome: "success",
    });
  });
});

describe("key pool assignment matrix (ticket 02)", () => {
  let service: ReturnType<typeof aiConnectionService>;
  let connectionId: string;
  let grantId: string;
  let agentA: string;
  let agentB: string;
  const owner = "keypool-matrix-user";
  const slotKeys = new Map<number, string>([[1, "fixture-nvapi-matrix-1"], [2, "fixture-nvapi-matrix-2"], [3, "fixture-nvapi-matrix-3"]]);

  beforeAll(async () => {
    service = aiConnectionService(db);
    await db.insert(companyMemberships).values({ companyId, principalId: owner, principalType: "user", status: "active", membershipRole: "member" });
    const account = await createGatewayConnectionForUser(owner, "Matrix NIM gateway", "fixture-connection-matrix-key");
    connectionId = account.connectionId;
    grantId = account.grantId;
    for (const [slot, value] of slotKeys) {
      const secret = await secretService(db).create(companyId, { name: `ai-pool-matrix-${connectionId.slice(0, 8)}-slot-${slot}`, provider: "local_encrypted", value }, { userId: owner });
      await db.insert(credentialPool).values({ companyId, connectionId, slot, secretRef: secret.id });
    }
    // Directly inserted slot rows resolve only once their company-secret
    // bindings exist (reconnects and metadata edits recreate them).
    const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, connectionId));
    await syncConnectionCredentialBindings(db, connection);
    const [inserted] = await db.insert(agents).values([
      { companyId, name: "Matrix agent A" },
      { companyId, name: "Matrix agent B" },
    ]).returning({ id: agents.id });
    const [second] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, companyId), eq(agents.name, "Matrix agent B")));
    agentA = inserted!.id;
    agentB = second!.id;
  }, 60000);

  const connectionRow = async () => {
    const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, connectionId));
    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, grantId));
    return { connection, grant };
  };
  const newRun = async (agentId: string) => (await db.insert(heartbeatRuns).values({ companyId, agentId }).returning({ id: heartbeatRuns.id }))[0]!.id;
  /** Assignment inside a run: pin → sticky → exclusive lease → fast-fail. */
  const lease = async (runId: string, agentId: string, pinnedSlot?: number, model: string = MODEL_A) =>
    service.runtimeCredential(await connectionRow(), { pool: { heartbeatRunId: runId, agentId, pinnedSlot, model } });
  /** Selection outside a run (no lease context, cooldowns still judged). */
  const select = async (model: string = MODEL_A) =>
    service.runtimeCredential(await connectionRow(), { pool: { model } });
  const poolRows = async () => (await db.select().from(credentialPool).where(and(eq(credentialPool.companyId, companyId), eq(credentialPool.connectionId, connectionId)))).sort((a, b) => a.slot - b.slot);
  const cooldownRows = async () => (await db.select().from(credentialPoolCooldowns).where(and(eq(credentialPoolCooldowns.companyId, companyId), eq(credentialPoolCooldowns.connectionId, connectionId)))).sort((a, b) => a.slot - b.slot || a.model.localeCompare(b.model));
  const resetPool = async () => {
    await db.update(credentialPool).set({
      state: "healthy", cooldownUntil: null, cooldownReason: null, enabled: true,
      activeRunId: null, leaseExpiresAt: null, leaseAgentId: null,
      lastAssignedAgentId: null, lastAssignedAt: null, updatedAt: new Date(),
    }).where(and(eq(credentialPool.companyId, companyId), eq(credentialPool.connectionId, connectionId)));
    await db.delete(credentialPoolCooldowns).where(and(eq(credentialPoolCooldowns.companyId, companyId), eq(credentialPoolCooldowns.connectionId, connectionId)));
  };

  afterEach(resetPool);

  it("pins the requested slot unconditionally, warning in the activity log while it cools down", async () => {
    const before = await db.select().from(activityLog).where(and(eq(activityLog.companyId, companyId), eq(activityLog.entityId, connectionId)));
    const runId = await newRun(agentA);
    // Pin bypasses least-recently-used rotation and cooldown state alike.
    await expect(lease(runId, agentA, 2)).resolves.toMatchObject({ keySlot: 2, value: slotKeys.get(2) });
    let rows = await poolRows();
    expect(rows.find((row) => row.slot === 2)).toMatchObject({ activeRunId: runId, leaseAgentId: agentA });
    expect(rows.find((row) => row.slot === 1)).toMatchObject({ activeRunId: null });

    await resetPool();
    await coolSlot(connectionId, 2, MODEL_A, "daily_cooldown", new Date(Date.now() + 3_600_000));
    await expect(lease(runId, agentA, 2)).resolves.toMatchObject({ keySlot: 2 });
    const after = await db.select().from(activityLog).where(and(eq(activityLog.companyId, companyId), eq(activityLog.entityId, connectionId)));
    const warns = after.slice(before.length).filter((entry) => entry.action === "ai_connection.key_slot_pin_cooldown");
    expect(warns).toHaveLength(1);
    expect(warns[0]!.details).toMatchObject({ slot: 2, model: MODEL_A, state: "daily_cooldown" });
    // A different model's cooldown on the pinned slot does not shame this pin:
    // the warn judges the target model only (plan §10 granularity).
    await resetPool();
    await coolSlot(connectionId, 2, MODEL_B, "daily_cooldown", new Date(Date.now() + 3_600_000));
    const mid = await db.select().from(activityLog).where(and(eq(activityLog.companyId, companyId), eq(activityLog.entityId, connectionId)));
    await expect(lease(runId, agentA, 2, MODEL_A)).resolves.toMatchObject({ keySlot: 2 });
    const afterB = await db.select().from(activityLog).where(and(eq(activityLog.companyId, companyId), eq(activityLog.entityId, connectionId)));
    expect(afterB.slice(mid.length).filter((entry) => entry.action === "ai_connection.key_slot_pin_cooldown")).toHaveLength(0);

    // A pin the pool cannot honor fails the run instead of silently serving
    // another account: missing slot and operator-disabled slot alike.
    await resetPool();
    await expect(lease(runId, agentA, 9)).rejects.toMatchObject({ details: { code: "ai_connection_pinned_slot_unavailable" } });
    await db.update(credentialPool).set({ enabled: false }).where(and(eq(credentialPool.companyId, companyId), eq(credentialPool.connectionId, connectionId), eq(credentialPool.slot, 1)));
    await expect(lease(runId, agentA, 1)).rejects.toMatchObject({ details: { code: "ai_connection_pinned_slot_unavailable" } });
  });

  it("keeps the exclusive lease for the pinned slot and fast-fails when another run holds it", async () => {
    const holderRun = await newRun(agentA);
    await expect(lease(holderRun, agentA, 3)).resolves.toMatchObject({ keySlot: 3 });
    const otherRun = await newRun(agentB);
    // The concurrency cap (1 active run per slot) is not waived by the pin.
    await expect(lease(otherRun, agentB, 3)).rejects.toMatchObject({ details: { code: "provider_key_pool_exhausted" } });
    await expect(lease(otherRun, agentB, 3)).rejects.toThrow(new RegExp(`slot 3: healthy, leased by run ${holderRun} \\(agent ${agentA}\\) until`));
  });

  it("prefers the sticky slot for the same agent and only switches when it is leased or cooling down", async () => {
    const firstRun = await newRun(agentA);
    await expect(lease(firstRun, agentA)).resolves.toMatchObject({ keySlot: 1 });
    await releaseRunPoolLease(db, firstRun);
    // Least-recently-used would rotate to slot 2; stickiness keeps the cache
    // (key = account) on slot 1.
    const secondRun = await newRun(agentA);
    await expect(lease(secondRun, agentA)).resolves.toMatchObject({ keySlot: 1 });
    await releaseRunPoolLease(db, secondRun);

    // Sticky slot in cooldown → the agent moves to the next assignable slot.
    await coolSlot(connectionId, 1, MODEL_A, "rpm_cooldown", new Date(Date.now() + 120_000));
    const thirdRun = await newRun(agentA);
    await expect(lease(thirdRun, agentA)).resolves.toMatchObject({ keySlot: 2 });
    await releaseRunPoolLease(db, thirdRun);

    // Sticky slot leased by another run's exclusive lease → move instead.
    const foreignRun = await newRun(agentB);
    await db.delete(credentialPoolCooldowns).where(and(
      eq(credentialPoolCooldowns.companyId, companyId),
      eq(credentialPoolCooldowns.connectionId, connectionId),
      eq(credentialPoolCooldowns.slot, 1),
    ));
    await expect(lease(foreignRun, agentB, 1)).resolves.toMatchObject({ keySlot: 1 });
    const fourthRun = await newRun(agentA);
    await expect(lease(fourthRun, agentA)).resolves.toMatchObject({ keySlot: 2 });
  });

  it("re-resolving within one run lands on the same slot and renews the lease (self-lease is sticky)", async () => {
    const runId = await newRun(agentA);
    const first = await lease(runId, agentA);
    // Review F9: every in-run re-resolution re-takes the lease through the
    // conditional UPDATE, which rewrites leaseExpiresAt = now + TTL. Per-turn
    // credential resolution therefore keeps a long conversation's lease alive
    // without a separate renewal worker (a crashed run is reclaimed by TTL).
    const firstExpiry = (await poolRows()).find((row) => row.slot === first.keySlot)!.leaseExpiresAt!;
    await new Promise((resolve) => setTimeout(resolve, 15));
    const second = await lease(runId, agentA);
    expect(second.keySlot).toBe(first.keySlot);
    expect((await poolRows()).filter((row) => row.activeRunId)).toHaveLength(1);
    const secondExpiry = (await poolRows()).find((row) => row.slot === first.keySlot)!.leaseExpiresAt!;
    expect(secondExpiry.getTime()).toBeGreaterThan(firstExpiry.getTime());
  });

  it("hands exclusive leases out least-recently-used first and never double-books a slot under concurrency", async () => {
    // NULL lastAssignedAt is the most stale; then oldest timestamp first.
    const now = Date.now();
    await db.update(credentialPool).set({ lastAssignedAt: new Date(now - 3 * 3_600_000) })
      .where(and(eq(credentialPool.companyId, companyId), eq(credentialPool.connectionId, connectionId), eq(credentialPool.slot, 1)));
    await db.update(credentialPool).set({ lastAssignedAt: new Date(now - 1 * 3_600_000) })
      .where(and(eq(credentialPool.companyId, companyId), eq(credentialPool.connectionId, connectionId), eq(credentialPool.slot, 2)));
    const runIds = [await newRun(agentA), await newRun(agentB), await newRun(agentA)];
    const agentIds = [agentA, agentB, agentA];
    // Concurrent claims: the conditional UPDATE re-checks every eligibility
    // criterion atomically, so each run holds a different slot.
    const leased = await Promise.all(runIds.map((runId, index) => lease(runId, agentIds[index])));
    expect(leased.map((resolution) => resolution.keySlot).sort()).toEqual([1, 2, 3]);
    const rows = await poolRows();
    expect(rows.map((row) => row.activeRunId).filter(Boolean).sort()).toEqual([...runIds].sort());
    expect(rows.every((row) => row.leaseExpiresAt && row.leaseExpiresAt > new Date())).toBe(true);
    // A fourth run finds no free slot: fast-fail with the occupancy snapshot.
    const lateRun = await newRun(agentB);
    await expect(lease(lateRun, agentB)).rejects.toMatchObject({ details: { code: "provider_key_pool_exhausted" } });
  });

  it("reclaims a slot whose lease TTL has expired", async () => {
    const crashedRun = await newRun(agentA);
    await expect(lease(crashedRun, agentA, 1)).resolves.toMatchObject({ keySlot: 1 });
    // The run crashed without reaching its terminal release: the lapsed TTL
    // makes the slot assignable again even though every other slot is cooling
    // down, so the expired lease is the only candidate left.
    await db.update(credentialPool).set({ leaseExpiresAt: new Date(Date.now() - 1_000) })
      .where(and(eq(credentialPool.companyId, companyId), eq(credentialPool.connectionId, connectionId), eq(credentialPool.slot, 1)));
    await coolSlot(connectionId, 2, MODEL_A, "daily_cooldown", new Date(Date.now() + 3_600_000));
    await coolSlot(connectionId, 3, MODEL_A, "daily_cooldown", new Date(Date.now() + 3_600_000));
    const nextRun = await newRun(agentB);
    await expect(lease(nextRun, agentB)).resolves.toMatchObject({ keySlot: 1 });
    expect((await poolRows()).find((row) => row.slot === 1)).toMatchObject({ activeRunId: nextRun });
  });

  it("releases the exclusive lease at the run terminal, once per run", async () => {
    const runId = await newRun(agentA);
    await expect(lease(runId, agentA, 2)).resolves.toMatchObject({ keySlot: 2 });
    const before = await db.select().from(activityLog).where(and(eq(activityLog.companyId, companyId), eq(activityLog.entityId, connectionId)));
    expect(await releaseRunPoolLease(db, runId)).toBe(1);
    expect(await releaseRunPoolLease(db, runId)).toBe(0); // idempotent by run
    expect((await poolRows()).find((row) => row.slot === 2)).toMatchObject({ activeRunId: null, leaseExpiresAt: null, leaseAgentId: null });
    const after = await db.select().from(activityLog).where(and(eq(activityLog.companyId, companyId), eq(activityLog.entityId, connectionId)));
    const releases = after.slice(before.length).filter((entry) => entry.action === "ai_connection.key_slot_released");
    expect(releases).toHaveLength(1);
    expect(releases[0]!.details).toMatchObject({ slot: 2 });
    // Sticky anchor survives the release for the next assignment.
    expect((await poolRows()).find((row) => row.slot === 2)).toMatchObject({ lastAssignedAgentId: agentA });
    // The freed slot is immediately assignable to a different agent.
    const nextRun = await newRun(agentB);
    await expect(lease(nextRun, agentB, 2)).resolves.toMatchObject({ keySlot: 2 });
  });

  it("quarantines cooldowns per (slot, model): a cooled model never shames another model of the same key", async () => {
    // The plan §10 core regression: NIM quota is counted per key × model, so
    // model A's 429 cooldown on slot 1 must leave model B fully assignable.
    await coolSlot(connectionId, 1, MODEL_A, "daily_cooldown", new Date(Date.now() + 3_600_000));
    await coolSlot(connectionId, 2, MODEL_A, "rpm_cooldown", new Date(Date.now() + 120_000));
    // Sticky + lease lanes for model B: slots 1 and 2 stay eligible.
    const runB = await newRun(agentA);
    await expect(lease(runB, agentA, undefined, MODEL_B)).resolves.toMatchObject({ keySlot: 1 });
    await releaseRunPoolLease(db, runB);
    // Selection without a run judges the same way: model B still resolves to a
    // healthy slot (LRU, no agent context → sticky cannot apply).
    await expect(select(MODEL_B)).resolves.toMatchObject({ keySlot: expect.any(Number) });
    // And model A still fast-fails with the per-model snapshot: its only
    // healthy slot (3) is held by another run's exclusive lease.
    const holderRun = await newRun(agentB);
    await expect(lease(holderRun, agentB, 3, MODEL_B)).resolves.toMatchObject({ keySlot: 3 });
    const runA = await newRun(agentB);
    await expect(lease(runA, agentB, undefined, MODEL_A)).rejects.toThrow(/slot 1: daily_cooldown, cooldown until.*slot 2: rpm_cooldown, cooldown until.*slot 3: healthy, leased/);
  });

  it("expires an rpm_cooldown back to eligibility without a probe, but keeps a due daily_cooldown cooling", async () => {
    // rpm_cooldown past its deadline: the window has closed, eligibility
    // returns without any probe or state write (query-time transition).
    await coolSlot(connectionId, 1, MODEL_A, "rpm_cooldown", new Date(Date.now() - 1_000), "rpm");
    await expect(select(MODEL_A)).resolves.toMatchObject({ keySlot: 1 });
    const runId = await newRun(agentA);
    await expect(lease(runId, agentA)).resolves.toMatchObject({ keySlot: 1 });
    // A daily_cooldown past its deadline is NOT eligible: only the probe
    // worker's 200 releases it (its deadline merely schedules the probe).
    await resetPool();
    await coolSlot(connectionId, 1, MODEL_A, "daily_cooldown", new Date(Date.now() - 1_000));
    await coolSlot(connectionId, 2, MODEL_A, "daily_cooldown", new Date(Date.now() - 1_000));
    await coolSlot(connectionId, 3, MODEL_A, "daily_cooldown", new Date(Date.now() - 1_000));
    // A daily_cooldown past its deadline is NOT eligible: only the probe
    // worker's 200 releases it (its deadline merely schedules the probe).
    await expect(select(MODEL_A)).rejects.toMatchObject({ details: { code: "provider_key_pool_exhausted" } });
  });

  it("rotating a slot's key discards its cooldown rows; removing the slot does too", async () => {
    await coolSlot(connectionId, 1, MODEL_A, "daily_cooldown", new Date(Date.now() + 3_600_000));
    await coolSlot(connectionId, 1, MODEL_B, "rpm_cooldown", new Date(Date.now() + 120_000));
    const { errorHandler } = await import("../middleware/index.js");
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", source: "local_implicit", userId: owner, companyIds: [companyId] } as never;
      next();
    });
    app.use("/api", aiConnectionRoutes(db));
    app.use(errorHandler);
    // New key = new account with fresh quota: both cooldown rows are gone.
    const patched = await request(app).patch(`/api/companies/${companyId}/ai-connections/${connectionId}/keys`)
      .send({ slot: 1, keyValue: "fixture-nvapi-matrix-1-rotated" });
    expect(patched.status).toBe(200);
    expect(await cooldownRows()).toHaveLength(0);
    // Removal clears whatever cooldowns remained.
    await coolSlot(connectionId, 3, MODEL_A, "daily_cooldown", new Date(Date.now() + 3_600_000));
    const removed = await request(app).delete(`/api/companies/${companyId}/ai-connections/${connectionId}/keys`)
      .send({ slot: 3 });
    expect(removed.status).toBe(200);
    expect(await cooldownRows()).toHaveLength(0);
  });
});

describe("key pool one-shot avoid slot (ticket 06)", () => {
  let service: ReturnType<typeof aiConnectionService>;
  let connectionId: string;
  let grantId: string;
  let agentA: string;
  const owner = "keypool-avoid-user";
  const slotKeys = new Map<number, string>([[1, "fixture-nvapi-avoid-1"], [2, "fixture-nvapi-avoid-2"]]);

  beforeAll(async () => {
    service = aiConnectionService(db);
    await db.insert(companyMemberships).values({ companyId, principalId: owner, principalType: "user", membershipRole: "member", status: "active" });
    const account = await createGatewayConnectionForUser(owner, "Avoid NIM gateway", "fixture-connection-avoid-key");
    connectionId = account.connectionId;
    grantId = account.grantId;
    for (const [slot, value] of slotKeys) {
      const secret = await secretService(db).create(companyId, { name: `ai-pool-avoid-${connectionId.slice(0, 8)}-slot-${slot}`, provider: "local_encrypted", value }, { userId: owner });
      await db.insert(credentialPool).values({ companyId, connectionId, slot, secretRef: secret.id });
    }
    const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, connectionId));
    await syncConnectionCredentialBindings(db, connection);
    const [inserted] = await db.insert(agents).values({ companyId, name: "Avoid agent" }).returning({ id: agents.id });
    agentA = inserted!.id;
  }, 60000);

  const connectionRow = async () => {
    const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, connectionId));
    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, grantId));
    return { connection, grant };
  };
  const newRun = async () => (await db.insert(heartbeatRuns).values({ companyId, agentId: agentA }).returning({ id: heartbeatRuns.id }))[0]!.id;
  const lease = async (runId: string, input: { pinnedSlot?: number | null; avoidSlot?: number | null; model?: string } = {}) =>
    service.runtimeCredential(await connectionRow(), {
      pool: { heartbeatRunId: runId, agentId: agentA, pinnedSlot: input.pinnedSlot ?? null, avoidSlot: input.avoidSlot ?? null, model: input.model ?? MODEL_A },
    });
  const resetPool = async () => {
    await db.update(credentialPool).set({
      state: "healthy", cooldownUntil: null, cooldownReason: null, enabled: true,
      activeRunId: null, leaseExpiresAt: null, leaseAgentId: null,
      lastAssignedAgentId: null, lastAssignedAt: null, updatedAt: new Date(),
    }).where(and(eq(credentialPool.companyId, companyId), eq(credentialPool.connectionId, connectionId)));
    await db.delete(credentialPoolCooldowns).where(and(eq(credentialPoolCooldowns.companyId, companyId), eq(credentialPoolCooldowns.connectionId, connectionId)));
  };

  afterEach(resetPool);

  it("avoids the failed slot for one assignment even though stickiness would return to it", async () => {
    const firstRun = await newRun();
    await expect(lease(firstRun)).resolves.toMatchObject({ keySlot: 1 });
    await releaseRunPoolLease(db, firstRun);
    // The retry wake carries the failed slot: the next assignment skips it
    // once — the just-failed key is not handed back to the same agent.
    const retryRun = await newRun();
    await expect(lease(retryRun, { avoidSlot: 1 })).resolves.toMatchObject({ keySlot: 2 });
    await releaseRunPoolLease(db, retryRun);
  });

  it("returns the avoided slot to the normal matrix on the following assignment", async () => {
    const firstRun = await newRun();
    await expect(lease(firstRun, { avoidSlot: 2 })).resolves.toMatchObject({ keySlot: 1 });
    await releaseRunPoolLease(db, firstRun);
    // The avoid rode the first wake only: a later assignment without it may
    // use the previously avoided slot again. This agent's stickiness now
    // points at slot 1, so reach the recovered slot through the pin lane —
    // the same lane the switch-key retry uses to return to a healthy slot.
    const secondRun = await newRun();
    await expect(lease(secondRun, { pinnedSlot: 2 })).resolves.toMatchObject({ keySlot: 2 });
  });

  it("fast-fails when the avoid leaves no assignable slot, then serves it again without the avoid", async () => {
    // Slot 2 is the only eligible key for the model; avoiding it must refuse
    // the run instead of silently handing back the failed key.
    await coolSlot(connectionId, 1, MODEL_A, "daily_cooldown", new Date(Date.now() + 3_600_000));
    const retryRun = await newRun();
    await expect(lease(retryRun, { avoidSlot: 2 })).rejects.toMatchObject({ details: { code: "provider_key_pool_exhausted" } });
    // The same wake without the avoid (switch-key retry semantics) serves the
    // slot the matrix considers assignable.
    const switchRun = await newRun();
    await expect(lease(switchRun)).resolves.toMatchObject({ keySlot: 2 });
  });

  it("keeps the pin above the avoid: a pinned slot is used even when avoided", async () => {
    const runId = await newRun();
    await expect(lease(runId, { pinnedSlot: 2, avoidSlot: 2 })).resolves.toMatchObject({ keySlot: 2 });
  });

  it("keeps in-run re-resolutions on the same slot when the avoid is active", async () => {
    const runId = await newRun();
    const first = await lease(runId, { avoidSlot: 1 });
    expect(first.keySlot).toBe(2);
    const second = await lease(runId, { avoidSlot: 1 });
    expect(second.keySlot).toBe(2);
  });

  it("projects the avoided slot through prepareManagedAiRuntime's env slot selection", async () => {
    // The full preparation chain: the avoid rides the run context into
    // runtimeCredential, and the projected PAPERCLIP_AI_PROVIDER_KEY_SLOT is
    // the slot the matrix picked without the avoided one.
    const runtime = await prepareManagedAiRuntime(db, {
      companyId, agentId: agentA, responsibleUserId: owner, adapterType: "paperclip_runner",
      binding: { provider: "openai", method: "api_key", mode: "shared", connectionId, grantId },
      config: { provider: "opencode", model: `paperclip/${MODEL_A}` },
      avoidKeySlot: 1,
    });
    try {
      expect(runtime.keySlot).toBe(2);
      expect((runtime.config.env as Record<string, string>).PAPERCLIP_AI_PROVIDER_KEY_SLOT).toBe("2");
    } finally { await runtime.cleanup(); }
    // Without the avoid the normal matrix serves the never-used slot 1.
    const runtime2 = await prepareManagedAiRuntime(db, {
      companyId, agentId: agentA, responsibleUserId: owner, adapterType: "paperclip_runner",
      binding: { provider: "openai", method: "api_key", mode: "shared", connectionId, grantId },
      config: { provider: "opencode", model: `paperclip/${MODEL_A}` },
    });
    try {
      expect(runtime2.keySlot).toBe(1);
    } finally { await runtime2.cleanup(); }
  });
});

describe("key pool cooldown state machine (ticket 03)", () => {
  let service: ReturnType<typeof aiConnectionService>;
  let connectionId: string;
  let grantId: string;
  let agentA: string;
  let slotId: string;
  const owner = "keypool-cooldown-user";

  beforeAll(async () => {
    service = aiConnectionService(db);
    await db.insert(companyMemberships).values({ companyId, principalId: owner, principalType: "user", status: "active", membershipRole: "member" });
    const account = await createGatewayConnectionForUser(owner, "Cooldown NIM gateway", "fixture-connection-cooldown-key");
    connectionId = account.connectionId;
    grantId = account.grantId;
    const secret = await secretService(db).create(companyId, { name: `ai-pool-cooldown-${connectionId.slice(0, 8)}-slot-1`, provider: "local_encrypted", value: "fixture-nvapi-cooldown-1" }, { userId: owner });
    const [row] = await db.insert(credentialPool).values({ companyId, connectionId, slot: 1, secretRef: secret.id }).returning({ id: credentialPool.id });
    slotId = row!.id;
    const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, connectionId));
    await syncConnectionCredentialBindings(db, connection);
    const [inserted] = await db.insert(agents).values({ companyId, name: "Cooldown agent" }).returning({ id: agents.id });
    agentA = inserted!.id;
  }, 60000);

  const connectionRow = async () => {
    const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, connectionId));
    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, grantId));
    return { connection, grant };
  };
  const newRunId = async () => (await db.insert(heartbeatRuns).values({ companyId, agentId: agentA }).returning({ id: heartbeatRuns.id }))[0]!.id;
  const nextRunId = newRunId;
  const leaseRow = async () => (await db.select().from(credentialPool).where(eq(credentialPool.id, slotId)))[0]!;
  const cooldownRow = async (model: string) => (await db.select().from(credentialPoolCooldowns)
    .where(and(
      eq(credentialPoolCooldowns.companyId, companyId),
      eq(credentialPoolCooldowns.connectionId, connectionId),
      eq(credentialPoolCooldowns.slot, 1),
      eq(credentialPoolCooldowns.model, model),
    )))[0];

  afterEach(async () => {
    await db.update(credentialPool).set({
      state: "healthy", cooldownUntil: null, cooldownReason: null, enabled: true,
      activeRunId: null, leaseExpiresAt: null, leaseAgentId: null,
      lastAssignedAgentId: null, lastAssignedAt: null, updatedAt: new Date(),
    }).where(eq(credentialPool.id, slotId));
    await db.delete(credentialPoolCooldowns).where(and(eq(credentialPoolCooldowns.companyId, companyId), eq(credentialPoolCooldowns.connectionId, connectionId)));
    await db.delete(usageRequestLogs).where(and(eq(usageRequestLogs.companyId, companyId)));
  });

  it("re-checks eligibility inside the lease UPDATE (review F8): disabled, cooled or already-leased slots match nothing", async () => {
    const now = new Date();
    const base = { companyId, connectionId, slotId, runId: await nextRunId(), agentId: agentA, modelKey: MODEL_A, now };
    // Free + enabled + healthy for the model: the lease is taken.
    expect(await takePoolSlotLease(db, { ...base, respectCooldown: true })).toMatchObject({ activeRunId: base.runId });
    await db.update(credentialPool).set({ activeRunId: null, leaseExpiresAt: null, leaseAgentId: null }).where(eq(credentialPool.id, slotId));
    // Operator-disabled slot: the WHERE refuses even though the matrix's
    // pre-screen may have seen it enabled a moment ago.
    await db.update(credentialPool).set({ enabled: false }).where(eq(credentialPool.id, slotId));
    expect(await takePoolSlotLease(db, { ...base, runId: await nextRunId(), respectCooldown: true })).toBeNull();
    await db.update(credentialPool).set({ enabled: true }).where(eq(credentialPool.id, slotId));
    // Active cooldown for the target model: refused.
    await db.insert(credentialPoolCooldowns).values({
      companyId, connectionId, slot: 1, model: MODEL_A, state: "daily_cooldown",
      cooldownUntil: new Date(Date.now() + 3_600_000), cooldownReason: "daily",
    });
    expect(await takePoolSlotLease(db, { ...base, runId: await nextRunId(), respectCooldown: true })).toBeNull();
    // The same cooldown row does not block the pin lane (respectCooldown: false).
    const pinned = await takePoolSlotLease(db, { ...base, runId: await nextRunId(), respectCooldown: false });
    expect(pinned).toMatchObject({ activeRunId: expect.any(String) });
    await db.update(credentialPool).set({ activeRunId: null, leaseExpiresAt: null, leaseAgentId: null }).where(eq(credentialPool.id, slotId));
    // Expired rpm_cooldown: eligible (query-time transition), the lease lands.
    await db.update(credentialPoolCooldowns).set({ state: "rpm_cooldown", cooldownUntil: new Date(Date.now() - 1_000), cooldownReason: "rpm" })
      .where(and(eq(credentialPoolCooldowns.companyId, companyId), eq(credentialPoolCooldowns.model, MODEL_A)));
    expect(await takePoolSlotLease(db, { ...base, runId: await nextRunId(), respectCooldown: true })).not.toBeNull();
    await db.update(credentialPool).set({ activeRunId: null, leaseExpiresAt: null, leaseAgentId: null }).where(eq(credentialPool.id, slotId));
    // Another model's cooldown never blocks this model's lease.
    await db.update(credentialPoolCooldowns).set({ state: "daily_cooldown", cooldownUntil: new Date(Date.now() + 3_600_000), cooldownReason: "daily" })
      .where(and(eq(credentialPoolCooldowns.companyId, companyId), eq(credentialPoolCooldowns.model, MODEL_A)));
    expect(await takePoolSlotLease(db, { ...base, runId: await nextRunId(), modelKey: MODEL_B, respectCooldown: true })).not.toBeNull();
  });

  it("classifies a 429 with window traffic as rpm_cooldown using max(90s, retry-after)", async () => {
    const runId = await newRunId();
    await takePoolSlotLease(db, { companyId, connectionId, slotId, runId, agentId: agentA, modelKey: MODEL_A, now: new Date(), respectCooldown: true });
    const now = new Date();
    // Two window requests for the pair (the 429 row itself counts as traffic),
    // recorded the way the capture sink writes them: the prefixed routed model.
    for (const status of [200, 429]) {
      await db.insert(usageRequestLogs).values({
        companyId, runId, agentId: agentA, app: "opencode", provider: "paperclip", biller: "paperclip",
        model: `paperclip/${MODEL_A}`, httpStatus: status, requestId: randomUUID(), occurredAt: new Date(now.getTime() - 5_000),
        metadata: { keySlot: 1, connectionId },
      });
    }
    // recordForRun hands the classifier the usage row's stored model string.
    const classification = await classifyKeySlot429(db, { companyId, runId, keySlot: 1, model: `paperclip/${MODEL_A}`, retryAfterSeconds: 120, now });
    expect(classification).toMatchObject({ state: "rpm_cooldown", windowCount: 2, retryAfterSeconds: 120 });
    // retry-after 120s > the 90s floor wins.
    expect(classification!.cooldownUntil.getTime()).toBe(now.getTime() + 120_000);
    expect(await cooldownRow(MODEL_A)).toMatchObject({ state: "rpm_cooldown", cooldownReason: "rpm", lastRunId: runId });
    // A short retry-after falls back to the 90s floor.
    const short = await classifyKeySlot429(db, { companyId, runId, keySlot: 1, model: `paperclip/${MODEL_A}`, retryAfterSeconds: 5, now: new Date(now.getTime() + 1) });
    expect(short!.cooldownUntil.getTime()).toBe(now.getTime() + 1 + 90_000);
    // No header: the 90s fallback.
    const none = await classifyKeySlot429(db, { companyId, runId, keySlot: 1, model: `paperclip/${MODEL_A}`, retryAfterSeconds: null, now: new Date(now.getTime() + 2) });
    expect(none!.cooldownUntil.getTime()).toBe(now.getTime() + 2 + 90_000);
    // Evidence lands in the activity log.
    const [logged] = await db.select().from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.entityId, connectionId), eq(activityLog.action, "ai_connection.key_slot_cooldown")))
      .orderBy(desc(activityLog.createdAt)).limit(1);
    expect(logged!.details).toMatchObject({ slot: 1, model: MODEL_A, state: "rpm_cooldown", windowCount: 2, retryAfterSeconds: null });
  });

  it("classifies a 429 with an empty window as the daily limit and quarantines the pair for 24h", async () => {
    const runId = await newRunId();
    await takePoolSlotLease(db, { companyId, connectionId, slotId, runId, agentId: agentA, modelKey: MODEL_A, now: new Date(), respectCooldown: true });
    // Only the 429 row itself in the window: RPM is not the limiter.
    const now = new Date();
    await db.insert(usageRequestLogs).values({
      companyId, runId, agentId: agentA, app: "opencode", provider: "paperclip", biller: "paperclip",
      model: `paperclip/${MODEL_A}`, httpStatus: 429, requestId: randomUUID(), occurredAt: now,
      metadata: { keySlot: 1, connectionId },
    });
    const classification = await classifyKeySlot429(db, { companyId, runId, keySlot: 1, model: `paperclip/${MODEL_A}`, now });
    expect(classification).toMatchObject({ state: "daily_cooldown", windowCount: 1 });
    expect(classification!.cooldownUntil.getTime()).toBe(now.getTime() + 24 * 60 * 60 * 1000);
    expect(await cooldownRow(MODEL_A)).toMatchObject({ state: "daily_cooldown", cooldownReason: "daily" });
    // The pair is now ineligible for the target model…
    await expect(service.runtimeCredential(await connectionRow(), { pool: { model: MODEL_A } }))
      .rejects.toMatchObject({ details: { code: "provider_key_pool_exhausted" } });
    // …while another model of the same key stays assignable (plan §10 core).
    await expect(service.runtimeCredential(await connectionRow(), { pool: { model: MODEL_B } }))
      .resolves.toMatchObject({ keySlot: 1 });
  });

  it("skips classification when the 429 cannot be attributed to a leased pooled slot", async () => {
    // No lease for this run: the hook is a no-op.
    const runId = await newRunId();
    await expect(classifyKeySlot429(db, { companyId, runId, keySlot: 1, model: MODEL_A, now: new Date() })).resolves.toBeNull();
    expect(await cooldownRow(MODEL_A)).toBeUndefined();
    // A lease on another slot (or another keySlot number) does not match.
    const leaseRun = await newRunId();
    await takePoolSlotLease(db, { companyId, connectionId, slotId, runId: leaseRun, agentId: agentA, modelKey: MODEL_A, now: new Date(), respectCooldown: true });
    await expect(classifyKeySlot429(db, { companyId, runId: leaseRun, keySlot: 7, model: MODEL_A, now: new Date() })).resolves.toBeNull();
    // The hook receives the usage row's stored model string (the prefixed
    // routed form) and still writes the cooldown row under the bare upstream
    // id the probe needs.
    const now = new Date();
    await db.insert(usageRequestLogs).values({
      companyId, runId: leaseRun, agentId: agentA, app: "opencode", provider: "paperclip", biller: "paperclip",
      model: `paperclip/${MODEL_A}`, httpStatus: 429, requestId: randomUUID(), occurredAt: now, metadata: { keySlot: 1, connectionId },
    });
    await db.insert(usageRequestLogs).values({
      companyId, runId: leaseRun, agentId: agentA, app: "opencode", provider: "paperclip", biller: "paperclip",
      model: `paperclip/${MODEL_A}`, httpStatus: 429, requestId: randomUUID(), occurredAt: now, metadata: { keySlot: 1, connectionId },
    });
    const classification = await classifyKeySlot429(db, { companyId, runId: leaseRun, keySlot: 1, model: `paperclip/${MODEL_A}`, now });
    expect(classification!.windowCount).toBe(2);
    expect(await cooldownRow(MODEL_A)).toMatchObject({ state: "rpm_cooldown" });
  });

  it("classifies production-shaped traffic: prefixed usage rows with in-window traffic reach rpm_cooldown (review F1)", async () => {
    // The real capture path end to end: the runner's usage sink records the
    // routed model string (`paperclip/<model>` — production 429 rows are 24/24
    // prefixed), recordForRun hands that same string to the classifier, and a
    // pair with real in-window traffic must classify as RPM, not as the
    // spurious daily limit the bare-id lookup produced.
    const runId = await newRunId();
    await takePoolSlotLease(db, { companyId, connectionId, slotId, runId, agentId: agentA, modelKey: MODEL_A, now: new Date(), respectCooldown: true });
    const now = new Date();
    for (const status of [200, 200, 429]) {
      await db.insert(usageRequestLogs).values({
        companyId, runId, agentId: agentA, app: "opencode", provider: "paperclip", biller: "paperclip",
        model: `paperclip/${MODEL_A}`, httpStatus: status, requestId: randomUUID(), occurredAt: new Date(now.getTime() - 5_000),
        metadata: { keySlot: 1, connectionId },
      });
    }
    const classification = await classifyKeySlot429(db, { companyId, runId, keySlot: 1, model: `paperclip/${MODEL_A}`, now });
    expect(classification).toMatchObject({ state: "rpm_cooldown", windowCount: 3 });
    // The cooldown row stays keyed by the bare upstream id for the probe.
    expect(await cooldownRow(MODEL_A)).toMatchObject({ state: "rpm_cooldown", cooldownReason: "rpm" });
    // The pair is ineligible for the target model while the other model of the
    // same key stays assignable (plan §10 core, now under the real convention).
    await expect(service.runtimeCredential(await connectionRow(), { pool: { model: MODEL_A } }))
      .rejects.toMatchObject({ details: { code: "provider_key_pool_exhausted" } });
    await expect(service.runtimeCredential(await connectionRow(), { pool: { model: MODEL_B } }))
      .resolves.toMatchObject({ keySlot: 1 });
  });

  it("narrows the 429 window to the row's own connection: same slot and model across two pools never pollutes each other (review F2)", async () => {
    // A second gateway connection in the same company with the same slot
    // number and the same model: its window traffic must not feed this pool's
    // classification (and vice versa).
    const other = await createGatewayConnectionForUser(userId, "Second NIM gateway", "fixture-connection-second-pool");
    const otherSecret = await secretService(db).create(companyId, { name: `ai-pool-second-${other.connectionId.slice(0, 8)}-slot-1`, provider: "local_encrypted", value: "fixture-nvapi-second-1" }, { userId });
    await db.insert(credentialPool).values({ companyId, connectionId: other.connectionId, slot: 1, secretRef: otherSecret.id });
    try {
      const runId = await newRunId();
      await takePoolSlotLease(db, { companyId, connectionId, slotId, runId, agentId: agentA, modelKey: MODEL_A, now: new Date(), respectCooldown: true });
      const now = new Date();
      // This pool's window: only the 429 row itself (1 in-window request).
      await db.insert(usageRequestLogs).values({
        companyId, runId, agentId: agentA, app: "opencode", provider: "paperclip", biller: "paperclip",
        model: `paperclip/${MODEL_A}`, httpStatus: 429, requestId: randomUUID(), occurredAt: now,
        metadata: { keySlot: 1, connectionId },
      });
      // The other pool's window: heavy same-slot, same-model traffic that the
      // pre-F2 query (company + model + slot only) would have counted here.
      for (const status of [200, 200, 200]) {
        await db.insert(usageRequestLogs).values({
          companyId, runId, agentId: agentA, app: "opencode", provider: "paperclip", biller: "paperclip",
          model: `paperclip/${MODEL_A}`, httpStatus: status, requestId: randomUUID(), occurredAt: new Date(now.getTime() - 5_000),
          metadata: { keySlot: 1, connectionId: other.connectionId },
        });
      }
      // The row's own connection attribution drives the exact lease lookup…
      const classification = await classifyKeySlot429(db, { companyId, runId, keySlot: 1, connectionId, model: `paperclip/${MODEL_A}`, now });
      // …so the empty own-window classifies as the daily limit, not an
      // RPM cooldown borrowed from the other pool's traffic.
      expect(classification).toMatchObject({ state: "daily_cooldown", windowCount: 1 });
      expect(await cooldownRow(MODEL_A)).toMatchObject({ state: "daily_cooldown", cooldownReason: "daily" });
      // A connection id that no lease row matches classifies nothing, even
      // with (run, slot) still resolving the lease without it.
      await db.delete(credentialPoolCooldowns).where(and(
        eq(credentialPoolCooldowns.companyId, companyId), eq(credentialPoolCooldowns.connectionId, connectionId)));
      await expect(classifyKeySlot429(db, { companyId, runId, keySlot: 1, connectionId: other.connectionId, model: `paperclip/${MODEL_A}`, now }))
        .resolves.toBeNull();
      expect(await cooldownRow(MODEL_A)).toBeUndefined();
      // Without a row-level connection id (pre-ticket-04 payload) the lease
      // lookup falls back to (run, slot) and the window still narrows to the
      // lease's connection. A different model keeps this sub-case clear of
      // the daily cooldown the first classification wrote for MODEL_A, and
      // the first run's lease is released the way a terminal run would.
      await releaseRunPoolLease(db, runId);
      const legacyRunId = await newRunId();
      await takePoolSlotLease(db, { companyId, connectionId, slotId, runId: legacyRunId, agentId: agentA, modelKey: MODEL_B, now: new Date(), respectCooldown: true });
      await db.insert(usageRequestLogs).values({
        companyId, runId: legacyRunId, agentId: agentA, app: "opencode", provider: "paperclip", biller: "paperclip",
        model: `paperclip/${MODEL_B}`, httpStatus: 429, requestId: randomUUID(), occurredAt: now,
        metadata: { keySlot: 1, connectionId },
      });
      const legacy = await classifyKeySlot429(db, { companyId, runId: legacyRunId, keySlot: 1, model: `paperclip/${MODEL_B}`, now: new Date(now.getTime() + 1) });
      expect(legacy).toMatchObject({ state: "daily_cooldown", windowCount: 1 });
    } finally {
      await db.delete(credentialPool).where(eq(credentialPool.connectionId, other.connectionId));
      await db.delete(credentialPoolCooldowns).where(and(
        eq(credentialPoolCooldowns.companyId, companyId), eq(credentialPoolCooldowns.connectionId, other.connectionId)));
    }
  });

  it("computes the probe deadline from due daily cooldowns only", async () => {
    expect(await nextCooldownProbeDeadline(db)).toBeNull();
    const far = new Date(Date.now() + 20 * 60 * 60 * 1000);
    const near = new Date(Date.now() + 3 * 60 * 1000);
    await db.insert(credentialPoolCooldowns).values([
      { companyId, connectionId, slot: 1, model: MODEL_A, state: "daily_cooldown", cooldownUntil: far, cooldownReason: "daily" },
      { companyId, connectionId, slot: 1, model: MODEL_B, state: "daily_cooldown", cooldownUntil: near, cooldownReason: "daily" },
      { companyId, connectionId, slot: 1, model: "meta/rpm-model", state: "rpm_cooldown", cooldownUntil: new Date(Date.now() + 30_000), cooldownReason: "rpm" },
    ]);
    // Only daily rows within the 5-minute lead window qualify; rpm rows never do.
    expect(await nextCooldownProbeDeadline(db)).toBe(near.getTime());
    // Outside the lead window: no obligation yet.
    expect(await nextCooldownProbeDeadline(db, new Date(Date.now() - 10 * 60 * 1000))).toBeNull();
  });
});

describe("key pool probe worker (ticket 03)", () => {
  let connectionId: string;
  let agentId: string;
  const owner = "keypool-probe-user";
  const slotKeyValue = "fixture-nvapi-probe-1";

  beforeAll(async () => {
    await db.insert(companyMemberships).values({ companyId, principalId: owner, principalType: "user", status: "active", membershipRole: "member" });
    const account = await createGatewayConnectionForUser(owner, "Probe NIM gateway", "fixture-connection-probe-key");
    connectionId = account.connectionId;
    const secret = await secretService(db).create(companyId, { name: `ai-pool-probe-${connectionId.slice(0, 8)}-slot-1`, provider: "local_encrypted", value: slotKeyValue }, { userId: owner });
    await db.insert(credentialPool).values({ companyId, connectionId, slot: 1, secretRef: secret.id });
    const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, connectionId));
    await syncConnectionCredentialBindings(db, connection);
    const [inserted] = await db.insert(agents).values({ companyId, name: "Probe agent" }).returning({ id: agents.id });
    agentId = inserted!.id;
  }, 60000);

  const newRun = async () => (await db.insert(heartbeatRuns).values({ companyId, agentId }).returning({ id: heartbeatRuns.id }))[0]!.id;
  const insertDueCooldown = async (model: string, lastRunId: string | null) => {
    const [row] = await db.insert(credentialPoolCooldowns).values({
      companyId, connectionId, slot: 1, model, state: "daily_cooldown",
      cooldownUntil: new Date(Date.now() - 1_000), cooldownReason: "daily", lastRunId,
    }).returning({ id: credentialPoolCooldowns.id });
    return row!.id;
  };
  const cooldownState = async (model: string) => (await db.select().from(credentialPoolCooldowns)
    .where(and(
      eq(credentialPoolCooldowns.companyId, companyId),
      eq(credentialPoolCooldowns.connectionId, connectionId),
      eq(credentialPoolCooldowns.model, model),
    )))[0]!;
  const probeUsageRows = async () => (await db.select().from(usageRequestLogs)
    .where(and(eq(usageRequestLogs.companyId, companyId), eq(usageRequestLogs.app, "key_pool_probe"))));
  const activityActions = async () => (await db.select().from(activityLog)
    .where(and(eq(activityLog.companyId, companyId), eq(activityLog.entityId, connectionId))))
    .filter((entry) => entry.action.startsWith("ai_connection.key_slot_probe"));

  afterEach(async () => {
    await db.delete(credentialPoolCooldowns).where(and(eq(credentialPoolCooldowns.companyId, companyId), eq(credentialPoolCooldowns.connectionId, connectionId)));
    await db.delete(usageRequestLogs).where(and(eq(usageRequestLogs.companyId, companyId)));
    await db.delete(activityLog).where(and(eq(activityLog.companyId, companyId), eq(activityLog.entityId, connectionId)));
  });

  it("releases a due daily cooldown on a 200 probe and records the probe's real usage", async () => {
    const runId = await newRun();
    await insertDueCooldown(MODEL_A, runId);
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 });
    };
    const now = new Date();
    expect(await probeDueSlotCooldowns(db, now, { fetchImpl })).toBe(1);
    // The probe hits the same (slot, model) pair's gateway with a minimal body.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://integrate.api.nvidia.example/v1/chat/completions");
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body).toMatchObject({ model: MODEL_A, max_tokens: 1 });
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${slotKeyValue}`);
    // 200 = proof of recovery: the pair is healthy and assignable again.
    expect(await cooldownState(MODEL_A)).toMatchObject({ state: "healthy", cooldownUntil: null, cooldownReason: null });
    // The probe consumed real quota, so the usage log records it against the
    // run whose 429 started the cooldown, flagged as a probe.
    const usage = await probeUsageRows();
    expect(usage).toHaveLength(1);
    // Review F3: provider/biller derive from the model form the usage log
    // stores — normal rows record `paperclip/<model>` (biller "paperclip"), so the
    // probe's row must not split the same model into a second billing group.
    // The row carries the pool attribution (ticket 04) with the same
    // "keySlot implies connectionId" contract as agent-traffic rows.
    expect(usage[0]).toMatchObject({
      runId, httpStatus: 200, model: MODEL_A, inputTokens: 1, outputTokens: 1,
      provider: "paperclip", biller: "paperclip",
      metadata: { probe: true, keySlot: 1, connectionId },
    });
    expect(usage[0]!.requestId).toMatch(/^keypool-probe-/);
    expect((await activityActions()).map((entry) => entry.action)).toContain("ai_connection.key_slot_probe_released");
  });

  it("defers a due daily cooldown by the probe defer window on a 429 probe", async () => {
    const runId = await newRun();
    await insertDueCooldown(MODEL_A, runId);
    const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({ error: "rate limited" }), { status: 429 });
    const now = new Date();
    expect(await probeDueSlotCooldowns(db, now, { fetchImpl })).toBe(1);
    const row = await cooldownState(MODEL_A);
    expect(row.state).toBe("daily_cooldown");
    // Nothing shortens a daily cooldown but a 200: the next probe waits one
    // defer window from the sweep.
    expect(row.cooldownUntil!.getTime()).toBe(now.getTime() + PROBE_DEFER_MS);
    const usage = await probeUsageRows();
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ runId, httpStatus: 429 });
    expect((await activityActions()).map((entry) => entry.action)).toContain("ai_connection.key_slot_probe_deferred");
  });

  it("defers on any other answered status and leaves the row untouched when transport fails", async () => {
    const runId = await newRun();
    await insertDueCooldown(MODEL_A, runId);
    const fetchImpl: typeof fetch = async () => {
      throw new Error("connection refused");
    };
    const before = await cooldownState(MODEL_A);
    expect(await probeDueSlotCooldowns(db, new Date(), { fetchImpl })).toBe(0);
    // A network failure is not evidence about quota: no state change, no
    // usage row, the worker's retry re-probes the same deadline.
    const after = await cooldownState(MODEL_A);
    expect(after.state).toBe("daily_cooldown");
    expect(after.cooldownUntil!.getTime()).toBe(before.cooldownUntil!.getTime());
    expect(await probeUsageRows()).toHaveLength(0);
    expect(await activityActions()).toHaveLength(0);
  });

  it("bounds the probe fetch with a hard timeout signal and honors the caller's abort (review F4)", async () => {
    const signals: AbortSignal[] = [];
    const capturingFetch: typeof fetch = async (_url, init) => {
      signals.push(init?.signal as AbortSignal);
      return new Response("{}", { status: 200 });
    };
    // Even with no caller signal the fetch carries a signal: a silent upstream
    // must never hang the sweep (the hard timeout composes in).
    const runId = await newRun();
    await insertDueCooldown(MODEL_A, runId);
    await probeDueSlotCooldowns(db, new Date(), { fetchImpl: capturingFetch });
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[0]!.aborted).toBe(false);
    // The caller's abort still propagates through the composition.
    await insertDueCooldown(MODEL_B, await newRun());
    const controller = new AbortController();
    const held: AbortSignal[] = [];
    const secondFetch: typeof fetch = async (_url, init) => {
      held.push(init?.signal as AbortSignal);
      return new Response("{}", { status: 200 });
    };
    await probeDueSlotCooldowns(db, new Date(), { fetchImpl: secondFetch, signal: controller.signal });
    controller.abort();
    expect(held[0]).toBeInstanceOf(AbortSignal);
    expect(held[0]!.aborted).toBe(true);
  });

  it("skips rows without run attribution and rows whose connection is not an api-key gateway", async () => {
    const runId = await newRun();
    // Row 1: no lastRunId — the probe's usage cannot be attributed honestly.
    await insertDueCooldown(MODEL_A, null);
    // Row 2: attributed and due — the only pair this sweep probes.
    await insertDueCooldown(MODEL_B, runId);
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (url) => {
      calls.push(String(url));
      return new Response("{}", { status: 200 });
    };
    expect(await probeDueSlotCooldowns(db, new Date(), { fetchImpl })).toBe(1);
    expect(calls).toHaveLength(1);
    // The unattributed pair stays cooling untouched.
    expect(await cooldownState(MODEL_A)).toMatchObject({ state: "daily_cooldown", lastProbeAt: null });

    // A non-gateway (or non-api-key) connection cannot be probed at all:
    // the pair stays cooling and no request leaves the building.
    const other = await createGatewayConnectionForUser(owner, "Probe NIM gateway 2", "fixture-connection-probe-2-key");
    const otherSecret = await secretService(db).create(companyId, { name: `ai-pool-probe-2-${other.connectionId.slice(0, 8)}-slot-1`, provider: "local_encrypted", value: "fixture-nvapi-probe-2" }, { userId: owner });
    await db.insert(credentialPool).values({ companyId, connectionId: other.connectionId, slot: 1, secretRef: otherSecret.id });
    const [otherConnection] = await db.select().from(toolConnections).where(eq(toolConnections.id, other.connectionId));
    await syncConnectionCredentialBindings(db, otherConnection);
    await db.update(toolConnections).set({ config: {} as never }).where(eq(toolConnections.id, other.connectionId));
    await db.insert(credentialPoolCooldowns).values({
      companyId, connectionId: other.connectionId, slot: 1, model: MODEL_A, state: "daily_cooldown",
      cooldownUntil: new Date(Date.now() - 1_000), cooldownReason: "daily", lastRunId: runId,
    });
    const beforeCount = calls.length;
    await probeDueSlotCooldowns(db, new Date(), { fetchImpl });
    expect(calls).toHaveLength(beforeCount);
  });
});

describe("key slot API", () => {
  async function buildApp(actor: Record<string, unknown>) {
    const { errorHandler } = await import("../middleware/index.js");
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = actor as never; next(); });
    app.use("/api", aiConnectionRoutes(db));
    app.use(errorHandler);
    return app;
  }

  const boardActor = { type: "board", source: "local_implicit", userId, companyIds: [companyId] };

  it("creates, lists, updates and removes key slots without ever exposing the key value", async () => {
    const account = await createGatewayConnectionForUser(userId, "Key API NIM gateway", "fixture-connection-api-key");
    const app = await buildApp(boardActor);
    const base = `/api/companies/${companyId}/ai-connections/${account.connectionId}/keys`;

    const created = await request(app).post(base).send({ slot: 3, label: "nim-account-3", keyValue: "fixture-nvapi-key-api-3" });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ slot: 3, label: "nim-account-3", state: "healthy", enabled: true });
    expect(JSON.stringify(created.body)).not.toContain("fixture-nvapi-key-api-3");

    // Duplicate slot is a conflict.
    expect((await request(app).post(base).send({ slot: 3, keyValue: "fixture-nvapi-key-again" })).status).toBe(409);

    const list = await request(app).get(base);
    expect(list.status).toBe(200);
    expect(list.body).toEqual({ connectionId: account.connectionId, slots: [expect.objectContaining({ slot: 3, label: "nim-account-3" })] });
    expect(JSON.stringify(list.body)).not.toContain("fixture-nvapi-key-api-3");

    // Label and enabled toggle.
    const patched = await request(app).patch(base).send({ slot: 3, label: "nim-account-3 renamed", enabled: false });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ slot: 3, label: "nim-account-3 renamed", enabled: false });

    // Replacing the key writes a NEW secret and repoints the slot.
    const before = await db.select().from(credentialPool).where(eq(credentialPool.connectionId, account.connectionId));
    const rotated = await request(app).patch(base).send({ slot: 3, keyValue: "fixture-nvapi-key-api-3b" });
    expect(rotated.status).toBe(200);
    const after = await db.select().from(credentialPool).where(eq(credentialPool.connectionId, account.connectionId));
    expect(after[0]!.secretRef).not.toBe(before[0]!.secretRef);
    const [oldSecret] = await db.select().from(companySecrets).where(eq(companySecrets.id, before[0]!.secretRef));
    expect(oldSecret).toBeUndefined(); // the replaced generation is cleaned up
    expect(JSON.stringify(rotated.body)).not.toContain("fixture-nvapi-key-api-3b");

    const removed = await request(app).delete(base).send({ slot: 3 });
    expect(removed.status).toBe(200);
    expect((await request(app).get(base)).body.slots).toEqual([]);
    // The slot's secret is removed with it.
    const remaining = await db.select().from(companySecrets).where(and(eq(companySecrets.companyId, companyId), eq(companySecrets.name, "ai-pool-fixture-slot-1")));
    expect(remaining).toHaveLength(1); // unrelated fixture secret untouched

    // Activity log covers every mutation, never the key value.
    const actions = (await db.select().from(activityLog).where(and(eq(activityLog.companyId, companyId), eq(activityLog.entityId, account.connectionId)))).map((row) => row.action);
    expect(actions).toEqual(expect.arrayContaining(["ai_connection.key_slot_added", "ai_connection.key_slot_updated", "ai_connection.key_slot_updated", "ai_connection.key_slot_removed"]));
    const details = (await db.select().from(activityLog).where(and(eq(activityLog.companyId, companyId), eq(activityLog.entityId, account.connectionId)))).flatMap((row) => JSON.stringify(row.details ?? {}));
    expect(details.join("\n")).not.toContain("fixture-nvapi-key-api-3");
  });

  it("rejects invalid slots and enforces connection-manager permissions", async () => {
    const account = await createGatewayConnectionForUser(userId, "Key API guard NIM gateway", "fixture-connection-guard-key");
    const app = await buildApp(boardActor);
    const base = `/api/companies/${companyId}/ai-connections/${account.connectionId}/keys`;

    // Unknown connection → 404; unknown slot → 404.
    expect((await request(app).get(`/api/companies/${companyId}/ai-connections/${randomUUID()}/keys`)).status).toBe(404);
    expect((await request(app).patch(base).send({ slot: 9, label: "x" })).status).toBe(404);
    // Malformed body → 400 by the repo's zod convention.
    expect((await request(app).post(base).send({ slot: 0, keyValue: "x" })).status).toBe(400);
    expect((await request(app).delete(base).send({})).status).toBe(400);

    // A viewer cannot manage keys.
    await db.insert(companyMemberships).values({ companyId, principalId: "keypool-viewer", principalType: "user", status: "active", membershipRole: "viewer" });
    const viewerApp = await buildApp({ type: "board", source: "session", userId: "keypool-viewer", companyIds: [companyId], memberships: [{ companyId, status: "active", membershipRole: "viewer" }] });
    expect((await request(viewerApp).get(base)).status).toBe(403);
    expect((await request(viewerApp).post(base).send({ slot: 1, keyValue: "fixture-x" })).status).toBe(403);
    expect((await request(viewerApp).patch(base).send({ slot: 1, enabled: true })).status).toBe(403);
    expect((await request(viewerApp).delete(base).send({ slot: 1 })).status).toBe(403);

    // Another company's actor cannot see the connection's keys at all.
    const stranger = await buildApp({ type: "board", source: "session", userId: "stranger", companyIds: [randomUUID()] });
    expect((await request(stranger).get(base)).status).toBe(403);
  });
});
