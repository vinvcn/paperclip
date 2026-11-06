import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { agents, companies, createDb, credentialPool, credentialPoolCooldowns, companySecrets, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  heartbeatRuns, issues, toolApplications, toolConnections, usageRequestLogs, type Db } from "@paperclipai/db";
import { afterAll, beforeAll, beforeEach } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { projectTaskInterruption, taskInterruptionPresentations } from "./task-interruption-presentation.js";

const issue = { id: "task", companyId: "11111111-1111-4111-8111-111111111111", status: "blocked", assigneeAgentId: "agent", projectId: "22222222-2222-4222-8222-222222222222" };
const run = { id: "run", agentId: "agent", status: "failed", scheduledRetryAt: null,
  errorCode: "project_access_denied", error: null, livenessState: null,
  resultJson: { projectAccessDenied: { projectId: "22222222-2222-4222-8222-222222222222" } } };
const agent = { status: "idle", pauseReason: null };

describe("task project-access interruption", () => {
  it("explains a project denial without offering a futile retry", () => {
    expect(projectTaskInterruption(issue, { run, agent, paused: false, approval: false })).toMatchObject({
      state: "waiting_for_user", responsibility: "user", userAction: "project_access", canRetry: false,
      projectAccess: { agentId: "agent", projectId: "22222222-2222-4222-8222-222222222222", ready: false },
    });
  });

  it("projects the historical setup denial without requiring another failed run", () => {
    expect(projectTaskInterruption(issue, { run: { ...run, errorCode: "setup_failed",
      error: "Project is outside this low-trust boundary.", resultJson: null }, agent, paused: false, approval: false }))
      .toMatchObject({ userAction: "project_access", canRetry: false });
  });

  it("offers an explicit retry after the project is added, without changing the failed run", () => {
    expect(projectTaskInterruption(issue, { run, agent, projectAccessAllowed: true, paused: false, approval: false }))
      .toMatchObject({ state: "failed", canRetry: true, projectAccess: { ready: true } });
    expect(run.status).toBe("failed");
  });

  it("shows an accepted retry as working after access is repaired", () => {
    const input = { run, agent, paused: false, approval: false, wait: { id: "request", requestedAt: new Date() } };
    expect(projectTaskInterruption(issue, { ...input, projectAccessAllowed: true }))
      .toMatchObject({ state: "working", canRetry: false });
    expect(projectTaskInterruption(issue, { ...input, projectAccessAllowed: true })).not.toHaveProperty("projectAccess");
    expect(projectTaskInterruption(issue, { ...input, projectAccessAllowed: false }))
      .toMatchObject({ state: "waiting_for_user", userAction: "project_access", canRetry: false });
  });

  it("does not reinterpret unrelated failures or an old assignee's denial", () => {
    for (const otherRun of [{ ...run, errorCode: "setup_failed", error: "Disk full", resultJson: null },
      { ...run, agentId: "previous-agent" }]) {
      expect(projectTaskInterruption(issue, { run: otherRun, agent, paused: false, approval: false }))
        .not.toHaveProperty("projectAccess");
    }
  });

  it("keeps approval, pause, running and completed states authoritative", () => {
    expect(projectTaskInterruption(issue, { run, agent, paused: false, approval: true })).toMatchObject({ userAction: "approval" });
    expect(projectTaskInterruption(issue, { run, agent, paused: true, approval: false })).toMatchObject({ userAction: "resume" });
    expect(projectTaskInterruption(issue, { run: { ...run, status: "running" }, agent, paused: false, approval: false }))
      .toMatchObject({ state: "working" });
    expect(projectTaskInterruption({ ...issue, status: "done" }, { run, agent, paused: false, approval: false }))
      .toMatchObject({ state: "resolved" });
  });
});

describe("task pooled-key interruption", () => {
  // Ticket 05: both pooled-key error codes project as the rate_limited user
  // action, ranked after typed model choice and before budget/pause states.
  it.each(["provider_rate_limited", "provider_key_pool_exhausted"])("projects %s as a rate_limited user action", (errorCode) => {
    expect(projectTaskInterruption(issue, { run: { ...run, errorCode, resultJson: null }, agent, paused: false, approval: false }))
      .toMatchObject({ state: "waiting_for_user", responsibility: "user", userAction: "rate_limited", canRetry: false });
  });

  it("ranks the pooled-key action above budget and pause states", () => {
    expect(projectTaskInterruption(issue, { run: { ...run, errorCode: "provider_rate_limited", resultJson: null },
      agent: { status: "paused", pauseReason: "budget" }, paused: true, approval: false }))
      .toMatchObject({ userAction: "rate_limited" });
  });

  it("keeps typed model choice and approval ahead of the pooled-key action", () => {
    expect(projectTaskInterruption(issue, { run: { ...run, errorCode: "native_provider_model_rejected" }, agent, paused: false, approval: false }))
      .toMatchObject({ userAction: "choose_model" });
    expect(projectTaskInterruption(issue, { run: { ...run, errorCode: "provider_key_pool_exhausted" }, agent, paused: false, approval: true }))
      .toMatchObject({ userAction: "approval" });
  });

  it("leaves other failures to the generic failed state", () => {
    expect(projectTaskInterruption(issue, { run: { ...run, errorCode: "adapter_failed", resultJson: null }, agent, paused: false, approval: false }))
      .toMatchObject({ state: "failed", canRetry: true });
  });
});

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported && !process.env.PAPERCLIP_TEST_DATABASE_URL)("task interruption key-pool projection", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: Db;
  beforeAll(async () => {
    const external = process.env.PAPERCLIP_TEST_DATABASE_URL;
    if (external) db = createDb(external);
    else {
      database = await startEmbeddedPostgresTestDatabase("paperclip-interruption-keypool");
      db = createDb(database.connectionString);
    }
    await db.execute(sql`set client_min_messages = warning`);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });
  beforeEach(async () => { await db.execute(sql`truncate table companies restart identity cascade`); });

  async function pooledFailureFixture(errorCode: string, resultJson: Record<string, unknown>) {
    const [company] = await db.insert(companies).values({ name: "Keyed", issuePrefix: "KEY" }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Keyed agent", adapterType: "process" }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Keyed task", status: "blocked", assigneeAgentId: agent.id }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, status: "failed",
      runtimeMode: "legacy", nativeIssueId: issue.id, errorCode, resultJson }).returning();
    return { company, agent, issue, run };
  }

  async function pooledConnection(companyId: string) {
    const [application] = await db.insert(toolApplications).values({ companyId, name: "Key pool app", type: "rest_api" }).returning();
    return (await db.insert(toolConnections).values({
      companyId, applicationId: application.id, name: "Pooled NIM gateway", uid: `pooled-gateway-${application.id.slice(0, 8)}`,
      connectionPurpose: "ai", transport: "runtime_auth",
    }).returning())[0]!;
  }

  it("attaches live pool state to the rate_limited projection", async () => {
    const f = await pooledFailureFixture("provider_rate_limited", { keyPoolFailure: { reason: "rate_limited" } });
    const connection = await pooledConnection(f.company.id);
    const cooldownUntil = new Date(Date.now() + 90_000);
    await db.insert(credentialPoolCooldowns).values({
      companyId: f.company.id, connectionId: connection.id, slot: 3, model: "z-ai/glm-5.3-flash",
      state: "rpm_cooldown", cooldownUntil, cooldownReason: "rpm", lastRunId: f.run.id,
    });
    await db.insert(usageRequestLogs).values({
      companyId: f.company.id, runId: f.run.id, app: "opencode", provider: "paperclip", biller: "paperclip",
      model: "paperclip/z-ai/glm-5.3-flash", httpStatus: 429, requestId: randomUUID(),
      occurredAt: new Date(Date.now() - 5_000), metadata: { keySlot: 3, connectionId: connection.id },
    });
    const presentation = (await taskInterruptionPresentations(db, f.company.id, [f.issue])).get(f.issue.id);
    expect(presentation).toMatchObject({ state: "waiting_for_user", responsibility: "user", userAction: "rate_limited" });
    expect(presentation?.keyPool).toMatchObject({
      reason: "rate_limited", slot: 3, model: "z-ai/glm-5.3-flash",
      state: "rpm_cooldown", connectionId: connection.id,
    });
  });

  it("falls back to the persisted snapshot when the run's latest request no longer shows the 429", async () => {
    const f = await pooledFailureFixture("provider_rate_limited", { keyPoolFailure: { reason: "rate_limited", slot: 2, model: "z-ai/glm-5.3-flash" } });
    await db.insert(usageRequestLogs).values({
      companyId: f.company.id, runId: f.run.id, app: "opencode", provider: "paperclip", biller: "paperclip",
      model: "test-model", httpStatus: 200, requestId: randomUUID(),
      occurredAt: new Date(Date.now() - 5_000), metadata: null,
    });
    const presentation = (await taskInterruptionPresentations(db, f.company.id, [f.issue])).get(f.issue.id);
    expect(presentation?.userAction).toBe("rate_limited");
    expect(presentation?.keyPool).toEqual({ reason: "rate_limited", slot: 2, model: "z-ai/glm-5.3-flash" });
  });

  it("refreshes an exhausted pool snapshot from live lease and cooldown state", async () => {
    const f = await pooledFailureFixture("provider_key_pool_exhausted", { keyPoolFailure: { reason: "pool_exhausted" } });
    const conn = await pooledConnection(f.company.id);
    const [secret] = await db.insert(companySecrets).values({ companyId: f.company.id, key: "pool-slot-1", name: "keypool-projection-slot-1" }).returning();
    const [slot] = await db.insert(credentialPool).values({
      companyId: f.company.id, connectionId: conn.id, slot: 1, secretRef: secret.id,
    }).returning();
    const cooldownUntil = new Date(Date.now() + 60_000);
    await db.insert(credentialPoolCooldowns).values({
      companyId: f.company.id, connectionId: conn.id, slot: 1, model: "z-ai/glm-5.3-flash",
      state: "rpm_cooldown", cooldownUntil, cooldownReason: "rpm", lastRunId: f.run.id,
    });
    await db.update(heartbeatRuns).set({
      resultJson: { keyPoolFailure: { reason: "pool_exhausted", connectionId: conn.id, model: "z-ai/glm-5.3-flash",
        slots: [{ slot: 1, state: "healthy", model: null, cooldownUntil: null, leasedByRunId: null, leasedByAgentId: null, leasedByAgentName: null }] } },
    }).where(eq(heartbeatRuns.id, f.run.id));
    const presentation = (await taskInterruptionPresentations(db, f.company.id, [f.issue])).get(f.issue.id);
    expect(presentation?.userAction).toBe("rate_limited");
    expect(presentation?.keyPool).toMatchObject({
      reason: "pool_exhausted", connectionId: conn.id, model: "z-ai/glm-5.3-flash",
      slots: [{ slot: slot.slot, state: "rpm_cooldown", cooldownUntil: cooldownUntil.toISOString() }],
    });
  });
});
