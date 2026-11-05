import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { ScrollText } from "lucide-react";
import { usageApi } from "../api/usage";
import { ApiError } from "../api/client";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import { formatDateTime, formatDurationMs, formatTokens, providerDisplayName } from "../lib/utils";
import { UsageTokensChart } from "./usage/UsageTokensChart";
import type { UsageSummary } from "@paperclipai/shared";

const NO_COMPANY = "__none__";

/**
 * P1 request duration: sub-second calls keep millisecond precision (an
 * 850 ms provider call rounding to "1s" would hide the ttft story), the
 * first minute keeps one decimal, longer calls fall back to the compact
 * humanized form.
 */
function formatRequestDuration(durationMs: number | null): string {
  if (durationMs == null) return "—";
  if (durationMs < 1_000) return `${durationMs}ms`;
  if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(1)}s`;
  return formatDurationMs(durationMs);
}

function formatRequestStatus(httpStatus: number | null): string {
  return httpStatus == null ? "—" : String(httpStatus);
}

/** Spec metric: null means the denominator was zero, never 0%. */
function formatCacheHitRate(rate: number | null): string {
  return rate == null ? "—" : `${(rate * 100).toFixed(1)}%`;
}

function SummaryMetric({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-2xl font-semibold tracking-tight tabular-nums text-foreground">{value}</dd>
    </div>
  );
}

/**
 * One bordered block holding the 4-up headline row (Total Cost placeholder,
 * Total Requests, Tokens Processed, Cache Hit Rate) and the 4-up secondary
 * row (Fresh Input, Output, Cache Write, Cache Hit), matching the approved
 * usage-page mock. The Total Cost value stays a placeholder until the cost
 * attribution ticket fills it in.
 */
function SummaryCards({ summary }: { summary: UsageSummary | undefined }) {
  return (
    <Card className="py-4">
      <CardContent className="px-5">
        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <SummaryMetric label="Total cost" value="—" />
          <SummaryMetric label="Total requests" value={summary?.totalRequests ?? "—"} />
          <SummaryMetric label="Tokens processed" value={summary ? formatTokens(summary.tokensProcessed) : "—"} />
          <SummaryMetric label="Cache hit rate" value={summary ? formatCacheHitRate(summary.cacheHitRate) : "—"} />
        </dl>
        <dl className="mt-4 grid gap-4 border-t border-border pt-4 sm:grid-cols-2 lg:grid-cols-4">
          <SummaryMetric label="Fresh input" value={summary ? formatTokens(summary.freshInputTokens) : "—"} />
          <SummaryMetric label="Output" value={summary ? formatTokens(summary.outputTokens) : "—"} />
          <SummaryMetric label="Cache write" value={summary ? formatTokens(summary.cacheWriteTokens) : "—"} />
          <SummaryMetric label="Cache hit" value={summary ? formatTokens(summary.cachedInputTokens) : "—"} />
        </dl>
      </CardContent>
    </Card>
  );
}

/**
 * Usage request log (docs/specs/usage-request-logs.md) — the per-request view
 * of model calls the runner's provider proxy observed. Costs remains the
 * financial view; this page ships the summary cards and newest-row table.
 */
export function Usage() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Usage" }]);
  }, [setBreadcrumbs]);

  const companyId = selectedCompanyId ?? NO_COMPANY;
  const logsQuery = useQuery({
    queryKey: queryKeys.usageRequestLogs(companyId),
    queryFn: () => usageApi.logs(companyId),
    enabled: !!selectedCompanyId,
  });
  const summaryQuery = useQuery({
    queryKey: queryKeys.usageSummary(companyId),
    // The browser's IANA timezone drives the server-side series bucketing.
    queryFn: () => usageApi.summary(companyId, Intl.DateTimeFormat().resolvedOptions().timeZone),
    enabled: !!selectedCompanyId,
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={ScrollText} message="Select an organization to view usage." />;
  }

  const error = logsQuery.error ?? summaryQuery.error;
  const authorizationMessage = error instanceof ApiError ? error.message : null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Usage</h1>
        <p className="text-sm text-muted-foreground">
          Per-request view of model calls captured by the provider proxy. Costs remains the financial view.
        </p>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {authorizationMessage ?? "Usage data could not be loaded. Please try again shortly."}
        </p>
      ) : logsQuery.isLoading ? (
        <PageSkeleton />
      ) : (
        <>
          <SummaryCards summary={summaryQuery.data} />
          <UsageTokensChart series={summaryQuery.data?.series} />
          <Card className="gap-3 py-4">
            <CardHeader className="gap-0 px-5">
              <CardTitle className="text-base">Request logs</CardTitle>
              <CardDescription>Newest provider requests, newest first.</CardDescription>
            </CardHeader>
            <CardContent className="px-5">
              {(logsQuery.data?.length ?? 0) === 0 ? (
                <EmptyState
                  icon={ScrollText}
                  title="No requests observed yet"
                  message="Model calls made through the runner's provider proxy appear here as they happen. Requests that bypass the proxy — legacy adapters and direct provider traffic — are not captured yet."
                />
              ) : (
                <div className="overflow-x-auto">
                  <table aria-label="Usage request logs" className="w-full text-sm">
                    <thead className="text-muted-foreground">
                      <tr className="border-b border-border">
                        <th scope="col" className="py-2 pr-4 text-left font-medium">Time</th>
                        <th scope="col" className="px-4 py-2 text-left font-medium">App</th>
                        <th scope="col" className="px-4 py-2 text-left font-medium">Provider</th>
                        <th scope="col" className="px-4 py-2 text-left font-medium">Model</th>
                        <th scope="col" className="px-4 py-2 text-right font-medium">Status</th>
                        <th scope="col" className="py-2 pl-4 text-right font-medium">Duration</th>
                      </tr>
                    </thead>
                    <tbody>
                      {logsQuery.data!.map((row) => (
                        <tr key={row.id} className="border-b border-border last:border-0">
                          <td className="whitespace-nowrap py-3 pr-4 tabular-nums text-muted-foreground">
                            {formatDateTime(row.occurredAt, { includeSeconds: true })}
                          </td>
                          <td className="px-4 py-3">{row.app}</td>
                          <td className="px-4 py-3">{providerDisplayName(row.provider)}</td>
                          <td className="px-4 py-3 font-mono">{row.model}</td>
                          <td className={`px-4 py-3 text-right tabular-nums${row.httpStatus != null && row.httpStatus >= 400 ? " text-destructive" : ""}`}>
                            {formatRequestStatus(row.httpStatus)}
                          </td>
                          <td className="whitespace-nowrap py-3 pl-4 text-right tabular-nums">
                            {formatRequestDuration(row.durationMs)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
