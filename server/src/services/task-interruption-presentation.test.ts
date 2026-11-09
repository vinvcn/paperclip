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

describe("queued dependency wait presentation", () => {
  const waitingRun = { ...run, status: "cancelled", runtimeMode: "legacy" as const, startedAt: null,
    errorCode: "issue_dependencies_blocked", resultJson: {
      stopReason: "issue_dependencies_blocked", timeoutSource: "dependency_gate",
      cancellation: { source: "unknown", expected: false },
    } };

  it("keeps a dependency-gated wake out of the failed-attempt UI, including retained input", () => {
    for (const wait of [undefined, { id: "saved-input", requestedAt: new Date(0) }]) {
      expect(projectTaskInterruption(issue, { run: waitingRun, agent, wait, paused: false, approval: false }))
        .toMatchObject({ state: "resolved", canRetry: false });
    }
  });

  it.each(["legacy", "native"])("keeps an unstarted %s dispatcher dependency wait neutral", runtimeMode => {
    const dispatchedWait = { ...waitingRun, runtimeMode,
      resultJson: { ...waitingRun.resultJson, timeoutSource: "stale_queued_run_gate" } };
    expect(projectTaskInterruption(issue, { run: dispatchedWait, agent, paused: false, approval: false }))
      .toMatchObject({ state: "resolved", canRetry: false });
    expect(projectTaskInterruption(issue, { run: { ...dispatchedWait, startedAt: new Date() }, agent, paused: false, approval: false }))
      .toMatchObject({ state: "failed", canRetry: true });
  });

  it("keeps genuine failures and current user gates visible", () => {
    for (const changed of [{ status: "failed" }, { runtimeMode: "native" }, { startedAt: new Date() },
      { errorCode: "setup_failed" }, { resultJson: {} }, { resultJson: { ...waitingRun.resultJson, timeoutFired: true } }]) {
      expect(projectTaskInterruption(issue, { run: { ...waitingRun, ...changed }, agent, paused: false, approval: false }))
        .toMatchObject({ state: "failed", canRetry: true });
    }
    expect(projectTaskInterruption(issue, { run: waitingRun, agent, paused: true, approval: false }))
      .toMatchObject({ state: "waiting_for_user", userAction: "resume" });
    expect(projectTaskInterruption(issue, { run: waitingRun, agent, paused: false, approval: true }))
      .toMatchObject({ state: "waiting_for_user", userAction: "approval" });
    expect(projectTaskInterruption(issue, { run: waitingRun, agent, paused: false, approval: false,
      action: { evidence: {}, status: "active" } as never })).toMatchObject({ state: "failed", canRetry: true });
    expect(projectTaskInterruption(issue, { run: waitingRun, agent, paused: false, approval: false,
      retryWait: { id: "retry", sourceRunId: waitingRun.id, requestedAt: new Date(), preparationStatus: "failed" } }))
      .toMatchObject({ state: "failed", canRetry: true });
  });
});

describe("never-started task refused by admission", () => {
  const todo = { ...issue, status: "todo" };
  const admissionWait = { id: "wake", status: "skipped", reason: "budget.blocked", agentId: "agent" };
  it("names an accounting hold as an automatic wait without a Retry", () => {
    expect(projectTaskInterruption(todo, { agent, admissionWait, paused: false, approval: false })).toMatchObject({
      responsibility: "system", state: "working", canRetry: false,
      retryWait: { reason: "budget.blocked", message: expect.stringContaining("starts automatically") } });
  });
  it("keeps pauses and budget stops as user actions instead of promising an automatic start", () => {
    for (const [state, action] of [
      [{ project: { pausedAt: new Date(), pauseReason: null } }, "resume"],
      [{ company: { status: "paused", pauseReason: "manual" } }, "resume"],
      [{ paused: true }, "resume"],
      [{ agent: { status: "paused", pauseReason: "manual" } }, "resume"],
      [{ company: { status: "paused", pauseReason: "budget" } }, "budget"],
      [{ approval: true }, "approval"],
    ] as const) {
      expect(projectTaskInterruption(todo, { agent, admissionWait, paused: false, approval: false, ...state }))
        .toMatchObject({ responsibility: "user", state: "waiting_for_user", userAction: action });
    }
  });
  it("shows nothing for other refusals, started tasks or another assignee", () => {
    for (const changed of [{ reason: "agent.not_invokable" }, { status: "queued" }, { agentId: "other" }]) {
      expect(projectTaskInterruption(todo, { agent, admissionWait: { ...admissionWait, ...changed }, paused: false, approval: false }))
        .toBeNull();
    }
    expect(projectTaskInterruption({ ...todo, status: "cancelled" }, { agent, admissionWait, paused: false, approval: false })).toBeNull();
  });
});

describe("unadmitted chat Retry presentation", () => {
  const now = Date.parse("2026-01-01T12:00:00Z");
  const failed = { ...run, errorCode: "native_provider_terminal_failed", resultJson: null };
  const wait = { id: "retry", requestedAt: new Date(now), sourceRunId: run.id,
    preparationStatus: "issued", preparationRetryAt: now + 250 };
  const input = { run: failed, agent, wait, paused: false, approval: false };

  it.each(["issued", "processing"])("uses the persisted %s outbox deadline without implying provider work", status => {
    for (const offset of [0, 20_000]) expect(projectTaskInterruption(issue, {
      ...input, wait: { ...wait, preparationStatus: status },
    }, now + offset)).toMatchObject({ state: "retry_scheduled", canRetry: false,
      nextRetryAt: new Date(wait.preparationRetryAt).toISOString() });
  });

  it.each(["failed", "cancelled"])("keeps terminal %s preparation out of the working state", status => {
    expect(projectTaskInterruption(issue, { ...input, wait: { ...wait, preparationStatus: status,
      preparationRetryAt: null } }, now)).toMatchObject({ state: "failed", nextRetryAt: null });
  });

  it("keeps current gates and admitted execution authoritative", () => {
    expect(projectTaskInterruption(issue, { ...input, paused: true }, now))
      .toMatchObject({ state: "waiting_for_user", userAction: "resume" });
    expect(projectTaskInterruption(issue, { ...input, approval: true }, now))
      .toMatchObject({ state: "waiting_for_user", userAction: "approval" });
    for (const status of ["queued", "running"]) expect(projectTaskInterruption(issue, {
      ...input, run: { ...failed, id: "successor", status },
    }, now)).toMatchObject({ state: "working", nextRetryAt: null });
    expect(projectTaskInterruption(issue, { ...input, wait: { ...wait, sourceRunId: "old-run" } }, now))
      .toMatchObject({ state: "working", nextRetryAt: null });
  });
});

// The native coordinator resumes the same run itself after an attach failure.
// A manual Retry offered meanwhile would race that automatic resume.
it("shows a pending native same-run resume instead of a competing Retry", () => {
  const now = Date.parse("2026-11-06T15:25:50.000Z");
  const failed = { ...run, runtimeMode: "native" as const, errorCode: "native_session_interrupted", resultJson: null };
  const resumeAt = new Date("2026-11-06T15:26:18.687Z");
  expect(projectTaskInterruption(issue, { run: { ...failed, nativeResumeAt: resumeAt }, agent, paused: false, approval: false }, now))
    .toMatchObject({ state: "retry_scheduled", canRetry: false, nextRetryAt: resumeAt.toISOString() });
  // A due resume is being dispatched; it is still not the user's turn.
  expect(projectTaskInterruption(issue, { run: { ...failed, nativeResumeAt: new Date(now - 30_000) }, agent, paused: false, approval: false }, now))
    .toMatchObject({ state: "working", canRetry: false });
  // A resume that never ran, or no resume at all, leaves exactly one Retry.
  expect(projectTaskInterruption(issue, { run: { ...failed, nativeResumeAt: new Date(now - 10 * 60_000) }, agent, paused: false, approval: false }, now))
    .toMatchObject({ state: "failed", canRetry: true });
  expect(projectTaskInterruption(issue, { run: failed, agent, paused: false, approval: false }, now))
    .toMatchObject({ state: "failed", canRetry: true });
});

it("explains a persisted Retry wait without exposing the saved payload", () => {
  const failed = { ...run, errorCode: "native_provider_terminal_failed", resultJson: null };
  const wait = { id: "retry", requestedAt: new Date(), sourceRunId: failed.id,
    executionWaitReason: "workspace_repair_required" };
  const presentation = projectTaskInterruption(issue, { run: failed, agent, wait, paused: false, approval: false });
  expect(presentation).toMatchObject({ state: "failed", canRetry: true,
    retryWait: { reason: "workspace_repair_required", message: "Retry is waiting for Paperclip to recover the saved files. Your message is saved." } });
  expect(projectTaskInterruption(issue, { run: failed, agent, wait: { ...wait, sourceRunId: "another-run" }, paused: false, approval: false }))
    .not.toHaveProperty("retryWait");
  expect(projectTaskInterruption(issue, { run: failed, agent, wait: { ...wait, executionWaitReason: "secret-payload" }, paused: false, approval: false }))
    .toMatchObject({ retryWait: { reason: "execution_recovery", message: "Retry is waiting for execution checks. Your message is saved." } });
  expect(projectTaskInterruption(issue, { run: failed, agent, wait, paused: true, approval: false }))
    .toMatchObject({ state: "waiting_for_user", userAction: "resume" });
});

it("names a budget gate instead of generic execution checks for a refused Retry", () => {
  const failed = { ...run, errorCode: "native_provider_terminal_failed", resultJson: null };
  expect(projectTaskInterruption(issue, { run: failed, agent, paused: false, approval: false,
    wait: { id: "retry", requestedAt: new Date(), sourceRunId: failed.id, executionWaitReason: "budget.blocked" } }))
    .toMatchObject({ state: "failed", canRetry: true, retryWait: { reason: "budget.blocked",
      message: "Retry is waiting for the budget to allow new work. Check Costs for unrecorded or unpriced usage." } });
});

it.each(["cleanup_quarantined", "cancelled_by_operator", "retry_source_changed"])("does not offer Retry for terminal Retry waits: %s", reason => {
  const failed = { ...run, errorCode: "native_provider_terminal_failed", resultJson: null };
  expect(projectTaskInterruption(issue, { run: failed, agent, paused: false, approval: false,
    wait: { id: "retry", requestedAt: new Date(), sourceRunId: failed.id, executionWaitReason: reason } }))
    .toMatchObject({ state: "failed", canRetry: false, retryWait: { reason } });
});

it("keeps Retry for a Retry declined for its requester's access, since a new click replaces it", () => {
  const failed = { ...run, errorCode: "native_provider_terminal_failed", resultJson: null };
  expect(projectTaskInterruption(issue, { run: failed, agent, paused: false, approval: false,
    wait: { id: "retry", requestedAt: new Date(), sourceRunId: failed.id, executionWaitReason: "retry_authority_denied" } }))
    .toMatchObject({ state: "failed", canRetry: true, retryWait: { reason: "retry_authority_denied" } });
});

it("preserves the actual workspace preparation error without changing retry authority", () => {
  const failedRun = { ...run, errorCode: "workspace_validation_failed",
    error: "The selected project has no repository source for a remote workspace.", resultJson: null };
  expect(projectTaskInterruption(issue, { run: failedRun, agent, paused: false, approval: false }))
    .toMatchObject({ state: "failed", canRetry: true, workspaceFailure: { message: failedRun.error } });
  for (const status of ["done", "cancelled"]) expect(projectTaskInterruption({ ...issue, status },
    { run: failedRun, agent, paused: false, approval: false })).not.toHaveProperty("workspaceFailure");
  expect(projectTaskInterruption(issue, { run: { ...failedRun, errorCode: "unrelated_failure" }, agent, paused: false, approval: false }))
    .not.toHaveProperty("workspaceFailure");
});

function operatorStoppedRun() {
  return { ...run, status: "cancelled", runtimeMode: "native" as const, companyId: issue.companyId,
    nativeIssueId: issue.id, errorCode: "cancelled", resultJson: {
      cancelledByActorType: "user", cancelledByUserId: "board",
      executionCancellation: { state: "requested" },
      nativeCancellation: { schema: "paperclip.native-cancellation.v1", runId: run.id,
        companyId: issue.companyId, issueId: issue.id, scope: "run",
        reasonCode: "cancellation_run_only", dispatched: true, dispatchState: "acknowledged",
        intentAuditId: "intent", acknowledgementAuditId: "ack" },
    } };
}

describe("intentional native Stop presentation", () => {
  const workingIssue = { ...issue, status: "in_progress" };
  it("does not offer a failed-attempt Retry for an audited operator Stop that keeps its task in progress", () => {
    expect(projectTaskInterruption(workingIssue, { run: operatorStoppedRun(), agent, paused: false, approval: false }))
      .toMatchObject({ state: "resolved", canRetry: false, userAction: null });
    expect(workingIssue.status).toBe("in_progress");
  });

  it.each([{ runId: "foreign" }, { companyId: "foreign" }, { issueId: "foreign" },
    { dispatchState: "pending" }, { dispatched: false }, { acknowledgementAuditId: undefined },
    { intentAuditId: 123 }, { acknowledgementAuditId: {} },
    { scope: "subtree" }])("retains failure presentation without the matching operator receipt %j", change => {
    const stopped = operatorStoppedRun();
    expect(projectTaskInterruption(workingIssue, { run: { ...stopped, resultJson: { ...stopped.resultJson,
      nativeCancellation: { ...stopped.resultJson.nativeCancellation, ...change } } }, agent, paused: false, approval: false }))
      .toMatchObject({ state: "failed", canRetry: true });
  });

  it("keeps pause, approval, non-user cancellation and new input authoritative", () => {
    const stopped = operatorStoppedRun();
    expect(projectTaskInterruption(workingIssue, { run: stopped, agent, paused: true, approval: false }))
      .toMatchObject({ state: "waiting_for_user", userAction: "resume" });
    expect(projectTaskInterruption(workingIssue, { run: stopped, agent, paused: false, approval: true }))
      .toMatchObject({ state: "waiting_for_user", userAction: "approval" });
    expect(projectTaskInterruption(workingIssue, { run: { ...stopped, resultJson: {
      ...stopped.resultJson, cancelledByActorType: "system" } }, agent, paused: false, approval: false }))
      .toMatchObject({ state: "failed", canRetry: true });
    expect(projectTaskInterruption(workingIssue, { run: stopped, agent, paused: false, approval: false,
      wait: { id: "new-input", requestedAt: new Date() } }))
      .toMatchObject({ state: "working", canRetry: false });
  });
});

it("preserves a provider explanation on a failed task without changing retry authority", () => {
  const providerFailure = { schema: "paperclip.provider-failure.v1", provider: "anthropic", phase: "startup",
    category: "rate_limit", message: "API error: 429 This request would exceed your account's rate limit.",
    httpStatus: 429, retryability: "unknown" };
  const failedRun = { ...run, errorCode: "native_session_interrupted", resultJson: { providerFailure } };
  const presentation = projectTaskInterruption(issue, { run: failedRun, agent, paused: false, approval: false });
  expect(presentation).toMatchObject({ state: "failed", canRetry: true, providerFailure });
  expect(projectTaskInterruption({ ...issue, status: "done" }, { run: failedRun, agent, paused: false, approval: false }))
    .not.toHaveProperty("providerFailure");
});

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
describe("saved-work recovery step", () => {
  const now = Date.parse("2026-01-01T12:00:00Z");
  const failed = { ...run, errorCode: "setup_failed", resultJson: null };
  const system = (phase: string, state: string, nextAttemptAt: number | null) => ({
    schema: "paperclip.system-recovery.v1", policyVersion: 1, sourceRunId: "33333333-3333-4333-8333-333333333333", revision: 3,
    generationId: "44444444-4444-4444-8444-444444444444", intentId: null, phase, state, attemptId: null, attempts: 2,
    retriesUsed: 1, firstFailureAt: now - 60_000, nextAttemptAt, deadlineAt: now + 600_000, providerCooldownAt: null,
    failure: null, preservationOperationIds: [], freshAttemptRunId: null });
  const action = (evidence: Record<string, unknown>) => ({ evidence }) as never;

  it("names the step a scheduled recovery will retry", () => {
    expect(projectTaskInterruption(issue, { run: failed, agent, paused: false, approval: false,
      action: action({ systemRecovery: system("verify_execution", "scheduled", now + 30_000) }) }, now))
      .toMatchObject({ state: "retry_scheduled", recoveryStep: "checking_previous_run" });
  });

  it("names the step a running recovery is on", () => {
    expect(projectTaskInterruption(issue, { run: failed, agent, paused: false, approval: false,
      action: action({ systemRecovery: system("preserve_files", "running", null), systemRecoveryActiveAt: now - 1_000 }) }, now))
      .toMatchObject({ state: "working", recoveryStep: "saving_previous_files" });
  });

  it("names recovery over a pending chat preparation and keeps failed preparation authoritative", () => {
    const wait = { id: "retry", requestedAt: new Date(now), sourceRunId: failed.id, preparationStatus: "issued", preparationRetryAt: now + 250 };
    const running = action({ systemRecovery: system("preserve_files", "running", null), systemRecoveryActiveAt: now - 1_000 });
    expect(projectTaskInterruption(issue, { run: failed, agent, wait, paused: false, approval: false, action: running }, now))
      .toMatchObject({ state: "working", recoveryStep: "saving_previous_files" });
    const scheduled = action({ systemRecovery: system("verify_execution", "scheduled", now + 30_000) });
    expect(projectTaskInterruption(issue, { run: failed, agent, wait, paused: false, approval: false, action: scheduled }, now))
      .toMatchObject({ state: "retry_scheduled", recoveryStep: "checking_previous_run", canRetry: false });
    expect(projectTaskInterruption(issue, { run: failed, agent, paused: false, approval: false, action: scheduled }, now))
      .toMatchObject({ state: "retry_scheduled", canRetry: true });
    expect(projectTaskInterruption(issue, { run: failed, agent, wait: { ...wait, preparationStatus: "failed" },
      paused: false, approval: false, action: running }, now)).toMatchObject({ state: "failed" });
    expect(projectTaskInterruption(issue, { run: failed, agent, wait, paused: false, approval: false }, now))
      .toMatchObject({ state: "retry_scheduled", nextRetryAt: new Date(now + 250).toISOString() });
  });

  it("does not name a step for an ordinary scheduled retry", () => {
    expect(projectTaskInterruption(issue, { run: { ...failed, scheduledRetryAt: new Date(now + 30_000) }, agent,
      paused: false, approval: false }, now)).not.toHaveProperty("recoveryStep");
  });
});

describe("scheduled resource wait presentation", () => {
  const now = Date.parse("2026-01-01T12:00:00Z");
  const waiting = { ...run, status: "scheduled_retry", errorCode: null, resultJson: null,
    scheduledRetryReason: "workspace_busy", scheduledRetryAt: new Date(now - 60_000) };

  it("keeps an overdue workspace wait out of the failed-attempt UI", () => {
    expect(projectTaskInterruption(issue, { run: waiting, agent, paused: false, approval: false }, now))
      .toMatchObject({ state: "working", canRetry: false });
  });

  it("keeps failure retries, user gates and failed Retry preparation authoritative", () => {
    expect(projectTaskInterruption(issue, { run: { ...waiting, scheduledRetryReason: "transient_failure" },
      agent, paused: false, approval: false }, now)).toMatchObject({ state: "failed", canRetry: true });
    expect(projectTaskInterruption(issue, { run: waiting, agent, paused: true, approval: false }, now))
      .toMatchObject({ state: "waiting_for_user", userAction: "resume" });
    expect(projectTaskInterruption(issue, { run: waiting, agent, paused: false, approval: false,
      retryWait: { id: "retry", sourceRunId: run.id, requestedAt: new Date(now), preparationStatus: "failed" } }, now))
      .toMatchObject({ state: "failed", canRetry: true });
  });
});
