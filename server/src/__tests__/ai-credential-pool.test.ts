// Key pool foundation (ticket 01): credential_pool table, pool-backed
// runtimeCredential resolution, slot CRUD API. Real keys never appear here;
// every credential in this file is a fixture value.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import {
  companies,
  companyMemberships,
  connectionGrants,
  createDb,
  credentialPool,
  companySecrets,
  companySecretVersions,
  toolConnections,
  type Db,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "@paperclipai/db/test-embedded-postgres";
import { aiConnectionService } from "../services/ai-connections.js";
import { secretService } from "../services/secrets.js";

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

/** A gateway connection like the NVIDIA NIM preset: custom HTTPS base URL + a bearer key. */
async function createGatewayConnection(name: string, key: string) {
  const service = aiConnectionService(db);
  return service.save(companyId, userId, {
    provider: "gateway" as never, method: "api_key", ownership: "shared", name,
    apiKey: key, agentIds: [], allAgents: true,
    routing: { kind: "gateway", protocol: "chat", baseUrl: "https://integrate.api.nvidia.example/v1", auth: "bearer", models: [] },
  } as never, key);
}

describe("credential_pool schema", () => {
  it("stores pool slots for an AI connection and enforces the unique slot constraint", async () => {
    const account = await createGatewayConnection("NIM gateway", "fixture-connection-key");
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
