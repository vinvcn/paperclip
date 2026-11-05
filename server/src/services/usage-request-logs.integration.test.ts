import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  agents,
  companies,
  costEvents,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
  projects,
  usageRequestLogs,
} from "@paperclipai/db";
import { centsToUnits } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { PROVIDER_REQUEST_USAGE_KIND, usageProviderAndBillerFromModel } from "../vendor/paperclip-runner/index.js";
import {
  allocateRunCosts,
  sweepRunUsageRequestLogEvents,
  usageRequestLogService,
  type UsageRequestFilters,
} from "./usage-request-logs.js";

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
    expect(latest.rows).toHaveLength(2);
    expect(latest.rows[0]!.occurredAt.getTime()).toBeGreaterThan(latest.rows[1]!.occurredAt.getTime());
    expect(await service.latest(otherCompanyId, 20).then((page) => page.rows)).toHaveLength(1);
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

      // tokensProcessed = fresh + output + cached input; cache write is a
      // billed-token input for cost allocation, not part of processed tokens.
      const summary = await service.summary(summaryCompanyId);
      expect(summary).toMatchObject({
        companyId: summaryCompanyId,
        totalRequests: 4,
        freshInputTokens: 1410,
        cachedInputTokens: 300,
        cacheWriteTokens: 100,
        outputTokens: 460,
        tokensProcessed: 2170,
        cacheHitRate: 300 / 1710,
        unpricedCount: 4,
      });
      // The series follows the summary's window (no from/to -> the extent of
      // the matching rows), so its bucket sums equal the card totals.
      expect(summary.series.reduce((n, point) => n + point.requests, 0)).toBe(4);
      expect(summary.series.reduce((n, point) => n + point.tokens, 0)).toBe(2170);

      const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
      const windowed = await service.summary(summaryCompanyId, { from: hourAgo });
      expect(windowed).toMatchObject({
        companyId: summaryCompanyId,
        totalRequests: 3,
        freshInputTokens: 1400,
        cachedInputTokens: 300,
        cacheWriteTokens: 100,
        outputTokens: 450,
        tokensProcessed: 2150,
        cacheHitRate: 300 / 1700,
        unpricedCount: 3,
      });
      expect(windowed.series.reduce((n, point) => n + point.requests, 0)).toBe(3);
      expect(windowed.series.reduce((n, point) => n + point.tokens, 0)).toBe(2150);
      // A company with no rows aggregates to the zero state with a null rate.
      expect(await service.summary(randomUUID())).toEqual({
        companyId: expect.any(String),
        totalRequests: 0,
        totalCostCents: "0",
        freshInputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
        tokensProcessed: 0,
        cacheHitRate: null,
        unpricedCount: 0,
        series: [],
        facets: { apps: [], providers: [], models: [], modelsTruncated: false },
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

  describe("summary series bucketing", () => {
    // Spec Metrics: fresh input + output + cached input = (1200 - 300) + 450 + 300.
    const PROCESSED_TOKENS = 1650;
    const processedUsage = { inputTokens: 1200, cachedInputTokens: 300, cacheWriteTokens: 100, outputTokens: 450 };
    const createdCompanyIds: string[] = [];

    /**
     * One isolated company per test: bucketing windows overlap between the
     * DST cases, so rows from one test must never be visible to another's
     * series.
     */
    async function freshSeriesCompany() {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const runId = randomUUID();
      await db.insert(companies).values({
        id: companyId,
        name: "Usage Series",
        // Unique per company: issue_prefix has a unique index and these
        // companies are created per test.
        issuePrefix: companyId.replaceAll("-", "").slice(0, 4).toUpperCase(),
        requireBoardApprovalForNewAgents: false,
        defaultResponsibleUserId: "responsible-user",
      });
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "UsageSeries",
        role: "engineer",
        status: "active",
        adapterType: "paperclip_runner",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        invocationSource: "on_demand",
        status: "running",
        contextSnapshot: {},
      });
      createdCompanyIds.push(companyId);
      return { companyId, runId };
    }

    afterAll(async () => {
      for (const companyId of createdCompanyIds) {
        await db.delete(usageRequestLogs).where(eq(usageRequestLogs.companyId, companyId));
        await db.delete(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
        await db.delete(agents).where(eq(agents.companyId, companyId));
        await db.delete(companies).where(eq(companies.id, companyId));
      }
    });

    async function seriesRow(
      ids: { companyId: string; runId: string },
      occurredAt: Date,
      usage: Record<string, number> = processedUsage,
    ) {
      await db.insert(usageRequestLogs).values({
        companyId: ids.companyId,
        runId: ids.runId,
        app: "opencode",
        provider: "paperclip",
        biller: "paperclip",
        model: "openai/gpt-5.2",
        inputTokens: usage.inputTokens ?? null,
        cachedInputTokens: usage.cachedInputTokens ?? null,
        cacheWriteTokens: usage.cacheWriteTokens ?? null,
        outputTokens: usage.outputTokens ?? null,
        requestId: randomUUID(),
        occurredAt,
      });
    }

    function bucketTokens(summary: { series: { tokens: number; requests: number }[] }) {
      return {
        tokens: summary.series.reduce((n, point) => n + point.tokens, 0),
        requests: summary.series.reduce((n, point) => n + point.requests, 0),
      };
    }

    it("buckets an hourly series across a DST spring-forward in the viewer timezone", async () => {
      // America/New_York jumps 02:00 EST -> 03:00 EDT on 2026-03-08, so the
      // wall-clock 02:00 hour does not exist. The window is local 00:00-12:00.
      const ids = await freshSeriesCompany();
      await seriesRow(ids, new Date("2026-03-08T06:30:00Z")); // 01:30 EST
      await seriesRow(ids, new Date("2026-03-08T07:30:00Z")); // 03:30 EDT
      const summary = await usageRequestLogService(db).summary(ids.companyId, {
        from: new Date("2026-03-08T05:00:00Z"), // 00:00 EST
        to: new Date("2026-03-08T16:00:00Z"), // 12:00 EDT
      }, "America/New_York");
      expect(summary.series).toHaveLength(12);
      expect(summary.series[0]).toEqual({ bucketStart: "2026-03-08T05:00:00.000Z", tokens: 0, requests: 0 });
      // Wall 01:00 EST is 06:00Z and wall 03:00 EDT is 07:00Z: the skipped
      // wall 02:00 hour is not a bucket, yet the bucket starts stay unique.
      expect(summary.series[1]).toEqual({ bucketStart: "2026-03-08T06:00:00.000Z", tokens: PROCESSED_TOKENS, requests: 1 });
      expect(summary.series[2]).toEqual({ bucketStart: "2026-03-08T07:00:00.000Z", tokens: PROCESSED_TOKENS, requests: 1 });
      expect(summary.series.slice(3).every((point) => point.tokens === 0 && point.requests === 0)).toBe(true);
      expect(bucketTokens(summary)).toEqual({ tokens: summary.tokensProcessed, requests: summary.totalRequests });
    });

    it("merges the repeated wall hour of a DST fall-back into one bucket", async () => {
      // America/New_York repeats wall 01:00 on 2026-11-01 (01:00 EDT then
      // 01:00 EST). Both rows truncate to the same wall hour, so a single
      // bucket holds them while the bucket sums still match the cards.
      const ids = await freshSeriesCompany();
      await seriesRow(ids, new Date("2026-11-01T05:30:00Z")); // 01:30 EDT
      await seriesRow(ids, new Date("2026-11-01T06:30:00Z")); // 01:30 EST
      const summary = await usageRequestLogService(db).summary(ids.companyId, {
        from: new Date("2026-11-01T04:00:00Z"), // 00:00 EDT
        to: new Date("2026-11-02T04:00:00Z"), // 23:00 EST
      }, "America/New_York");
      const withRequests = summary.series.filter((point) => point.requests > 0);
      expect(withRequests).toHaveLength(1);
      expect(withRequests[0]).toEqual({ bucketStart: "2026-11-01T06:00:00.000Z", tokens: 2 * PROCESSED_TOKENS, requests: 2 });
      expect(bucketTokens(summary)).toEqual({ tokens: summary.tokensProcessed, requests: summary.totalRequests });
    });

    it("switches to local-midnight day buckets with zero fill for multi-day windows", async () => {
      // Asia/Shanghai (UTC+8, no DST): a row at 16:30Z is already the next
      // local day, so it belongs to that day's local-midnight bucket rather
      // than the UTC day bucket it would land in without the timezone.
      const ids = await freshSeriesCompany();
      await seriesRow(ids, new Date("2026-11-02T16:30:00Z")); // Nov 3, 00:30 +08
      await seriesRow(ids, new Date("2026-11-04T08:00:00Z")); // Nov 4, 16:00 +08
      const summary = await usageRequestLogService(db).summary(ids.companyId, {
        from: new Date("2026-10-31T16:00:00Z"), // Nov 1, 00:00 +08
        to: new Date("2026-11-04T16:00:00Z"), // Nov 5, 00:00 +08
      }, "Asia/Shanghai");
      expect(summary.series).toHaveLength(5); // local Nov 1 .. Nov 5
      expect(summary.series[0]).toEqual({ bucketStart: "2026-10-31T16:00:00.000Z", tokens: 0, requests: 0 });
      expect(summary.series[2]).toEqual({ bucketStart: "2026-11-02T16:00:00.000Z", tokens: PROCESSED_TOKENS, requests: 1 }); // local Nov 3
      expect(summary.series[3]).toEqual({ bucketStart: "2026-11-03T16:00:00.000Z", tokens: PROCESSED_TOKENS, requests: 1 }); // local Nov 4
      expect(summary.series[4]).toEqual({ bucketStart: "2026-11-04T16:00:00.000Z", tokens: 0, requests: 0 }); // zero-filled day
      expect(bucketTokens(summary)).toEqual({ tokens: summary.tokensProcessed, requests: summary.totalRequests });
    });

    it("uses hour buckets up to a 48h window and day buckets beyond it", async () => {
      const ids = await freshSeriesCompany();
      const exactly48h = await usageRequestLogService(db).summary(ids.companyId, {
        from: new Date("2026-03-08T00:00:00Z"),
        to: new Date("2026-03-10T00:00:00Z"),
      }, "UTC");
      expect(exactly48h.series).toHaveLength(49);
      expect(new Date(exactly48h.series[1]!.bucketStart).getTime() - new Date(exactly48h.series[0]!.bucketStart).getTime()).toBe(3_600_000);

      const justOver48h = await usageRequestLogService(db).summary(ids.companyId, {
        from: new Date("2026-03-08T00:00:00Z"),
        to: new Date("2026-03-10T00:00:00.001Z"),
      }, "UTC");
      expect(justOver48h.series).toHaveLength(3); // day-aligned, zero-filled
      expect(new Date(justOver48h.series[1]!.bucketStart).getTime() - new Date(justOver48h.series[0]!.bucketStart).getTime()).toBe(24 * 3_600_000);
    });

    it("returns an empty series when there is neither a window nor rows", async () => {
      const summary = await usageRequestLogService(db).summary(randomUUID());
      expect(summary.series).toEqual([]);
    });
  });

  describe("request filters and facets", () => {
    let filterCompanyId: string;
    const createdCompanyIds: string[] = [];

    beforeAll(async () => {
      filterCompanyId = randomUUID();
      const agentId = randomUUID();
      const runId = randomUUID();
      await db.insert(companies).values({
        id: filterCompanyId,
        name: "Usage Filters",
        issuePrefix: filterCompanyId.replaceAll("-", "").slice(0, 4).toUpperCase(),
        requireBoardApprovalForNewAgents: false,
        defaultResponsibleUserId: "responsible-user",
      });
      await db.insert(agents).values({
        id: agentId,
        companyId: filterCompanyId,
        name: "UsageFilters",
        role: "engineer",
        status: "active",
        adapterType: "paperclip_runner",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId: filterCompanyId,
        agentId,
        invocationSource: "on_demand",
        status: "running",
        contextSnapshot: {},
      });
      createdCompanyIds.push(filterCompanyId);

      // Seven rows spanning every filter dimension. The last one sits 3h in
      // the past so a 1h window can prove facets drop values without rows.
      // The 302 and 600 rows stand in for the statuses the proxy still
      // records outside 2xx/4xx/5xx: a redirect and a transport error —
      // both belong to the "other" class, neither to success/4xx/5xx.
      const rows = [
        { app: "opencode", provider: "openrouter", model: "openai/gpt-5.2", httpStatus: 200, inputTokens: 120, outputTokens: 80, ageMinutes: 10 },
        { app: "opencode", provider: "anthropic", model: "anthropic/claude-sonnet-4-5", httpStatus: 429, inputTokens: null, outputTokens: null, ageMinutes: 20 },
        { app: "codex", provider: "openrouter", model: "openai/gpt-5.2", httpStatus: 503, inputTokens: null, outputTokens: null, ageMinutes: 30 },
        { app: "opencode", provider: "anthropic", model: "anthropic/claude-haiku-4-5", httpStatus: null, inputTokens: null, outputTokens: null, ageMinutes: 40 },
        { app: "legacy-cli", provider: "openrouter", model: "openai/gpt-5.2-mini", httpStatus: 200, inputTokens: null, outputTokens: null, ageMinutes: 180 },
        { app: "opencode", provider: "anthropic", model: "anthropic/claude-sonnet-4-5", httpStatus: 302, inputTokens: null, outputTokens: null, ageMinutes: 5 },
        { app: "codex", provider: "openrouter", model: "openai/gpt-5.2", httpStatus: 600, inputTokens: null, outputTokens: null, ageMinutes: 6 },
      ] as const;
      for (const row of rows) {
        await db.insert(usageRequestLogs).values({
          companyId: filterCompanyId,
          runId,
          app: row.app,
          provider: row.provider,
          biller: row.provider,
          model: row.model,
          inputTokens: row.inputTokens,
          cachedInputTokens: null,
          cacheWriteTokens: null,
          outputTokens: row.outputTokens,
          httpStatus: row.httpStatus,
          requestId: randomUUID(),
          occurredAt: new Date(Date.now() - row.ageMinutes * 60_000),
        });
      }
    });

    afterAll(async () => {
      for (const companyId of createdCompanyIds) {
        await db.delete(usageRequestLogs).where(eq(usageRequestLogs.companyId, companyId));
        await db.delete(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
        await db.delete(agents).where(eq(agents.companyId, companyId));
        await db.delete(companies).where(eq(companies.id, companyId));
      }
    });

    it("lists the window's apps, providers and models with request counts", async () => {
      const summary = await usageRequestLogService(db).summary(filterCompanyId, { from: new Date(Date.now() - 60 * 60_000) });
      // Facets are ordered by request volume, then by value.
      expect(summary.facets.apps).toEqual([
        { value: "opencode", requests: 4 },
        { value: "codex", requests: 2 },
      ]);
      expect(summary.facets.providers).toEqual([
        { value: "anthropic", requests: 3 },
        { value: "openrouter", requests: 3 },
      ]);
      expect(summary.facets.models).toEqual([
        { value: "openai/gpt-5.2", requests: 3 },
        { value: "anthropic/claude-sonnet-4-5", requests: 2 },
        { value: "anthropic/claude-haiku-4-5", requests: 1 },
      ]);
      expect(summary.facets.modelsTruncated).toBe(false);
    });

    it("excludes values without rows in the window from the facets", async () => {
      const windowed = await usageRequestLogService(db).summary(filterCompanyId, { from: new Date(Date.now() - 60 * 60_000) });
      // The legacy-cli row is three hours old: no row in this window, no facet.
      expect(windowed.facets.apps.some((facet) => facet.value === "legacy-cli")).toBe(false);
      // Without the window bound the full history does have the value.
      const all = await usageRequestLogService(db).summary(filterCompanyId);
      expect(all.facets.apps).toContainEqual({ value: "legacy-cli", requests: 1 });
    });

    it("keeps facets describing the unfiltered window while filters narrow the totals", async () => {
      const filtered = await usageRequestLogService(db).summary(filterCompanyId, undefined, "UTC", { app: "opencode" });
      expect(filtered.totalRequests).toBe(4);
      // Chips must not disappear once selected: facets still show every app
      // with rows, including the ones the filter excludes.
      expect(filtered.facets.apps).toEqual([
        { value: "opencode", requests: 4 },
        { value: "codex", requests: 2 },
        { value: "legacy-cli", requests: 1 },
      ]);
      expect(filtered.facets.providers).toHaveLength(2);
    });

    it.each<[UsageRequestFilters, number]>([
      [{ app: "opencode" }, 4],
      [{ provider: "openrouter" }, 4],
      [{ model: "openai/gpt-5.2" }, 3],
      [{ status: "success" }, 2],
      [{ status: "client_error" }, 1],
      [{ status: "server_error" }, 1],
      [{ status: "other" }, 3],
      [{ app: "opencode", status: "success" }, 1],
      [{ app: "codex", status: "success" }, 0],
    ])("narrows the summary totals, series and log list with the same filters %j", async (filters, expected) => {
      const service = usageRequestLogService(db);
      const summary = await service.summary(filterCompanyId, undefined, "UTC", filters);
      expect(summary.totalRequests).toBe(expected);
      // The series answers to the same WHERE as the cards.
      expect(summary.series.reduce((n, point) => n + point.requests, 0)).toBe(expected);
      // And so does the log list.
      const rows = (await service.latest(filterCompanyId, 20, filters)).rows;
      expect(rows).toHaveLength(expected);
      if (filters.app) expect(rows.every((row) => row.app === filters.app)).toBe(true);
      if (filters.provider) expect(rows.every((row) => row.provider === filters.provider)).toBe(true);
      if (filters.model) expect(rows.every((row) => row.model === filters.model)).toBe(true);
    });

    it("narrows the token figures with the filters", async () => {
      const summary = await usageRequestLogService(db).summary(filterCompanyId, undefined, "UTC", { status: "success" });
      // Two 2xx rows, but only one carries usage: 120 input + 80 output.
      expect(summary.totalRequests).toBe(2);
      expect(summary.tokensProcessed).toBe(200);
    });

    it("sorts null, redirect and transport-error statuses into other, never success", async () => {
      const other = await usageRequestLogService(db).summary(filterCompanyId, undefined, "UTC", { status: "other" });
      expect(other.totalRequests).toBe(3);
      const rows = (await usageRequestLogService(db).latest(filterCompanyId, 20, { status: "other" })).rows;
      // The proxy also records redirects (302) and transport errors (600);
      // with the null-status row they form "other", never success/4xx/5xx.
      expect([...rows.map((row) => row.httpStatus)].sort((a, b) => (a ?? -1) - (b ?? -1))).toEqual([null, 302, 600]);
    });

    it("accepts a from/to window on the log list", async () => {
      const windowed = await usageRequestLogService(db).latest(filterCompanyId, 20, { range: { from: new Date(Date.now() - 60 * 60_000) } });
      expect(windowed.rows).toHaveLength(6); // the 3h-old legacy row is out
    });
  });

  describe("keyset pagination", () => {
    const createdCompanyIds: string[] = [];

    /** One isolated company + run per test: page walks must never see another case's rows. */
    async function freshPageCompany() {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const runId = randomUUID();
      await db.insert(companies).values({
        id: companyId,
        name: "Usage Paging",
        issuePrefix: companyId.replaceAll("-", "").slice(0, 4).toUpperCase(),
        requireBoardApprovalForNewAgents: false,
        defaultResponsibleUserId: "responsible-user",
      });
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "UsagePaging",
        role: "engineer",
        status: "active",
        adapterType: "paperclip_runner",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        invocationSource: "on_demand",
        status: "running",
        contextSnapshot: {},
      });
      createdCompanyIds.push(companyId);
      return { companyId, runId };
    }

    afterAll(async () => {
      for (const companyId of createdCompanyIds) {
        await db.delete(usageRequestLogs).where(eq(usageRequestLogs.companyId, companyId));
        await db.delete(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
        await db.delete(agents).where(eq(agents.companyId, companyId));
        await db.delete(companies).where(eq(companies.id, companyId));
      }
    });

    /** One request row at an exact instant, keyed by the minute offset so tests can name them. */
    async function row(ids: { companyId: string; runId: string }, minuteOffset: number, overrides: Record<string, unknown> = {}) {
      const requestId = randomUUID();
      await db.insert(usageRequestLogs).values({
        companyId: ids.companyId,
        runId: ids.runId,
        app: "opencode",
        provider: "openrouter",
        biller: "openrouter",
        model: "openai/gpt-5.2",
        requestId,
        occurredAt: new Date(Date.parse("2026-11-04T12:00:00Z") + minuteOffset * 60_000),
        ...overrides,
      });
      return requestId;
    }

    it("walks every row exactly once across pages: no duplicates, no gaps", async () => {
      const ids = await freshPageCompany();
      await row(ids, 10);
      await row(ids, 20);
      await row(ids, 30);
      await row(ids, 30); // same occurred_at: the id tiebreak must not skip or repeat it
      await row(ids, 40);
      await row(ids, 50);

      const service = usageRequestLogService(db);
      const seen: string[] = [];
      let after: { occurredAt: Date; id: string } | undefined;
      let pages = 0;
      while (pages < 10) {
        const page = await service.latest(ids.companyId, 2, after ? { after } : {});
        seen.push(...page.rows.map((row) => row.requestId));
        if (!page.nextCursor) break;
        const separator = page.nextCursor.indexOf(",");
        after = { occurredAt: new Date(page.nextCursor.slice(0, separator)), id: page.nextCursor.slice(separator + 1) };
        pages += 1;
      }
      expect(seen).toHaveLength(6);
      expect(new Set(seen).size).toBe(6); // no duplicates across pages
      // Newest first throughout: ties share a timestamp and stay ordered by id.
      const rows = await db.select().from(usageRequestLogs).where(eq(usageRequestLogs.companyId, ids.companyId));
      const expectedOrder = rows
        .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime() || (a.id < b.id ? 1 : -1))
        .map((row) => row.requestId);
      expect(seen).toEqual(expectedOrder);
    });

    it("keeps a cursor-anchored page stable when newer rows arrive mid-read", async () => {
      const ids = await freshPageCompany();
      await row(ids, 1);
      await row(ids, 2);
      await row(ids, 3);
      const service = usageRequestLogService(db);
      const firstPage = await service.latest(ids.companyId, 2);
      expect(firstPage.rows.map((row) => row.occurredAt.getUTCMinutes())).toEqual([3, 2]);
      expect(firstPage.nextCursor).toBe(`${firstPage.rows[1]!.occurredAt.toISOString()},${firstPage.rows[1]!.id}`);

      // Five new requests land while the reader is still on page one.
      await row(ids, 61);
      await row(ids, 62);
      await row(ids, 63);
      await row(ids, 64);
      await row(ids, 65);

      const secondPage = await service.latest(ids.companyId, 2, { after: { occurredAt: firstPage.rows[1]!.occurredAt, id: firstPage.rows[1]!.id } });
      // The cursor anchors the page: the new rows never push into it.
      expect(secondPage.rows.map((row) => row.occurredAt.getUTCMinutes())).toEqual([1]);
      expect(secondPage.nextCursor).toBeNull();
      // And the total reflects the matching set, not the page.
      expect(secondPage.total).toBe(8);
    });

    it("returns the total matching count independent of the cursor position", async () => {
      const ids = await freshPageCompany();
      for (const minute of [1, 2, 3]) await row(ids, minute);
      const service = usageRequestLogService(db);
      const firstPage = await service.latest(ids.companyId, 2);
      expect(firstPage.total).toBe(3);
      const lastPage = await service.latest(ids.companyId, 2, {
        after: { occurredAt: firstPage.rows[1]!.occurredAt, id: firstPage.rows[1]!.id },
      });
      expect(lastPage.rows.length).toBeLessThanOrEqual(2);
      expect(lastPage.total).toBe(3);
    });

    it("combines the keyset cursor with the request filters", async () => {
      const ids = await freshPageCompany();
      await row(ids, 100, { httpStatus: 500 });
      await row(ids, 101, { httpStatus: 500 });
      await row(ids, 102, { httpStatus: 500 });
      const service = usageRequestLogService(db);
      const page = await service.latest(ids.companyId, 2, { status: "server_error" });
      expect(page.rows).toHaveLength(2);
      expect(page.total).toBe(3);
      expect(page.nextCursor).toBe(`${page.rows[1]!.occurredAt.toISOString()},${page.rows[1]!.id}`);
      const next = await service.latest(ids.companyId, 2, {
        status: "server_error",
        after: { occurredAt: page.rows[1]!.occurredAt, id: page.rows[1]!.id },
      });
      expect(next.rows).toHaveLength(1);
      expect(next.total).toBe(3);
      expect(next.nextCursor).toBeNull();
    });
  });

  describe("model facet truncation", () => {
    let facetsCompanyId: string, facetsAgentId: string, facetsRunId: string;
    const createdCompanyIds: string[] = [];

    beforeAll(async () => {
      facetsCompanyId = randomUUID();
      facetsAgentId = randomUUID();
      facetsRunId = randomUUID();
      await db.insert(companies).values({
        id: facetsCompanyId,
        name: "Usage Facets",
        issuePrefix: facetsCompanyId.replaceAll("-", "").slice(0, 4).toUpperCase(),
        requireBoardApprovalForNewAgents: false,
        defaultResponsibleUserId: "responsible-user",
      });
      await db.insert(agents).values({
        id: facetsAgentId,
        companyId: facetsCompanyId,
        name: "UsageFacets",
        role: "engineer",
        status: "active",
        adapterType: "paperclip_runner",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
      await db.insert(heartbeatRuns).values({
        id: facetsRunId,
        companyId: facetsCompanyId,
        agentId: facetsAgentId,
        invocationSource: "on_demand",
        status: "running",
        contextSnapshot: {},
      });
      createdCompanyIds.push(facetsCompanyId);
      // One more distinct model than the facet cap: the response must bound
      // the list instead of streaming a high-cardinality model namespace.
      for (let i = 0; i < 55; i += 1) {
        await db.insert(usageRequestLogs).values({
          companyId: facetsCompanyId,
          runId: facetsRunId,
          app: "opencode",
          provider: "openrouter",
          biller: "openrouter",
          model: `vendor/model-${i}`,
          requestId: randomUUID(),
          occurredAt: new Date(Date.parse("2026-11-04T12:00:00Z") + i * 1000),
        });
      }
    });

    afterAll(async () => {
      for (const companyId of createdCompanyIds) {
        await db.delete(usageRequestLogs).where(eq(usageRequestLogs.companyId, companyId));
        await db.delete(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
        await db.delete(agents).where(eq(agents.companyId, companyId));
        await db.delete(companies).where(eq(companies.id, companyId));
      }
    });

    it("caps the model facet list at 50 and flags the truncation", async () => {
      const summary = await usageRequestLogService(db).summary(facetsCompanyId);
      expect(summary.facets.models).toHaveLength(50);
      expect(summary.facets.modelsTruncated).toBe(true);
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

  describe("run cost allocation", () => {
    const model = "openrouter/anthropic/claude-sonnet-4";
    const otherModel = "openai/gpt-5.2";
    const createdCompanyIds: string[] = [];

    afterAll(async () => {
      for (const companyId of createdCompanyIds) {
        await db.delete(usageRequestLogs).where(eq(usageRequestLogs.companyId, companyId));
        await db.delete(costEvents).where(eq(costEvents.companyId, companyId));
        await db.delete(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
        await db.delete(agents).where(eq(agents.companyId, companyId));
        await db.delete(companies).where(eq(companies.id, companyId));
      }
    });

    /** One isolated company + succeeded run per test: allocation state must never leak between cases. */
    async function freshAllocationRun() {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const runId = randomUUID();
      await db.insert(companies).values({
        id: companyId,
        name: "Usage Allocation",
        issuePrefix: companyId.replaceAll("-", "").slice(0, 4).toUpperCase(),
        requireBoardApprovalForNewAgents: false,
        defaultResponsibleUserId: "responsible-user",
      });
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "UsageAllocation",
        role: "engineer",
        status: "idle",
        adapterType: "paperclip_runner",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        invocationSource: "on_demand",
        status: "succeeded",
        contextSnapshot: {},
      });
      createdCompanyIds.push(companyId);
      return { companyId, agentId, runId };
    }

    /** A cost_events receipt row for the run, exactly as accountRunCost writes them. */
    async function receipt(
      ids: { companyId: string; agentId: string; runId: string },
      receiptModel: string,
      costCents: number,
      overrides: Partial<typeof costEvents.$inferInsert> = {},
    ) {
      await db.insert(costEvents).values({
        companyId: ids.companyId,
        agentId: ids.agentId,
        heartbeatRunId: ids.runId,
        provider: "openrouter",
        biller: "openrouter",
        model: receiptModel,
        billingType: "metered_api",
        costStatus: "reported",
        costCents,
        idempotencyKey: `heartbeat:${ids.runId}:${randomUUID()}`,
        occurredAt: new Date(),
        ...overrides,
      });
    }

    async function requestRow(
      ids: { companyId: string; runId: string },
      rowModel: string,
      tokens: { input?: number | null; cached?: number | null; write?: number | null; output?: number | null } = {},
    ) {
      await db.insert(usageRequestLogs).values({
        companyId: ids.companyId,
        runId: ids.runId,
        app: "opencode",
        provider: "openrouter",
        biller: "openrouter",
        model: rowModel,
        inputTokens: tokens.input ?? null,
        cachedInputTokens: tokens.cached ?? null,
        cacheWriteTokens: tokens.write ?? null,
        outputTokens: tokens.output ?? null,
        requestId: randomUUID(),
        occurredAt: new Date(),
      });
    }

    async function pricedRows(companyId: string) {
      const rows = await db.select().from(usageRequestLogs).where(eq(usageRequestLogs.companyId, companyId));
      return new Map(rows.map((row) => [row.requestId, row]));
    }

    it("distributes a multi-event receipt across a run's requests and sums exactly to it", async () => {
      const ids = await freshAllocationRun();
      await requestRow(ids, model, { input: 1000, cached: 200, write: 50, output: 100 }); // billed 1150
      await requestRow(ids, model, { input: 500, output: 30 });                            // billed 530
      await requestRow(ids, model, { input: 0, output: 7 });                               // billed 7
      await requestRow(ids, otherModel, { input: 400, output: 50 });                       // billed 450
      await receipt(ids, model, 1.5);
      await receipt(ids, model, 0.3333333);
      await receipt(ids, otherModel, 0.5);

      const priced = await allocateRunCosts(db, ids.companyId, ids.runId);
      expect(priced).toBe(4);
      const rows = [...(await pricedRows(ids.companyId)).values()];
      const modelRows = rows.filter((row) => row.model === model);
      const otherRows = rows.filter((row) => row.model === otherModel);
      // The (run, model) receipt is fully consumed by that model's rows and
      // nothing else: sum of allocated cents === sum of receipt cents, exactly.
      const sumUnits = (list: typeof rows) => list.reduce((sum, row) => sum + centsToUnits(row.costCents!), 0n);
      expect(sumUnits(modelRows)).toBe(centsToUnits("1.8333333"));
      expect(sumUnits(otherRows)).toBe(centsToUnits("0.5"));
      for (const row of rows) {
        expect(row.costCents).not.toBeNull();
        expect(row.costStatus).toBe("priced");
      }
      // Idempotent: a repeated call prices nothing anew.
      expect(await allocateRunCosts(db, ids.companyId, ids.runId)).toBe(0);
    });

    it("splits a single receipt between two requests by billed token share", async () => {
      const ids = await freshAllocationRun();
      // Billed tokens = fresh input + cache write + output + cached input,
      // which is not the Tokens Processed formula (cache write counts).
      await requestRow(ids, model, { input: 1200, cached: 300, write: 100, output: 450 }); // billed 1750
      await requestRow(ids, model, { input: 250, output: 0 });                             // billed 250
      await receipt(ids, model, 2);

      expect(await allocateRunCosts(db, ids.companyId, ids.runId)).toBe(2);
      const rows = [...(await pricedRows(ids.companyId)).values()].sort((a, b) => a.inputTokens! - b.inputTokens!);
      expect(rows[0]!.costCents).toBe("0.2500000");
      expect(rows[0]!.costStatus).toBe("priced");
      expect(rows[1]!.costCents).toBe("1.7500000");
    });

    it("leaves receipt-less and token-less rows unpriced while the summary separates them", async () => {
      const ids = await freshAllocationRun();
      await requestRow(ids, model, { input: 800, cached: 100, write: 20, output: 60 }); // priced
      await requestRow(ids, model, { input: null, cached: null, write: null, output: null }); // usage never observed
      await requestRow(ids, model, { input: 0, cached: 0, write: 0, output: 0 });       // no allocation basis
      await requestRow(ids, otherModel, { input: 900, output: 90 });                    // no receipt for this model
      await receipt(ids, model, 1);

      expect(await allocateRunCosts(db, ids.companyId, ids.runId)).toBe(1);
      const rows = await pricedRows(ids.companyId);
      const priced = [...rows.values()].find((row) => row.costStatus === "priced");
      expect(priced).toMatchObject({ model, costCents: "1.0000000" });
      for (const row of rows.values()) {
        if (row !== priced) {
          expect(row.costCents).toBeNull();
          expect(row.costStatus).toBe("unpriced");
        }
      }
      // Total Cost counts only priced rows; the badge counts the unpriced ones.
      const summary = await usageRequestLogService(db).summary(ids.companyId);
      expect(summary.totalCostCents).toBe("1.0000000");
      expect(summary.unpricedCount).toBe(3);
    });

    it("prices each run once: rows arriving after allocation stay unpriced", async () => {
      const ids = await freshAllocationRun();
      await requestRow(ids, model, { input: 600, output: 40 });
      await receipt(ids, model, 0.8);
      expect(await allocateRunCosts(db, ids.companyId, ids.runId)).toBe(1);

      // A provider_request record that lands after the ledger closed (late
      // sweep, retry delivery) must not reopen it.
      await requestRow(ids, model, { input: 999, output: 999 });
      expect(await allocateRunCosts(db, ids.companyId, ids.runId)).toBe(0);
      const rows = await pricedRows(ids.companyId);
      expect(rows.size).toBe(2);
      const late = [...rows.values()].find((row) => row.inputTokens === 999)!;
      expect(late.costCents).toBeNull();
      expect(late.costStatus).toBe("unpriced");
    });

    it("keeps every row unpriced when the run has no receipt or only an unpriced one", async () => {
      const failed = await freshAllocationRun();
      await requestRow(failed, model, { input: 500, output: 50 });
      // A failed run without a receipt: nothing to allocate.
      expect(await allocateRunCosts(db, failed.companyId, failed.runId)).toBe(0);

      const unpriced = await freshAllocationRun();
      await requestRow(unpriced, model, { input: 500, output: 50 });
      await receipt(unpriced, model, 0, { costStatus: "unpriced" });
      // An unpriced receipt carries no money; allocating its zero would fake
      // precision the ledger does not have.
      expect(await allocateRunCosts(db, unpriced.companyId, unpriced.runId)).toBe(0);
      for (const ids of [failed, unpriced]) {
        for (const row of (await pricedRows(ids.companyId)).values()) {
          expect(row.costCents).toBeNull();
          expect(row.costStatus).toBe("unpriced");
        }
      }
    });
  });
});
