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
