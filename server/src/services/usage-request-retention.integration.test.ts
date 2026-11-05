import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  agents,
  companies,
  costEvents,
  createDb,
  heartbeatRuns,
  usageRequestLogs,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { PROVIDER_REQUEST_USAGE_KIND, usageProviderAndBillerFromModel } from "../vendor/paperclip-runner/index.js";
import { logger } from "../middleware/logger.js";
import { DELIVERY_QUEUES, subscribeDeliveryWork } from "./delivery-work-notifications.js";
import { usageRequestLogService } from "./usage-request-logs.js";
import {
  USAGE_REQUEST_LOG_RETENTION_MS,
  USAGE_REQUEST_LOG_SWEEP_CHUNK,
  usageRequestRetentionService,
} from "./usage-request-retention.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres usage-request-retention tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("usage request log retention sweep", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string, agentId: string, runId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-usage-request-retention-");
    db = createDb(tempDb.connectionString, { maxConnections: 4 });
    companyId = randomUUID();
    agentId = randomUUID();
    runId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Usage Retention",
      issuePrefix: "USGR",
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "UsageRetention",
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
  }, 120_000);

  afterEach(async () => {
    await db.delete(usageRequestLogs);
    await db.delete(costEvents);
  });

  afterAll(async () => {
    await db?.delete(heartbeatRuns);
    await db?.delete(agents);
    await db?.delete(companies);
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  });

  /** One request row at an exact instant, keyed by request id for survivor assertions. */
  async function insertRow(occurredAt: Date, overrides: Record<string, unknown> = {}) {
    const requestId = randomUUID();
    await db.insert(usageRequestLogs).values({
      companyId,
      runId,
      app: "opencode",
      provider: "openrouter",
      biller: "openrouter",
      model: "openai/gpt-5.2",
      requestId,
      occurredAt,
      ...overrides,
    });
    return requestId;
  }

  async function survivingRequestIds() {
    const rows = await db.select({ requestId: usageRequestLogs.requestId }).from(usageRequestLogs);
    return rows.map((row) => row.requestId).sort();
  }

  /** Two cost_events receipts standing guard: the sweep must never touch the ledger. */
  async function insertCostReceipt(costCents: number, occurredAt: Date) {
    const id = randomUUID();
    await db.insert(costEvents).values({
      id,
      companyId,
      agentId,
      heartbeatRunId: runId,
      provider: "openrouter",
      biller: "openrouter",
      model: "openai/gpt-5.2",
      billingType: "metered_api",
      costStatus: "reported",
      costCents,
      idempotencyKey: `heartbeat:${runId}:${id}`,
      occurredAt,
    });
    return id;
  }

  it("deletes only rows strictly older than the retention window and is a no-op on rerun", async () => {
    const retention = usageRequestRetentionService(db);
    const now = new Date();
    // The single named window: the cutoff is exactly retention back from `now`.
    const cutoff = new Date(now.getTime() - USAGE_REQUEST_LOG_RETENTION_MS);
    const keptBoundary = await insertRow(cutoff); // the boundary instant itself is retained (strictly-older rule)
    const keptRecent = await insertRow(new Date(cutoff.getTime() + 60_000));
    const keptFresh = await insertRow(now);
    await insertRow(new Date(cutoff.getTime() - 1)); // one millisecond past the window
    await insertRow(new Date(cutoff.getTime() - USAGE_REQUEST_LOG_RETENTION_MS)); // far past

    expect(await retention.cleanupExpired(now)).toBe(2);
    expect(await survivingRequestIds()).toEqual([keptBoundary, keptFresh, keptRecent].sort());

    // A second sweep over the same instant deletes nothing.
    expect(await retention.cleanupExpired(now)).toBe(0);
    expect(await survivingRequestIds()).toHaveLength(3);
  });

  it("drains a backlog larger than one chunk across multiple chunked deletes", async () => {
    // A deliberately small chunk exposes the chunk loop: 25 expired rows over
    // a chunk of 10 must take three deletes inside one sweep call.
    const retention = usageRequestRetentionService(db, { chunkSize: 10 });
    const now = new Date();
    const expired = Array.from({ length: 25 }, () => new Date(now.getTime() - 91 * 86_400_000));
    await db.insert(usageRequestLogs).values(expired.map((occurredAt) => ({
      companyId,
      runId,
      app: "opencode",
      provider: "openrouter",
      biller: "openrouter",
      model: "openai/gpt-5.2",
      requestId: randomUUID(),
      occurredAt,
    })));
    const kept = await insertRow(now);

    expect(await retention.cleanupExpired(now)).toBe(25);
    expect(await survivingRequestIds()).toEqual([kept]);
  });

  it("drains the production chunk size fully in one sweep call", async () => {
    const retention = usageRequestRetentionService(db);
    const now = new Date();
    const expiredAt = new Date(now.getTime() - 91 * 86_400_000);
    // One more row than a single chunk holds: the sweep must keep going.
    await db.insert(usageRequestLogs).values(Array.from({ length: USAGE_REQUEST_LOG_SWEEP_CHUNK + 3 }, () => ({
      companyId,
      runId,
      app: "opencode",
      provider: "openrouter",
      biller: "openrouter",
      model: "openai/gpt-5.2",
      requestId: randomUUID(),
      occurredAt: expiredAt,
    })));

    expect(await retention.cleanupExpired(now)).toBe(USAGE_REQUEST_LOG_SWEEP_CHUNK + 3);
    expect(await survivingRequestIds()).toHaveLength(0);
  });

  it("caps the chunks per sweep and leaves a pending deadline for the scheduler to re-drive", async () => {
    const retention = usageRequestRetentionService(db, { chunkSize: 10, maxChunks: 2 });
    const now = new Date();
    const expiredAt = new Date(now.getTime() - 91 * 86_400_000);
    await db.insert(usageRequestLogs).values(Array.from({ length: 25 }, () => ({
      companyId,
      runId,
      app: "opencode",
      provider: "openrouter",
      biller: "openrouter",
      model: "openai/gpt-5.2",
      requestId: randomUUID(),
      occurredAt: expiredAt,
    })));

    // Two chunks of 10 run; the remainder stays pending with a past deadline.
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    expect(await retention.cleanupExpired(now)).toBe(20);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(await retention.nextRetentionDeadline()).toBeLessThanOrEqual(Date.now());
    warn.mockRestore();

    expect(await retention.cleanupExpired(now)).toBe(5);
    expect(await retention.nextRetentionDeadline()).toBeNull();
  });

  it("does not report a chunk cap when the backlog divides the cap exactly", async () => {
    // 20 rows over two chunks of 10: the cap is reached but the sweep drains
    // every expired row, so the "hit its chunk cap" warning would be a false
    // alarm — nothing is left for the scheduler to re-drive.
    const retention = usageRequestRetentionService(db, { chunkSize: 10, maxChunks: 2 });
    const now = new Date();
    const expiredAt = new Date(now.getTime() - 91 * 86_400_000);
    await db.insert(usageRequestLogs).values(Array.from({ length: 20 }, () => ({
      companyId,
      runId,
      app: "opencode",
      provider: "openrouter",
      biller: "openrouter",
      model: "openai/gpt-5.2",
      requestId: randomUUID(),
      occurredAt: expiredAt,
    })));

    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      expect(await retention.cleanupExpired(now)).toBe(20);
      expect(await retention.nextRetentionDeadline()).toBeNull();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("never touches cost_events, not even receipts older than any window", async () => {
    const retention = usageRequestRetentionService(db);
    const now = new Date();
    const recentReceipt = await insertCostReceipt(1.25, now);
    const ancientReceipt = await insertCostReceipt(0.5, new Date(now.getTime() - 400 * 86_400_000));
    const cutoff = new Date(now.getTime() - USAGE_REQUEST_LOG_RETENTION_MS);
    await insertRow(new Date(cutoff.getTime() - 86_400_000));
    await insertRow(now);

    expect(await retention.cleanupExpired(now)).toBe(1);
    const receipts = await db.select().from(costEvents);
    expect(receipts.map((row) => row.id).sort()).toEqual([recentReceipt, ancientReceipt].sort());
    // numeric({ mode: "number" }): the ledger row comes back untouched, value intact.
    expect(receipts.find((row) => row.id === ancientReceipt)!.costCents).toBe(0.5);
  });

  it("reports the next retention deadline the scheduler waits on", async () => {
    const retention = usageRequestRetentionService(db);
    const now = new Date();

    // No rows, no obligation.
    expect(await retention.nextRetentionDeadline()).toBeNull();

    const occurredAt = new Date(now.getTime() - 3_600_000);
    await insertRow(occurredAt);
    expect(await retention.nextRetentionDeadline()).toBe(
      occurredAt.getTime() + USAGE_REQUEST_LOG_RETENTION_MS,
    );

    // A row already past the window makes the deadline due immediately.
    const overdueAt = new Date(now.getTime() - (USAGE_REQUEST_LOG_RETENTION_MS + 60_000));
    await insertRow(overdueAt);
    expect(await retention.nextRetentionDeadline()).toBe(overdueAt.getTime() + USAGE_REQUEST_LOG_RETENTION_MS);
    expect(await retention.nextRetentionDeadline()).toBeLessThanOrEqual(Date.now());

    expect(await retention.cleanupExpired(now)).toBe(1);
    // The surviving fresh row's deadline is what the scheduler now waits on.
    expect(await retention.nextRetentionDeadline()).toBe(
      occurredAt.getTime() + USAGE_REQUEST_LOG_RETENTION_MS,
    );
  });

  it("clears the deadline once the sweep has drained every expired row", async () => {
    const retention = usageRequestRetentionService(db);
    const now = new Date();
    const overdueAt = new Date(now.getTime() - (USAGE_REQUEST_LOG_RETENTION_MS + 60_000));
    await insertRow(overdueAt);
    await insertRow(new Date(overdueAt.getTime() - 86_400_000));
    expect(await retention.nextRetentionDeadline()).toBeLessThanOrEqual(Date.now());

    expect(await retention.cleanupExpired(now)).toBe(2);
    expect(await survivingRequestIds()).toHaveLength(0);
    expect(await retention.nextRetentionDeadline()).toBeNull();
  });

  it("signals the retention queue when a request row is recorded", async () => {
    // The write hook is the worker's only learning path for a first insert
    // into an empty table, whose deadline nothing else would re-probe.
    // Subscriptions attach to the createDb connection itself.
    let wakes = 0;
    const unsubscribe = subscribeDeliveryWork(db, DELIVERY_QUEUES.usageRequestRetention, () => {
      wakes += 1;
    });
    try {
      const startedAtMs = Date.now() - 1_000;
      await usageRequestLogService(db).recordForRun(
        { companyId, runId, agentId, issueId: null },
        {
          kind: PROVIDER_REQUEST_USAGE_KIND,
          request: {
            requestId: randomUUID(),
            app: "opencode",
            ...usageProviderAndBillerFromModel("openrouter/anthropic/claude-sonnet-4"),
            model: "openrouter/anthropic/claude-sonnet-4",
            startedAtMs,
            endedAtMs: startedAtMs + 100,
            ttftMs: null,
            httpStatus: 200,
            providerRequestId: null,
          },
        },
      );
      expect(wakes).toBeGreaterThanOrEqual(1);
    } finally {
      unsubscribe();
    }
  });
});
