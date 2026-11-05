/**
 * JSON shape of one Usage request log row as returned by
 * `GET /api/companies/{companyId}/usage/logs`
 * (docs/specs/usage-request-logs.md). One row per provider HTTP call the
 * runner's provider proxy observed — a request view, not a financial ledger
 * (ADR-0001); authoritative money stays in `cost_events`.
 *
 * Timestamps travel as ISO strings and `costCents` as a decimal string
 * (numeric column). Token counts stay null when the upstream usage block
 * could not be observed; such rows are excluded from token sums.
 * `costStatus` mirrors the table's check constraint vocabulary.
 */
export interface UsageRequestLogRow {
  id: string;
  companyId: string;
  runId: string;
  agentId: string | null;
  issueId: string | null;
  projectId: string | null;
  /** The harness that made the call (e.g. "opencode"); not the provider. */
  app: string;
  provider: string;
  biller: string;
  model: string;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteTokens: number | null;
  outputTokens: number | null;
  costCents: string | null;
  costStatus: "unpriced" | "priced" | "excluded";
  durationMs: number | null;
  ttftMs: number | null;
  httpStatus: number | null;
  providerRequestId: string | null;
  requestId: string;
  occurredAt: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

/**
 * Aggregated Usage card totals from `GET /api/companies/{companyId}/usage/summary`
 * (docs/specs/usage-request-logs.md, Metrics). Token sums are computed in SQL;
 * requests whose usage block was never observed keep null token columns and add
 * nothing to the sums. `freshInputTokens = input − cached input` and
 * `tokensProcessed = fresh + output + cached input` follow the spec formulas.
 * `cacheHitRate` is null when no observed request carries prompt input; the UI
 * renders it as an em dash. `totalCostCents` is a decimal string summing only
 * the priced rows' allocated costs (unpriced rows contribute zero), and
 * `unpricedCount` — rows with no allocation basis or matching receipt — drives
 * the Total Cost card's "N unpriced" badge, marking the displayed total as
 * incomplete.
 */
export interface UsageSummary {
  companyId: string;
  totalRequests: number;
  totalCostCents: string;
  freshInputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  tokensProcessed: number;
  cacheHitRate: number | null;
  unpricedCount: number;
  series: UsageSummarySeriesPoint[];
  facets: UsageSummaryFacets;
}

/**
 * URL-friendly status classes for the usage `status` filter param
 * (docs/specs/usage-request-logs.md, API). Classes keep the URL readable and
 * match the log table's Status column; anything outside 2xx/4xx/5xx — a null
 * upstream status, a 3xx redirect, a 6xx+ transport error — is `other`.
 */
export const USAGE_STATUS_FILTERS = ["success", "client_error", "server_error", "other"] as const;

export type UsageStatusFilter = (typeof USAGE_STATUS_FILTERS)[number];

/**
 * One facet value of the summary's filter dimensions: an app, provider or
 * model that actually produced requests inside the summary's window, with
 * its row count. Facets drive the page's filter controls, so values with no
 * rows in the window never appear as dead filter options.
 */
export interface UsageSummaryFacet {
  /** The value as it appears on the log rows (app name, provider or model id). */
  value: string;
  /** Rows carrying this value inside the summary's window. */
  requests: number;
}

/**
 * The filter dimensions of the summary's window. Facets always describe the
 * *unfiltered* window — they answer "what could I filter by here" — so a
 * selected value never removes its own chip or option.
 */
export interface UsageSummaryFacets {
  apps: UsageSummaryFacet[];
  providers: UsageSummaryFacet[];
  models: UsageSummaryFacet[];
}

/**
 * One bucket of the Usage summary series (docs/specs/usage-request-logs.md,
 * API). `tokens` follows the spec's Tokens Processed formula (fresh input +
 * output + cached input); `requests` counts every observed call in the bucket
 * including ones without token data, so bucket sums always match the card
 * totals. `bucketStart` is ISO UTC aligned to an hour or midnight boundary in
 * the requested timezone — hour buckets for windows up to 48 hours, day
 * buckets beyond that. Buckets with no rows are present with zero values so
 * the axis is continuous.
 */
export interface UsageSummarySeriesPoint {
  bucketStart: string;
  tokens: number;
  requests: number;
}
