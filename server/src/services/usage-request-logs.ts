import { and, desc, eq, gte, isNotNull, isNull, lte, sql, type SQL } from "drizzle-orm";
import { centsToUnits, unitsToCents } from "@paperclipai/shared";
import { costEvents, heartbeatRunEvents, issues, usageRequestLogs, type Db } from "@paperclipai/db";
import type { UsageSummary, UsageSummarySeriesPoint } from "@paperclipai/shared";
import { parseProviderRequestUsageRecord } from "../vendor/paperclip-runner/index.js";

export type UsageRequestLogRow = typeof usageRequestLogs.$inferSelect;

export type UsageRequestRunBinding = {
  companyId: string;
  runId: string;
  agentId: string | null;
  issueId: string | null;
};

/** Spec: hour buckets for windows up to 48 hours, day buckets beyond. */
const HOUR_BUCKET_WINDOW_MS = 48 * 60 * 60 * 1000;

/**
 * Split a run's receipt across its request rows in the numeric(24,7)
 * minimum unit (1e-7 cents) so the parts sum exactly to the receipt with no
 * rounding drift (docs/specs/usage-request-logs.md, Cost attribution). Every
 * row first receives its floored pro-rata share; the remainder is always
 * smaller than one unit per row and is handed out one unit at a time to the
 * largest weights (ties keep the input order), which keeps the sum exact
 * while biasing residue toward the rows the money belongs on.
 */
export function allocateUnitsByWeight(totalUnits: bigint, weights: number[]): bigint[] {
  const rows = weights.map((weight, index) => ({ index, weight }));
  const shares = rows.map(() => 0n);
  const totalWeight = rows.reduce((sum, row) => sum + row.weight, 0);
  if (totalWeight <= 0 || totalUnits <= 0n) return shares;
  let allocated = 0n;
  for (const row of rows) {
    const share = (totalUnits * BigInt(row.weight)) / BigInt(totalWeight);
    shares[row.index] = share;
    allocated += share;
  }
  const remainderOrder = [...rows].sort((a, b) => b.weight - a.weight || a.index - b.index);
  for (const row of remainderOrder.slice(0, Number(totalUnits - allocated))) {
    shares[row.index] += 1n;
  }
  return shares;
}

/**
 * Distribute a run's authoritative receipt (its `cost_events` rows) across
 * that run's request rows, per model, pro-rata by billed tokens — fresh
 * input + cache write + output + cached input (docs/specs/
 * usage-request-logs.md, Cost attribution). This is an allocation view, not
 * a second ledger: `cost_events` is never written here.
 *
 * Allocation runs once per run, when accounting closes. The first pass marks
 * the rows it priced; rows that arrive afterwards, carry no billed tokens,
 * or match no priced receipt stay `unpriced` and contribute zero to the
 * Total Cost instead of reopening the ledger. Unpriced receipt rows carry no
 * money by definition, so they never price a request row either. Returns the
 * number of rows priced.
 */
export async function allocateRunCosts(db: Db, companyId: string, runId: string): Promise<number> {
  // Once-per-run gate: any priced row means this run's receipt was already
  // distributed, so later arrivals must stay unpriced.
  const [alreadyPriced] = await db.select({ id: usageRequestLogs.id })
    .from(usageRequestLogs)
    .where(and(
      eq(usageRequestLogs.companyId, companyId),
      eq(usageRequestLogs.runId, runId),
      isNotNull(usageRequestLogs.costCents),
    ))
    .limit(1);
  if (alreadyPriced) return 0;

  const receipts = await db.select({
      model: costEvents.model,
      cents: sql<string>`sum(${costEvents.costCents})::text`,
    })
    .from(costEvents)
    .where(and(
      eq(costEvents.companyId, companyId),
      eq(costEvents.heartbeatRunId, runId),
      sql`${costEvents.costStatus} <> 'unpriced'`,
    ))
    .groupBy(costEvents.model);
  if (receipts.length === 0) return 0;

  const rows = await db.select({
      id: usageRequestLogs.id,
      model: usageRequestLogs.model,
      inputTokens: usageRequestLogs.inputTokens,
      cachedInputTokens: usageRequestLogs.cachedInputTokens,
      cacheWriteTokens: usageRequestLogs.cacheWriteTokens,
      outputTokens: usageRequestLogs.outputTokens,
    })
    .from(usageRequestLogs)
    .where(and(
      eq(usageRequestLogs.companyId, companyId),
      eq(usageRequestLogs.runId, runId),
      isNull(usageRequestLogs.costCents),
      eq(usageRequestLogs.costStatus, "unpriced"),
    ));
  if (rows.length === 0) return 0;

  const rowsByModel = new Map<string, { id: string; billedTokens: number }[]>();
  for (const row of rows) {
    // Billed tokens (the allocation basis) differ from Tokens Processed:
    // cache write is billed and cached input stays part of the billed prompt.
    const billedTokens =
      Math.max((row.inputTokens ?? 0) - (row.cachedInputTokens ?? 0), 0) +
      (row.cacheWriteTokens ?? 0) + (row.outputTokens ?? 0) + (row.cachedInputTokens ?? 0);
    if (billedTokens <= 0) continue; // No basis: the row stays unpriced.
    const group = rowsByModel.get(row.model) ?? [];
    group.push({ id: row.id, billedTokens });
    rowsByModel.set(row.model, group);
  }

  const priced: { id: string; cents: string }[] = [];
  for (const receipt of receipts) {
    const group = rowsByModel.get(receipt.model);
    if (!group?.length) continue; // Receipt money without a matching request row stays unallocated.
    const shares = allocateUnitsByWeight(centsToUnits(receipt.cents), group.map((row) => row.billedTokens));
    for (const [index, share] of shares.entries()) {
      priced.push({ id: group[index]!.id, cents: unitsToCents(share) });
    }
  }
  if (priced.length === 0) return 0;

  // One bulk write with a per-row price list; the unpriced guard keeps a
  // racing invocation from ever stacking a second allocation onto a row.
  await db.execute(sql`
    update usage_request_logs
    set cost_cents = priced.cost_cents,
        cost_status = 'priced'
    from (values ${sql.join(priced.map((row) => sql`(${row.id}::uuid, ${row.cents}::numeric)`), sql`, `)}) as priced (id, cost_cents)
    where usage_request_logs.id = priced.id
      and usage_request_logs.company_id = ${companyId}
      and usage_request_logs.run_id = ${runId}
      and usage_request_logs.cost_cents is null
      and usage_request_logs.cost_status = 'unpriced'
  `);
  return priced.length;
}

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
        ...(parsed.usageMissing ? { metadata: { usageMissing: true } } : {}),
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

    /**
     * Card totals for the Usage page (docs/specs/usage-request-logs.md,
     * Metrics), aggregated in SQL — rows are never pulled into memory.
     * Requests whose usage block was never observed keep null token columns
     * and coalesce to zero inside the sums, so they count toward the request
     * total but add nothing to the token figures. The spec formulas are
     * applied to the aggregates: fresh input = input − cached input, tokens
     * processed = fresh + output + cached input, and the cache hit rate is
     * null when its denominator is zero. `totalCostCents` sums only the
     * priced rows' allocated costs — unpriced rows contribute zero — and
     * `unpricedCount` drives the Total Cost card's "N unpriced" badge.
     *
     * `timeZone` (an IANA name, validated by the route) buckets the returned
     * series in the viewer's local time; the window matches this summary's
     * from/to bounds, falling back to the extent of the matching rows.
     */
    async summary(
      companyId: string,
      range?: { from?: Date; to?: Date },
      timeZone: string = "UTC",
    ): Promise<UsageSummary> {
      const conditions: SQL[] = [eq(usageRequestLogs.companyId, companyId)];
      if (range?.from) conditions.push(gte(usageRequestLogs.occurredAt, range.from));
      if (range?.to) conditions.push(lte(usageRequestLogs.occurredAt, range.to));
      const [row] = await db
        .select({
          totalRequests: sql<number>`count(*)::int`,
          totalCostCents: sql<string>`coalesce(sum(${usageRequestLogs.costCents}) filter (where ${usageRequestLogs.costStatus} <> 'unpriced'), 0)::text`,
          inputTokens: sql<number>`coalesce(sum(coalesce(${usageRequestLogs.inputTokens}, 0)), 0)::double precision`,
          cachedInputTokens: sql<number>`coalesce(sum(coalesce(${usageRequestLogs.cachedInputTokens}, 0)), 0)::double precision`,
          cacheWriteTokens: sql<number>`coalesce(sum(coalesce(${usageRequestLogs.cacheWriteTokens}, 0)), 0)::double precision`,
          outputTokens: sql<number>`coalesce(sum(coalesce(${usageRequestLogs.outputTokens}, 0)), 0)::double precision`,
          unpricedCount: sql<number>`count(*) filter (where ${usageRequestLogs.costStatus} = 'unpriced')::int`,
        })
        .from(usageRequestLogs)
        .where(and(...conditions));
      const input = row?.inputTokens ?? 0;
      const cached = row?.cachedInputTokens ?? 0;
      const freshInput = input - cached;
      const cacheWrite = row?.cacheWriteTokens ?? 0;
      const output = row?.outputTokens ?? 0;
      const hitDenominator = freshInput + cached;
      return {
        companyId,
        totalRequests: row?.totalRequests ?? 0,
        totalCostCents: row?.totalCostCents ?? "0",
        freshInputTokens: freshInput,
        cachedInputTokens: cached,
        cacheWriteTokens: cacheWrite,
        outputTokens: output,
        tokensProcessed: freshInput + cached + output,
        cacheHitRate: hitDenominator > 0 ? cached / hitDenominator : null,
        unpricedCount: row?.unpricedCount ?? 0,
        series: await this.series(conditions, range, timeZone),
      };
    },

    /**
     * The token series for the summary's window (docs/specs/usage-request-logs.md,
     * API), bucketed entirely in SQL with `date_trunc(... AT TIME ZONE :tz)` so
     * buckets sit on local-time boundaries and DST transitions are PostgreSQL's
     * problem, not ours. The timezone is always a bound parameter; buckets are
     * generated over local wall-clock time and converted back with the same
     * expression the rows group by — `distinct` collapses the wall hours a DST
     * transition repeats (fall-back) or skips (spring-forward), so every bucket
     * start is unique and every row joins exactly one bucket. `tokens` follows
     * the spec's Tokens Processed formula, whose cached term cancels against
     * fresh input: input + output. Missing window bounds fall back to the
     * extent of the matching rows; with neither bounds nor rows there is
     * nothing to fill, and the series is empty. Empty buckets are kept
     * (zero-filled) so the axis is continuous.
     */
    async series(
      conditions: SQL[],
      range?: { from?: Date; to?: Date },
      timeZone: string = "UTC",
    ): Promise<UsageSummarySeriesPoint[]> {
      let from = range?.from ?? null;
      let to = range?.to ?? null;
      if (!from || !to) {
        const [extent] = await db
          .select({
            minMs: sql<number | null>`extract(epoch from min(${usageRequestLogs.occurredAt}))::double precision * 1000`,
            maxMs: sql<number | null>`extract(epoch from max(${usageRequestLogs.occurredAt}))::double precision * 1000`,
          })
          .from(usageRequestLogs)
          .where(and(...conditions));
        // Raw execute returns timestamp columns as text (drizzle installs
        // transparent parsers), so the extent is read as epoch milliseconds.
        from = from ?? (extent?.minMs != null ? new Date(extent.minMs) : null);
        to = to ?? (extent?.maxMs != null ? new Date(extent.maxMs) : null);
      }
      if (!from || !to) return [];
      const unit = to.getTime() - from.getTime() <= HOUR_BUCKET_WINDOW_MS ? "hour" : "day";
      // postgres.js cannot bind Date objects in raw statements, but the same
      // ISO strings the query builder uses for range bounds serialize fine;
      // the explicit cast keeps the parameter type unambiguous.
      const fromIso = from.toISOString();
      const toIso = to.toISOString();
      const rows = await db.execute(sql`
        with buckets as (
          select distinct (generate_series(
            date_trunc(${unit}, ${fromIso}::timestamptz at time zone ${timeZone}),
            date_trunc(${unit}, ${toIso}::timestamptz at time zone ${timeZone}),
            ${unit === "hour" ? "1 hour" : "1 day"}::interval
          ) at time zone ${timeZone}) as bucket_start
        )
        select extract(epoch from b.bucket_start)::double precision * 1000 as bucket_start_ms,
          coalesce(sum(coalesce(${usageRequestLogs.inputTokens}, 0) + coalesce(${usageRequestLogs.outputTokens}, 0)), 0)::double precision as tokens,
          count(${usageRequestLogs.id})::int as requests
        from buckets b
        left join ${usageRequestLogs}
          on date_trunc(${unit}, ${usageRequestLogs.occurredAt} at time zone ${timeZone}) at time zone ${timeZone} = b.bucket_start
          and ${and(...conditions)}
        group by b.bucket_start
        order by b.bucket_start
      `) as unknown as Array<{ bucket_start_ms: number; tokens: number; requests: number }>;
      // Drizzle installs transparent parsers for timestamp OIDs on the
      // postgres.js client, so raw execute returns session-timezone text for
      // timestamptz columns; epoch milliseconds sidestep that entirely.
      return rows.map((row) => ({
        bucketStart: new Date(row.bucket_start_ms).toISOString(),
        tokens: row.tokens,
        requests: row.requests,
      }));
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
