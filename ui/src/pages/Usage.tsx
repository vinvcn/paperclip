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
import { formatDateTime, formatDurationMs, providerDisplayName } from "../lib/utils";

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

/**
 * Usage request log (docs/specs/usage-request-logs.md) — the per-request view
 * of model calls the runner's provider proxy observed. Costs remains the
 * financial view; this page deliberately ships as a skeleton: tokens, cost,
 * speed columns, cards, charts and filters arrive with the follow-up tickets.
 */
export function Usage() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Usage" }]);
  }, [setBreadcrumbs]);

  const companyId = selectedCompanyId ?? NO_COMPANY;
  const { data: rows, isLoading, error } = useQuery({
    queryKey: queryKeys.usageRequestLogs(companyId),
    queryFn: () => usageApi.logs(companyId),
    enabled: !!selectedCompanyId,
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={ScrollText} message="Select an organization to view usage." />;
  }

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
      ) : isLoading ? (
        <PageSkeleton />
      ) : (
        <Card className="gap-3 py-4">
          <CardHeader className="gap-0 px-5">
            <CardTitle className="text-base">Request logs</CardTitle>
            <CardDescription>Newest provider requests, newest first.</CardDescription>
          </CardHeader>
          <CardContent className="px-5">
            {(rows?.length ?? 0) === 0 ? (
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
                    {rows!.map((row) => (
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
      )}
    </div>
  );
}
