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
 * renders it as an em dash. `unpricedCount` is a placeholder for the pricing
 * ticket, which introduces per-row cost attribution.
 */
export interface UsageSummary {
  companyId: string;
  totalRequests: number;
  freshInputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  tokensProcessed: number;
  cacheHitRate: number | null;
  unpricedCount: number;
}
