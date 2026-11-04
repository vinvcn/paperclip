import { and, desc, eq, sql } from "drizzle-orm";
import { heartbeatRunEvents, issues, usageRequestLogs, type Db } from "@paperclipai/db";
import { parseProviderRequestUsageRecord } from "../vendor/paperclip-runner/index.js";

export type UsageRequestLogRow = typeof usageRequestLogs.$inferSelect;

export type UsageRequestRunBinding = {
  companyId: string;
  runId: string;
  agentId: string | null;
  issueId: string | null;
};

function recordObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Persistence for the Usage request log (docs/specs/usage-request-logs.md).
 * One row per provider HTTP call the runner proxy observed. Agent, issue and
 * project are resolved server-side from the run; the runner never sends them.
 * Re-delivery is absorbed by the (company, run, request_id) unique index.
 */
export function usageRequestLogService(db: Db) {
  // One run's issue does not move during an execution, so memoize per service
  // instance; the executor creates one instance per run.
  const projectByIssue = new Map<string, string | null>();
  return {
    async projectForIssue(companyId: string, issueId: string | null): Promise<string | null> {
      if (!issueId) return null;
      const cached = projectByIssue.get(issueId);
      if (cached !== undefined) return cached;
      const [row] = await db.select({ companyId: issues.companyId, projectId: issues.projectId })
        .from(issues)
        .where(eq(issues.id, issueId))
        .limit(1);
      const projectId = row && row.companyId === companyId ? row.projectId : null;
      projectByIssue.set(issueId, projectId);
      return projectId;
    },

    /** Insert one parsed-or-raw provider_request payload. Returns false when the payload was invalid or already stored. */
    async recordForRun(
      binding: UsageRequestRunBinding,
      payload: unknown,
      observedAtMs: number = Date.now(),
    ): Promise<boolean> {
      const parsed = parseProviderRequestUsageRecord(payload, observedAtMs);
      if (!parsed) return false;
      const projectId = await this.projectForIssue(binding.companyId, binding.issueId);
      const inserted = await db.insert(usageRequestLogs).values({
        companyId: binding.companyId,
        runId: binding.runId,
        agentId: binding.agentId,
        issueId: binding.issueId,
        projectId,
        app: parsed.app,
        provider: parsed.provider,
        biller: parsed.biller,
        model: parsed.model,
        inputTokens: parsed.usage?.inputTokens ?? null,
        cachedInputTokens: parsed.usage?.cachedInputTokens ?? null,
        cacheWriteTokens: parsed.usage?.cacheWriteTokens ?? null,
        outputTokens: parsed.usage?.outputTokens ?? null,
        durationMs: parsed.endedAtMs - parsed.startedAtMs,
        ttftMs: parsed.ttftMs,
        httpStatus: parsed.httpStatus,
        providerRequestId: parsed.providerRequestId,
        requestId: parsed.requestId,
        occurredAt: new Date(parsed.startedAtMs),
      }).onConflictDoNothing().returning({ id: usageRequestLogs.id });
      return inserted.length > 0;
    },

    async latest(companyId: string, limit: number): Promise<UsageRequestLogRow[]> {
      return db.select()
        .from(usageRequestLogs)
        .where(eq(usageRequestLogs.companyId, companyId))
        .orderBy(desc(usageRequestLogs.occurredAt), desc(usageRequestLogs.id))
        .limit(limit);
    },
  };
}

/**
 * Re-record every provider_request diagnostic already committed to the
 * durable run-event log. This is the completion-path twin of the executor's
 * startup re-materialization scan (native-session-executor.ts): the live
 * onCommittedEvent consumer stops once a run reaches a terminal status, so a
 * usage record that commits after that point has no second chance unless the
 * run completion replays the durable log. Insertion is idempotent per
 * (company, run, request id), so replaying events the live consumer already
 * recorded is a no-op. Returns the number of newly inserted rows.
 */
export async function sweepRunUsageRequestLogEvents(
  db: Db,
  binding: UsageRequestRunBinding,
): Promise<number> {
  const committedEvents = await db
    .select({ payload: heartbeatRunEvents.payload })
    .from(heartbeatRunEvents)
    .where(and(
      eq(heartbeatRunEvents.companyId, binding.companyId),
      eq(heartbeatRunEvents.runId, binding.runId),
      eq(heartbeatRunEvents.eventType, "harness.diagnostic"),
      // Only opencode runs emit provider_request diagnostics, so this
      // predicate is also the provider gate: other runs match zero rows.
      sql`${heartbeatRunEvents.payload}->'prpEvent'->'payload'->>'kind' = 'provider_request'`,
    ))
    .orderBy(heartbeatRunEvents.seq);
  const service = usageRequestLogService(db);
  let recorded = 0;
  for (const row of committedEvents) {
    // Durable rows wrap the PRP event as { prpEvent: { payload } }; the
    // usage parser consumes the inner payload, same as the executor scan.
    const payload = recordObject(recordObject(row.payload).prpEvent).payload;
    if (await service.recordForRun(binding, payload)) recorded += 1;
  }
  return recorded;
}
