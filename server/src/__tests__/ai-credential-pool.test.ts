// Key pool foundation (ticket 01): credential_pool table, pool-backed
// runtimeCredential resolution, slot CRUD API. Real keys never appear here;
// every credential in this file is a fixture value.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import {
  agents,
  companies,
  companyMemberships,
  connectionGrants,
  createDb,
  credentialPool,
  companySecrets,
  companySecretVersions,
  heartbeatRuns,
  toolConnections,
  type Db,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "@paperclipai/db/test-embedded-postgres";
import { aiConnectionService } from "../services/ai-connections.js";
import { releaseRunPoolLease } from "../services/ai-credential-pool.js";
import { secretService } from "../services/secrets.js";
import { prepareManagedAiRuntime } from "../services/ai-connection-runtime.js";
import { syncConnectionCredentialBindings } from "../services/connection-credential-bindings.js";
import { activityLog } from "@paperclipai/db";
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
    // The only enabled slot is in cooldown: the matrix fails fast instead of
    // silently falling back to the single credential (ticket-01 contract change).
    await db.update(credentialPool).set({ state: "daily_cooldown", cooldownUntil: new Date(Date.now() + 3_600_000), cooldownReason: "daily" }).where(poolScope);
    await expect(service.runtimeCredential(row)).rejects.toMatchObject({ details: { code: "provider_key_pool_exhausted" } });
    await expect(service.runtimeCredential(row)).rejects.toThrow(/slot 1: daily_cooldown, cooldown until/);
    // Re-enabled but leased by another run's exclusive lease: a run-scoped
    // resolution fast-fails with the occupancy snapshot. (A resolution without
    // a run selects read-only and ignores occupancy by design.)
    const [holderAgent] = await db.insert(agents).values({ companyId, name: "Exhausted lease holder" }).returning({ id: agents.id });
    const [holderRun] = await db.insert(heartbeatRuns).values({ companyId, agentId: holderAgent!.id }).returning({ id: heartbeatRuns.id });
    const [callerAgent] = await db.insert(agents).values({ companyId, name: "Exhausted caller" }).returning({ id: agents.id });
    const [callerRun] = await db.insert(heartbeatRuns).values({ companyId, agentId: callerAgent!.id }).returning({ id: heartbeatRuns.id });
    await db.update(credentialPool).set({ state: "healthy", cooldownUntil: null, cooldownReason: null }).where(poolScope);
    await db.update(credentialPool).set({ activeRunId: holderRun!.id, leaseExpiresAt: new Date(Date.now() + 600_000), leaseAgentId: holderAgent!.id }).where(poolScope);
    await expect(service.runtimeCredential(row, { pool: { heartbeatRunId: callerRun!.id, agentId: callerAgent!.id } })).rejects.toThrow(new RegExp(`slot 1: healthy, leased by run ${holderRun!.id} \\(agent ${holderAgent!.id}\\) until`));
    await expect(service.runtimeCredential(row, { pool: { heartbeatRunId: callerRun!.id, agentId: callerAgent!.id } })).rejects.toMatchObject({ details: { code: "provider_key_pool_exhausted" } });
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
      expect(runtime.keySlot).toBe(1);
      // The warm-session identity binds the slot: a different slot on a later
      // run invalidates the stored session instead of reusing its captured key.
      expect(runtime.sessionIdentity).toContain("pool-slot-1");
    } finally { await runtime.cleanup(); }
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
  const lease = async (runId: string, agentId: string, pinnedSlot?: number) =>
    service.runtimeCredential(await connectionRow(), { pool: { heartbeatRunId: runId, agentId, pinnedSlot } });
  const poolRows = async () => (await db.select().from(credentialPool).where(and(eq(credentialPool.companyId, companyId), eq(credentialPool.connectionId, connectionId)))).sort((a, b) => a.slot - b.slot);
  const resetPool = async () => {
    await db.update(credentialPool).set({
      state: "healthy", cooldownUntil: null, cooldownReason: null, enabled: true,
      activeRunId: null, leaseExpiresAt: null, leaseAgentId: null,
      lastAssignedAgentId: null, lastAssignedAt: null, updatedAt: new Date(),
    }).where(and(eq(credentialPool.companyId, companyId), eq(credentialPool.connectionId, connectionId)));
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
    await db.update(credentialPool).set({ state: "daily_cooldown", cooldownUntil: new Date(Date.now() + 3_600_000), cooldownReason: "daily" })
      .where(and(eq(credentialPool.companyId, companyId), eq(credentialPool.connectionId, connectionId), eq(credentialPool.slot, 2)));
    await expect(lease(runId, agentA, 2)).resolves.toMatchObject({ keySlot: 2 });
    const after = await db.select().from(activityLog).where(and(eq(activityLog.companyId, companyId), eq(activityLog.entityId, connectionId)));
    const warns = after.slice(before.length).filter((entry) => entry.action === "ai_connection.key_slot_pin_cooldown");
    expect(warns).toHaveLength(1);
    expect(warns[0]!.details).toMatchObject({ slot: 2, state: "daily_cooldown" });

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
    await db.update(credentialPool).set({ state: "rpm_cooldown", cooldownUntil: new Date(Date.now() + 120_000), cooldownReason: "rpm" })
      .where(and(eq(credentialPool.companyId, companyId), eq(credentialPool.connectionId, connectionId), eq(credentialPool.slot, 1)));
    const thirdRun = await newRun(agentA);
    await expect(lease(thirdRun, agentA)).resolves.toMatchObject({ keySlot: 2 });
    await releaseRunPoolLease(db, thirdRun);

    // Sticky slot leased by another run's exclusive lease → move instead.
    const foreignRun = await newRun(agentB);
    await db.update(credentialPool).set({ state: "healthy", cooldownUntil: null, cooldownReason: null })
      .where(and(eq(credentialPool.companyId, companyId), eq(credentialPool.connectionId, connectionId), eq(credentialPool.slot, 1)));
    await expect(lease(foreignRun, agentB, 1)).resolves.toMatchObject({ keySlot: 1 });
    const fourthRun = await newRun(agentA);
    await expect(lease(fourthRun, agentA)).resolves.toMatchObject({ keySlot: 2 });
  });

  it("re-resolving within one run lands on the same slot (self-lease is sticky)", async () => {
    const runId = await newRun(agentA);
    const first = await lease(runId, agentA);
    const second = await lease(runId, agentA);
    expect(second.keySlot).toBe(first.keySlot);
    expect((await poolRows()).filter((row) => row.activeRunId)).toHaveLength(1);
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
    await db.update(credentialPool).set({ state: "daily_cooldown", cooldownUntil: new Date(Date.now() + 3_600_000), cooldownReason: "daily" })
      .where(and(eq(credentialPool.companyId, companyId), eq(credentialPool.connectionId, connectionId), eq(credentialPool.slot, 2)));
    await db.update(credentialPool).set({ state: "daily_cooldown", cooldownUntil: new Date(Date.now() + 3_600_000), cooldownReason: "daily" })
      .where(and(eq(credentialPool.companyId, companyId), eq(credentialPool.connectionId, connectionId), eq(credentialPool.slot, 3)));
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
