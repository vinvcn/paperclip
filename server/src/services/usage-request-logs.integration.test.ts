import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
  projects,
  usageRequestLogs,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { PROVIDER_REQUEST_USAGE_KIND, usageProviderAndBillerFromModel } from "../vendor/paperclip-runner/index.js";
import { usageRequestLogService } from "./usage-request-logs.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres usage-request-log tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("usage request log persistence", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string, otherCompanyId: string, agentId: string, runId: string, issueId: string, projectId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-usage-request-logs-");
    db = createDb(tempDb.connectionString, { maxConnections: 4 });
    companyId = randomUUID();
    otherCompanyId = randomUUID();
    agentId = randomUUID();
    projectId = randomUUID();
    issueId = randomUUID();
    runId = randomUUID();
    for (const [id, prefix] of [[companyId, "USG1"], [otherCompanyId, "USG2"]] as const) {
      await db.insert(companies).values({
        id,
        name: `Usage ${id === companyId ? "One" : "Two"}`,
        issuePrefix: prefix,
        requireBoardApprovalForNewAgents: false,
        defaultResponsibleUserId: "responsible-user",
      });
    }
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "UsageCapturer",
      role: "engineer",
      status: "active",
      adapterType: "paperclip_runner",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(projects).values({ id: projectId, companyId, name: "Usage Project" });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "Usage fixture issue",
      status: "in_progress",
      priority: "medium",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      issueId,
      invocationSource: "on_demand",
      status: "running",
      contextSnapshot: {},
    });
  }, 120_000);

  afterAll(async () => {
    await db?.delete(usageRequestLogs);
    await db?.delete(heartbeatRunEvents);
    await db?.delete(heartbeatRuns);
    await db?.delete(issues);
    await db?.delete(projects);
    await db?.delete(agents);
    await db?.delete(companies);
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  });

  const model = "openrouter/anthropic/claude-sonnet-4";
  function usageEvent(requestId: string, overrides: Record<string, unknown> = {}) {
    const startedAtMs = Date.now() - 500;
    return {
      kind: PROVIDER_REQUEST_USAGE_KIND,
      request: {
        requestId,
        app: "opencode",
        ...usageProviderAndBillerFromModel(model),
        model,
        startedAtMs,
        endedAtMs: startedAtMs + 420,
        ttftMs: 95,
        httpStatus: 200,
        providerRequestId: "up-1",
        usage: { inputTokens: 120, cachedInputTokens: 80, cacheWriteTokens: 5, outputTokens: 30 },
        ...overrides,
      },
    };
  }

  it("persists one row per request with server-resolved agent, issue and project", async () => {
    const service = usageRequestLogService(db);
    const inserted = await service.recordForRun(
      { companyId, runId, agentId, issueId },
      usageEvent(randomUUID()),
    );
    expect(inserted).toBe(true);
    const rows = await db.select().from(usageRequestLogs).where(eq(usageRequestLogs.companyId, companyId));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toMatchObject({
      companyId,
      runId,
      agentId,
      issueId,
      projectId,
      app: "opencode",
      provider: "anthropic",
      biller: "openrouter",
      model,
      inputTokens: 120,
      cachedInputTokens: 80,
      cacheWriteTokens: 5,
      outputTokens: 30,
      durationMs: 420,
      ttftMs: 95,
      httpStatus: 200,
      costCents: null,
      costStatus: "unpriced",
    });
  });

  it("ignores re-delivery of the same request id instead of duplicating the row", async () => {
    const service = usageRequestLogService(db);
    const requestId = randomUUID();
    expect(await service.recordForRun({ companyId, runId, agentId, issueId }, usageEvent(requestId))).toBe(true);
    expect(await service.recordForRun({ companyId, runId, agentId, issueId }, usageEvent(requestId))).toBe(false);
    const rows = await db.select().from(usageRequestLogs)
      .where(and(eq(usageRequestLogs.companyId, companyId), eq(usageRequestLogs.requestId, requestId)));
    expect(rows).toHaveLength(1);
  });

  it("keeps token columns null when the usage block was not observable and tolerates null upstream status", async () => {
    const service = usageRequestLogService(db);
    const requestId = randomUUID();
    expect(await service.recordForRun(
      { companyId, runId, agentId, issueId },
      usageEvent(requestId, { usage: null, httpStatus: null, ttftMs: null, providerRequestId: null }),
    )).toBe(true);
    const [row] = await db.select().from(usageRequestLogs)
      .where(and(eq(usageRequestLogs.companyId, companyId), eq(usageRequestLogs.requestId, requestId)));
    expect(row.inputTokens).toBeNull();
    expect(row.outputTokens).toBeNull();
    expect(row.httpStatus).toBeNull();
    expect(row.ttftMs).toBeNull();
  });

  it("refuses malformed payloads and cross-company requests", async () => {
    const service = usageRequestLogService(db);
    expect(await service.recordForRun({ companyId, runId, agentId, issueId }, { kind: "other" })).toBe(false);
    expect(await service.recordForRun({ companyId, runId, agentId, issueId }, null)).toBe(false);
    expect(await service.recordForRun({ companyId, runId, agentId, issueId }, usageEvent(randomUUID(), { requestId: "" }))).toBe(false);
    const before = await db.select().from(usageRequestLogs).where(eq(usageRequestLogs.companyId, companyId));
    expect(await service.recordForRun(
      { companyId: otherCompanyId, runId, agentId: null, issueId: null },
      usageEvent(randomUUID()),
    )).toBe(true);
    expect((await db.select().from(usageRequestLogs).where(eq(usageRequestLogs.companyId, companyId))).length).toBe(before.length);
  });

  it("lists the newest rows for one company only, honouring the limit", async () => {
    const service = usageRequestLogService(db);
    const newRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: newRunId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      status: "running",
      contextSnapshot: {},
    });
    for (const [requestId, ageMinutes] of [[randomUUID(), 30], [randomUUID(), 20], [randomUUID(), 10]] as const) {
      const startedAtMs = Date.now() - ageMinutes * 60_000;
      await service.recordForRun(
        { companyId, runId: newRunId, agentId, issueId: null },
        usageEvent(requestId, { startedAtMs, endedAtMs: startedAtMs + 100, ttftMs: 10 }),
      );
    }
    const latest = await service.latest(companyId, 2);
    expect(latest).toHaveLength(2);
    expect(latest[0]!.occurredAt.getTime()).toBeGreaterThan(latest[1]!.occurredAt.getTime());
    expect(await service.latest(otherCompanyId, 20)).toHaveLength(1);
  });
});
