import { and, desc, eq, gte, isNotNull, isNull, lte, sql, type SQL } from "drizzle-orm";
import { centsToUnits, unitsToCents } from "@paperclipai/shared";
import { costEvents, heartbeatRunEvents, issues, usageRequestLogs, type Db } from "@paperclipai/db";
import type {
  UsageStatusFilter,
  UsageSummary,
  UsageSummaryFacet,
  UsageSummaryFacets,
  UsageSummarySeriesPoint,
} from "@paperclipai/shared";
import { parseProviderRequestUsageRecord } from "../vendor/paperclip-runner/index.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";
import { classifyKeySlot429 } from "./ai-credential-pool.js";
import { logger } from "../middleware/logger.js";

export type UsageRequestLogRow = typeof usageRequestLogs.$inferSelect;

/** The app/provider/model/key/status filter dimensions of a usage read (docs/specs/usage-request-logs.md, API). */
export interface UsageRequestFilters {
  app?: string;
  provider?: string;
  model?: string;
  /** Pooled key attribution in its display form (`key-<slot>`); rows without attribution match no key. */
  key?: string;
  status?: UsageStatusFilter;
}

/**
 * The logs read's filters: the same dimensions plus the summary's from/to
 * window and the keyset cursor (docs/specs/usage-request-logs.md, API).
 * `after` anchors the read strictly after the given `(occurredAt, id)` pair —
 * the decoded form of the previous page's `nextCursor`.
 */
export interface UsageRequestLogQuery extends UsageRequestFilters {
  range?: { from?: Date; to?: Date };
  after?: { occurredAt: Date; id: string };
}

/**
 * The page `latest` returns, over DB rows (Date instants). The route's JSON
 * layer serializes the timestamps into the shared `UsageRequestLogPage`
 * contract, whose `rows` carry ISO strings.
 */
export interface UsageRequestLogDbPage {
  rows: UsageRequestLogRow[];
  total: number;
  nextCursor: string | null;
}

export type UsageRequestRunBinding = {
  companyId: string;
  runId: string;
  agentId: string | null;
  issueId: string | null;
};

/** Spec: hour buckets for windows up to 48 hours, day buckets beyond. */
const HOUR_BUCKET_WINDOW_MS = 48 * 60 * 60 * 1000;

/** Cap on the summary's model facet list (docs/specs/usage-request-logs.md, API). */
const MODEL_FACET_LIMIT = 50;

/**
 * SQL predicate for one status filter class (docs/specs/
 * usage-request-logs.md, API): `success` is 2xx, `client_error` 4xx,
 * `server_error` 5xx, and `other` is everything else — a null upstream
 * status, a 3xx redirect, a 6xx+ transport error.
 */
function statusCondition(status: UsageStatusFilter): SQL {
  const status_ = usageRequestLogs.httpStatus;
  switch (status) {
    case "success":
      return sql`${status_} between 200 and 299`;
    case "client_error":
      return sql`${status_} between 400 and 499`;
    case "server_error":
      return sql`${status_} between 500 and 599`;
    case "other":
      return sql`(${status_} is null or ${status_} < 200 or ${status_} between 300 and 399 or ${status_} >= 600)`;
  }
}

/**
 * The pooled key's display label (`key-<slot>`), shared verbatim by the key
 * filter and the facets' grouping set so the two can never drift. Null for
 * rows without pooled attribution — a plain `concat` would render those as
 * the dead label `key-` (concat eats nulls), and they must match no key.
 */
function keyLabelSql(): SQL {
  const slot = sql`${usageRequestLogs.metadata}->>'keySlot'`;
  return sql`(case when ${slot} is null then null else concat('key-', ${slot}) end)`;
}

/** WHERE fragments for the shared filter dimensions; absent filters add nothing. */
function usageFilterConditions(filters: UsageRequestFilters): SQL[] {
  const conditions: SQL[] = [];
  if (filters.app) conditions.push(eq(usageRequestLogs.app, filters.app));
  if (filters.provider) conditions.push(eq(usageRequestLogs.provider, filters.provider));
  if (filters.model) conditions.push(eq(usageRequestLogs.model, filters.model));
  if (filters.key) {
    // The key filter speaks the display form the facets emit (`key-<slot>`).
    conditions.push(sql`${keyLabelSql()} = ${filters.key}`);
  }
  if (filters.status) conditions.push(statusCondition(filters.status));
  return conditions;
}

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

  // A `subscription_included` receipt carries cost 0 and still prices its
  // matched rows — at $0.00, not left unpriced: the cost is known-free,
  // which is a different fact from an unmeasured (unknown) request.
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
 * The 429 classification's retry-after input, extracted from the raw payload
 * when the runner captures response headers (`request.headers["retry-after"]`,
 * seconds form). Current runner builds do not capture headers into the usage
 * payload, so this reads null in practice and the classifier's 90s fallback
 * applies; a future capture that adds the header is picked up unchanged.
 */
export function retryAfterSecondsFromPayload(payload: unknown): number | null {
  const headers = recordObject(recordObject(recordObject(payload).request).headers);
  const raw = Object.entries(headers)
    .find(([name]) => name.toLowerCase() === "retry-after")?.[1];
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return Math.ceil(raw);
  if (typeof raw === "string" && /^\d+(\.\d+)?$/.test(raw.trim())) return Math.ceil(Number(raw));
  return null;
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
      // The retention worker re-probes its deadline on this queue's settle:
      // a first insert into an empty table (or after a full sweep) must be
      // learned, or its 90-day obligation would wait for a restart.
      const inserted = await db.transaction(async tx => {
        await notifyDeliveryWork(tx, DELIVERY_QUEUES.usageRequestRetention);
        return tx.insert(usageRequestLogs).values({
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
          ...((parsed.usageMissing || parsed.keySlot != null || parsed.connectionId != null)
            ? {
                metadata: {
                  ...(parsed.usageMissing ? { usageMissing: true } : {}),
                  // Key-pool attribution (ticket 04): the pooled slot and its
                  // owning connection as the runner's capture sink saw them.
                  ...(parsed.keySlot != null ? { keySlot: parsed.keySlot } : {}),
                  ...(parsed.connectionId != null ? { connectionId: parsed.connectionId } : {}),
                },
              }
            : {}),
        }).onConflictDoNothing().returning({ id: usageRequestLogs.id, metadata: usageRequestLogs.metadata });
      });
      const stored = inserted[0];
      // Key-pool 429 classification hook (ticket 03): a 429 row attributed to
      // a pooled key slot (metadata.keySlot + metadata.connectionId — ticket
      // 04 populates both) updates that (slot, model) cooldown. Reading the
      // stored metadata (not the payload) keeps re-delivery from ever
      // re-classifying: only a first insert carries a row here. Must never
      // affect the usage insert.
      const keySlot = typeof stored?.metadata?.keySlot === "number" ? stored.metadata.keySlot : null;
      const connectionId = typeof stored?.metadata?.connectionId === "string" ? stored.metadata.connectionId : null;
      if (parsed.httpStatus === 429 && keySlot !== null) {
        await classifyKeySlot429(db, {
          companyId: binding.companyId,
          runId: binding.runId,
          keySlot,
          connectionId,
          model: parsed.model,
          retryAfterSeconds: retryAfterSecondsFromPayload(payload),
        }).catch((error) => {
          logger.warn({ err: error, runId: binding.runId, keySlot }, "Key slot 429 classification failed without affecting the usage record");
        });
      }
      return inserted.length > 0;
    },

    /**
     * One keyset-paginated page of newest rows for the log list (docs/specs/
     * usage-request-logs.md, API), narrowed by the shared filters, an optional
     * from/to window and the `after` cursor. Absent filters change nothing.
     *
     * The cursor is a PostgreSQL row comparison over `(occurred_at, id) < (ts,
     * id)` — the exact complement of the `occurredAt DESC, id DESC` ordering
     * the index `(company_id, occurred_at desc, id)` serves — so a page
     * fetched with a cursor stays stable while newer rows arrive, which an
     * offset pagination cannot promise. The list query probes `limit + 1` rows
     * so `nextCursor` is non-null only when a further page actually exists,
     * and `total` is one `count(*)` over the same matching rows (cursor
     * excluded) so every page of one read reports the same figure.
     */
    async latest(companyId: string, limit: number, query: UsageRequestLogQuery = {}): Promise<UsageRequestLogDbPage> {
      const scopeConditions: SQL[] = [eq(usageRequestLogs.companyId, companyId)];
      if (query.range?.from) scopeConditions.push(gte(usageRequestLogs.occurredAt, query.range.from));
      if (query.range?.to) scopeConditions.push(lte(usageRequestLogs.occurredAt, query.range.to));
      scopeConditions.push(...usageFilterConditions(query));
      const conditions = [...scopeConditions];
      if (query.after) {
        // Bound parameters, never SQL text: the timestamp as ISO and the row
        // id cast to uuid keep the row comparison type-correct.
        conditions.push(sql`(${usageRequestLogs.occurredAt}, ${usageRequestLogs.id}) < (${query.after.occurredAt.toISOString()}::timestamptz, ${query.after.id}::uuid)`);
      }
      const where = and(...conditions);
      const candidates = await db.select()
        .from(usageRequestLogs)
        .where(where)
        .orderBy(desc(usageRequestLogs.occurredAt), desc(usageRequestLogs.id))
        .limit(limit + 1);
      const [counted] = await db
        .select({ total: sql<number>`count(*)::int` })
        .from(usageRequestLogs)
        .where(and(...scopeConditions));
      const rows = candidates.slice(0, limit);
      const last = rows[rows.length - 1];
      return {
        rows,
        total: counted?.total ?? 0,
        nextCursor: candidates.length > limit && last
          ? `${last.occurredAt.toISOString()},${last.id}`
          : null,
      };
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
     * `filters` (app/provider/model/status) narrow the totals and series —
     * the same WHERE the log list applies — but never the facets, which
     * describe the unfiltered window so a selected value keeps its chip.
     */
    async summary(
      companyId: string,
      range?: { from?: Date; to?: Date },
      timeZone: string = "UTC",
      filters: UsageRequestFilters = {},
    ): Promise<UsageSummary> {
      const scopeConditions: SQL[] = [eq(usageRequestLogs.companyId, companyId)];
      if (range?.from) scopeConditions.push(gte(usageRequestLogs.occurredAt, range.from));
      if (range?.to) scopeConditions.push(lte(usageRequestLogs.occurredAt, range.to));
      const conditions = [...scopeConditions, ...usageFilterConditions(filters)];
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
        facets: await this.facets(scopeConditions),
      };
    },

    /**
     * The window's filter dimensions (docs/specs/usage-request-logs.md,
     * API): every app, provider, model and pooled key that produced at least
     * one request in scope, with its count. One grouping-sets scan answers
     * all four dimensions; the scope is deliberately the *unfiltered*
     * window, so a selected value keeps its chip. Since the app/provider/
     * model columns are NOT NULL, a NULL marks the grouping sets the row
     * does not belong to (the key label is NULL for rows without pooled
     * attribution, which belong to no key facet). The models list is capped
     * at 50 sorted-by-volume values — a company's model namespace can be
     * high-cardinality — and `modelsTruncated` reports whether the cap cut
     * anything, so the response stays bounded without silently lying.
     */
    async facets(scopeConditions: SQL[]): Promise<UsageSummaryFacets> {
      const rows = await db.execute(sql`
        select app, provider, model, ${keyLabelSql()} as key, count(*)::int as requests
        from ${usageRequestLogs}
        where ${and(...scopeConditions)}
        group by grouping sets ((app), (provider), (model), (${keyLabelSql()}))
      `) as unknown as Array<{ app: string | null; provider: string | null; model: string | null; key: string | null; requests: number }>;
      const apps: UsageSummaryFacet[] = [];
      const providers: UsageSummaryFacet[] = [];
      const models: UsageSummaryFacet[] = [];
      const keys: UsageSummaryFacet[] = [];
      for (const row of rows) {
        if (row.app != null) apps.push({ value: row.app, requests: row.requests });
        else if (row.provider != null) providers.push({ value: row.provider, requests: row.requests });
        else if (row.model != null) models.push({ value: row.model, requests: row.requests });
        else if (row.key != null) keys.push({ value: row.key, requests: row.requests });
      }
      const byVolume = (a: UsageSummaryFacet, b: UsageSummaryFacet) =>
        b.requests - a.requests || a.value.localeCompare(b.value);
      return {
        apps: apps.sort(byVolume),
        providers: providers.sort(byVolume),
        models: models.sort(byVolume).slice(0, MODEL_FACET_LIMIT),
        keys: keys.sort(byVolume),
        modelsTruncated: models.length > MODEL_FACET_LIMIT,
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
