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
import { sweepRunUsageRequestLogEvents, usageRequestLogService } from "./usage-request-logs.js";

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

  describe("sweepRunUsageRequestLogEvents", () => {
    let sweepRunId: string;

    beforeAll(async () => {
      sweepRunId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: sweepRunId,
        companyId,
        agentId,
        issueId,
        invocationSource: "on_demand",
        status: "running",
        contextSnapshot: {},
      });
    });

    /** Commit a durable harness.diagnostic row the way the coordinator stores it. */
    function durableDiagnostic(seq: number, requestId: string, overrides: Record<string, unknown> = {}) {
      return {
        companyId,
        runId: sweepRunId,
        agentId,
        seq,
        eventType: "harness.diagnostic",
        stream: "system",
        level: "info",
        payload: {
          prpEvent: {
            eventType: "harness.diagnostic",
            payload: usageEvent(requestId, overrides),
          },
        },
      };
    }

    it("records committed durable provider_request diagnostics, skipping other events and runs", async () => {
      const lateRequestId = randomUUID();
      const nullUsageRequestId = randomUUID();
      await db.insert(heartbeatRunEvents).values([
        durableDiagnostic(1, lateRequestId),
        // A null counter (NIM responses omit cache creation) must stay a
        // null column, not invalidate the whole usage block.
        durableDiagnostic(2, nullUsageRequestId, {
          usage: { inputTokens: 26916, cachedInputTokens: 0, cacheWriteTokens: null, outputTokens: 521 },
        }),
        // Non-usage diagnostics and other runs must be ignored.
        {
          ...durableDiagnostic(3, randomUUID()),
          payload: { prpEvent: { eventType: "harness.diagnostic", payload: { kind: "other" } } },
        },
        { ...durableDiagnostic(4, randomUUID()), runId, eventType: "turn.started", payload: { prpEvent: { eventType: "turn.started", payload: {} } } },
      ]);
      const binding = { companyId, runId: sweepRunId, agentId, issueId };
      const recorded = await sweepRunUsageRequestLogEvents(db, binding);
      expect(recorded).toBe(2);
      const rows = await db.select().from(usageRequestLogs)
        .where(and(eq(usageRequestLogs.companyId, companyId), eq(usageRequestLogs.runId, sweepRunId)));
      expect(rows).toHaveLength(2);
      const byRequestId = new Map(rows.map(row => [row.requestId, row]));
      expect(byRequestId.get(lateRequestId)).toMatchObject({
        inputTokens: 120,
        cachedInputTokens: 80,
        cacheWriteTokens: 5,
        outputTokens: 30,
      });
      expect(byRequestId.get(nullUsageRequestId)).toMatchObject({
        inputTokens: 26916,
        cachedInputTokens: 0,
        cacheWriteTokens: null,
        outputTokens: 521,
      });
    });

    it("replays without duplicating rows already recorded by the live consumer or a prior sweep", async () => {
      const binding = { companyId, runId: sweepRunId, agentId, issueId };
      const service = usageRequestLogService(db);
      // The live consumer already recorded this request before the sweep.
      const liveRequestId = randomUUID();
      expect(await service.recordForRun(binding, usageEvent(liveRequestId))).toBe(true);
      await db.insert(heartbeatRunEvents).values(durableDiagnostic(5, liveRequestId));
      const recorded = await sweepRunUsageRequestLogEvents(db, binding);
      expect(recorded).toBe(0);
      // A second full sweep is also a no-op.
      expect(await sweepRunUsageRequestLogEvents(db, binding)).toBe(0);
      const rows = await db.select().from(usageRequestLogs)
        .where(and(eq(usageRequestLogs.companyId, companyId), eq(usageRequestLogs.requestId, liveRequestId)));
      expect(rows).toHaveLength(1);
    });
  });

  describe("summary metrics", () => {
    let summaryCompanyId: string, summaryOtherCompanyId: string, summaryAgentId: string, summaryOtherAgentId: string, summaryRunId: string;

    beforeAll(async () => {
      summaryCompanyId = randomUUID();
      summaryOtherCompanyId = randomUUID();
      summaryAgentId = randomUUID();
      summaryOtherAgentId = randomUUID();
      summaryRunId = randomUUID();
      await db.insert(companies).values([
        { id: summaryCompanyId, name: "Usage Summary", issuePrefix: "USGS", requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: "responsible-user" },
        { id: summaryOtherCompanyId, name: "Usage Summary Two", issuePrefix: "USGT", requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: "responsible-user" },
      ]);
      await db.insert(agents).values([
        { id: summaryAgentId, companyId: summaryCompanyId, name: "UsageSummary", role: "engineer", status: "active", adapterType: "paperclip_runner", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
        { id: summaryOtherAgentId, companyId: summaryOtherCompanyId, name: "UsageSummaryTwo", role: "engineer", status: "active", adapterType: "paperclip_runner", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      ]);
      await db.insert(heartbeatRuns).values([
        { id: summaryRunId, companyId: summaryCompanyId, agentId: summaryAgentId, invocationSource: "on_demand", status: "running", contextSnapshot: {} },
        { id: randomUUID(), companyId: summaryOtherCompanyId, agentId: summaryOtherAgentId, invocationSource: "on_demand", status: "running", contextSnapshot: {} },
      ]);
    });

    afterAll(async () => {
      await db.delete(usageRequestLogs).where(eq(usageRequestLogs.companyId, summaryCompanyId));
      await db.delete(usageRequestLogs).where(eq(usageRequestLogs.companyId, summaryOtherCompanyId));
      await db.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.companyId, summaryCompanyId));
      await db.delete(heartbeatRuns).where(eq(heartbeatRuns.companyId, summaryCompanyId));
      await db.delete(heartbeatRuns).where(eq(heartbeatRuns.companyId, summaryOtherCompanyId));
      await db.delete(agents).where(eq(agents.id, summaryAgentId));
      await db.delete(agents).where(eq(agents.id, summaryOtherAgentId));
      await db.delete(companies).where(eq(companies.id, summaryCompanyId));
      await db.delete(companies).where(eq(companies.id, summaryOtherCompanyId));
    });

    async function summaryRow(requestId: string, overrides: Record<string, unknown>, company = summaryCompanyId) {
      const startedAtMs = Date.now() - 60_000;
      const inserted = await usageRequestLogService(db).recordForRun(
        { companyId: company, runId: summaryRunId, agentId: null, issueId: null },
        usageEvent(requestId, { startedAtMs, endedAtMs: startedAtMs + 100, ttftMs: 10, ...overrides }),
      );
      if (!inserted) throw new Error(`fixture row ${requestId} was not inserted`);
    }

    it("aggregates the spec metrics in SQL and excludes unobserved requests from token sums", async () => {
      const service = usageRequestLogService(db);
      // fresh input = 1200 - 300 = 900.
      await summaryRow(randomUUID(), { usage: { inputTokens: 1200, cachedInputTokens: 300, cacheWriteTokens: 100, outputTokens: 450 } });
      // A null cached counter (NIM omits cache creation) counts as zero, not as an unobserved row.
      await summaryRow(randomUUID(), { usage: { inputTokens: 500, cachedInputTokens: null, cacheWriteTokens: null, outputTokens: null } });
      // Usage never observed: counts toward requests, adds nothing to token sums.
      await summaryRow(randomUUID(), { usage: null, httpStatus: 429 });
      // Outside the window for the from-filtered read below.
      const staleStartedAtMs = Date.now() - 3 * 60 * 60 * 1000;
      await db.insert(usageRequestLogs).values({
        companyId: summaryCompanyId,
        runId: summaryRunId,
        app: "opencode",
        provider: "paperclip",
        biller: "paperclip",
        model: "openai/gpt-5.2",
        inputTokens: 10,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 10,
        requestId: randomUUID(),
        occurredAt: new Date(staleStartedAtMs),
      });

      expect(await service.summary(summaryCompanyId)).toEqual({
        companyId: summaryCompanyId,
        totalRequests: 4,
        freshInputTokens: 1410,
        cachedInputTokens: 300,
        cacheWriteTokens: 100,
        outputTokens: 460,
        tokensProcessed: 2270,
        cacheHitRate: 300 / 1710,
        unpricedCount: 4,
      });

      const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
      expect(await service.summary(summaryCompanyId, { from: hourAgo })).toEqual({
        companyId: summaryCompanyId,
        totalRequests: 3,
        freshInputTokens: 1400,
        cachedInputTokens: 300,
        cacheWriteTokens: 100,
        outputTokens: 450,
        tokensProcessed: 2250,
        cacheHitRate: 300 / 1700,
        unpricedCount: 3,
      });
      // A company with no rows aggregates to the zero state with a null rate.
      expect(await service.summary(randomUUID())).toEqual({
        companyId: expect.any(String),
        totalRequests: 0,
        freshInputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
        tokensProcessed: 0,
        cacheHitRate: null,
        unpricedCount: 0,
      });
    });

    it("returns a null cache hit rate when no observed request carries prompt input", async () => {
      const otherRunId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: otherRunId,
        companyId: summaryOtherCompanyId,
        agentId: summaryOtherAgentId,
        invocationSource: "on_demand",
        status: "running",
        contextSnapshot: {},
      });
      const requestId = randomUUID();
      const startedAtMs = Date.now() - 60_000;
      await usageRequestLogService(db).recordForRun(
        { companyId: summaryOtherCompanyId, runId: otherRunId, agentId: null, issueId: null },
        usageEvent(requestId, { startedAtMs, endedAtMs: startedAtMs + 100, ttftMs: 10, usage: null }),
      );
      const summary = await usageRequestLogService(db).summary(summaryOtherCompanyId);
      expect(summary.totalRequests).toBe(1);
      expect(summary.cacheHitRate).toBeNull();
      expect(summary.tokensProcessed).toBe(0);
    });
  });

  it("persists the usage_missing flag of include_usage fallbacks in metadata", async () => {
    const service = usageRequestLogService(db);
    const requestId = randomUUID();
    expect(await service.recordForRun(
      { companyId, runId, agentId, issueId },
      usageEvent(requestId, { usageMissing: true, usage: null }),
    )).toBe(true);
    const [row] = await db.select().from(usageRequestLogs)
      .where(and(eq(usageRequestLogs.companyId, companyId), eq(usageRequestLogs.requestId, requestId)));
    expect(row.metadata).toEqual({ usageMissing: true });
  });
});
