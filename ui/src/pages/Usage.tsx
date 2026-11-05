import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { ScrollText } from "lucide-react";
import { USAGE_STATUS_FILTERS, type UsageStatusFilter, type UsageSummaryFacets } from "@paperclipai/shared";
import { usageApi, type UsageLogFilters } from "../api/usage";
import { ApiError } from "../api/client";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/select";
import { useSearchParams } from "@/lib/router";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import { keepPreviousDataForSameCompany } from "../lib/query-placeholder-data";
import { formatCents, formatDateTime, formatDurationMs, formatTokens, providerDisplayName } from "../lib/utils";
import { UsageTokensChart } from "./usage/UsageTokensChart";
import type { UsageRequestLogRow, UsageSummary } from "@paperclipai/shared";

const NO_COMPANY = "__none__";

/** URL-friendly status classes with the labels the log table's Status column speaks. */
const STATUS_FILTER_OPTIONS: { value: UsageStatusFilter; label: string }[] = [
  { value: "success", label: "2xx success" },
  { value: "client_error", label: "4xx client error" },
  { value: "server_error", label: "5xx server error" },
  { value: "other", label: "Other" },
];

const STATUS_FILTER_LABELS = Object.fromEntries(
  STATUS_FILTER_OPTIONS.map((option) => [option.value, option.label]),
) as Record<UsageStatusFilter, string>;

function isUsageStatusFilter(value: string | null): value is UsageStatusFilter {
  return value != null && (USAGE_STATUS_FILTERS as readonly string[]).includes(value);
}

/**
 * The page's filters are the URL's search params — shareable, and they
 * survive a refresh (the Costs page precedent). An unrecognized status
 * class in a hand-edited URL is dropped rather than sent to the server,
 * which would 400 it; the selects only ever write known values.
 */
function filtersFromSearchParams(searchParams: URLSearchParams): UsageLogFilters {
  const filters: UsageLogFilters = {};
  const app = searchParams.get("app");
  if (app) filters.app = app;
  const provider = searchParams.get("provider");
  if (provider) filters.provider = provider;
  const model = searchParams.get("model");
  if (model) filters.model = model;
  const status = searchParams.get("status");
  if (isUsageStatusFilter(status)) filters.status = status;
  const from = searchParams.get("from");
  if (from) filters.from = from;
  const to = searchParams.get("to");
  if (to) filters.to = to;
  return filters;
}

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
 * A row's Cost column is the allocation the run's receipt gave it, not a
 * price the provider reported. Rows without an allocation (no matching
 * receipt, no billed tokens, or the row landed after the run's ledger
 * closed) are a data-quality notice — `Unpriced` in a warning tone, never a
 * $0.00 that would read as free (docs/specs/usage-request-logs.md).
 */
function requestCostCell(row: UsageRequestLogRow) {
  if (row.costStatus === "unpriced" || row.costCents == null) {
    return <span className="text-amber-700 dark:text-amber-200">Unpriced</span>;
  }
  return formatCents(Number(row.costCents));
}

/** Spec metric: null means the denominator was zero, never 0%. */
function formatCacheHitRate(rate: number | null): string {
  return rate == null ? "—" : `${(rate * 100).toFixed(1)}%`;
}

function SummaryMetric({ label, value, badge }: { label: string; value: string | number; badge?: string }) {
  return (
    <div>
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-2xl font-semibold tracking-tight tabular-nums text-foreground">
        {value}
        {badge ? (
          <span className="ml-2 inline-block rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 align-middle text-xs font-medium text-amber-700 dark:text-amber-200">
            {badge}
          </span>
        ) : null}
      </dd>
    </div>
  );
}

/**
 * One bordered block holding the 4-up headline row (Total Cost with its
 * unpriced badge, Total Requests, Tokens Processed, Cache Hit Rate) and the
 * 4-up secondary row (Fresh Input, Output, Cache Write, Cache Hit), matching
 * the approved usage-page mock. Total Cost sums the window's priced rows;
 * the badge counts the unpriced rows the total does not cover.
 */
function SummaryCards({ summary }: { summary: UsageSummary | undefined }) {
  return (
    <Card className="py-4">
      <CardContent className="px-5">
        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <SummaryMetric
            label="Total cost"
            value={summary ? formatCents(Number(summary.totalCostCents)) : "—"}
            badge={summary && summary.unpricedCount > 0 ? `${summary.unpricedCount} unpriced` : undefined}
          />
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
 * The Usage filter bar: data-driven app chips (All + one per facet value,
 * never an app without requests in the window), provider/model/status
 * selects fed by the same facets, and the status classes matching the log
 * table's Status column. Every control writes the URL, so a filtered view
 * can be shared or refreshed.
 */
function UsageFilterBar({ facets, filters, onFilterChange }: {
  facets: UsageSummaryFacets | undefined;
  filters: UsageLogFilters;
  onFilterChange: (key: "app" | "provider" | "model" | "status", value: string | null) => void;
}) {
  const selectClass = "w-auto min-w-40";
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filter by app">
        <Button
          variant={filters.app ? "ghost" : "secondary"}
          size="sm"
          aria-pressed={!filters.app}
          onClick={() => onFilterChange("app", null)}
        >
          All
        </Button>
        {(facets?.apps ?? []).map((facet) => (
          <Button
            key={facet.value}
            variant={filters.app === facet.value ? "secondary" : "ghost"}
            size="sm"
            aria-pressed={filters.app === facet.value}
            onClick={() => onFilterChange("app", facet.value)}
          >
            {facet.value}
            <span className="ml-1.5 text-xs tabular-nums text-muted-foreground">{facet.requests}</span>
          </Button>
        ))}
      </div>
      <NativeSelect
        aria-label="Filter by provider"
        className={selectClass}
        value={filters.provider ?? "all"}
        onChange={(event) => onFilterChange("provider", event.target.value === "all" ? null : event.target.value)}
      >
        <option value="all">All providers</option>
        {(facets?.providers ?? []).map((facet) => (
          <option key={facet.value} value={facet.value}>{facet.value}</option>
        ))}
      </NativeSelect>
      <NativeSelect
        aria-label="Filter by model"
        className={selectClass}
        value={filters.model ?? "all"}
        onChange={(event) => onFilterChange("model", event.target.value === "all" ? null : event.target.value)}
      >
        <option value="all">All models</option>
        {(facets?.models ?? []).map((facet) => (
          <option key={facet.value} value={facet.value}>{facet.value}</option>
        ))}
      </NativeSelect>
      <NativeSelect
        aria-label="Filter by status"
        className={selectClass}
        value={filters.status ?? "all"}
        onChange={(event) => onFilterChange("status", event.target.value === "all" ? null : event.target.value)}
      >
        <option value="all">All statuses</option>
        {STATUS_FILTER_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </NativeSelect>
    </div>
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
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = useMemo(() => filtersFromSearchParams(searchParams), [searchParams]);

  /** Write one filter to the URL; `null` removes the param so links stay clean. */
  const onFilterChange = (key: "app" | "provider" | "model" | "status", value: string | null) => {
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (value) next.set(key, value);
        else next.delete(key);
        return next;
      },
      { replace: true },
    );
  };

  useEffect(() => {
    setBreadcrumbs([{ label: "Usage" }]);
  }, [setBreadcrumbs]);

  const companyId = selectedCompanyId ?? NO_COMPANY;
  // Filter switches keep the previous rows/cards on screen while the narrowed
  // read loads — a full-page skeleton per chip click reads as breakage. The
  // placeholder only ever bridges within one company.
  const logsQuery = useQuery({
    queryKey: queryKeys.usageRequestLogs(companyId, filters),
    queryFn: () => usageApi.logs(companyId, filters),
    enabled: !!selectedCompanyId,
    placeholderData: keepPreviousDataForSameCompany<UsageRequestLogRow[]>(companyId),
  });
  const summaryQuery = useQuery({
    queryKey: queryKeys.usageSummary(companyId, filters),
    // The browser's IANA timezone drives the server-side series bucketing.
    queryFn: () => usageApi.summary(companyId, Intl.DateTimeFormat().resolvedOptions().timeZone, filters),
    enabled: !!selectedCompanyId,
    placeholderData: keepPreviousDataForSameCompany<UsageSummary>(companyId),
  });

  // Human names for the active filters; the filtered empty state points at
  // them instead of showing a bare empty table.
  const activeFilterNames = useMemo(() => [
    filters.app && `app "${filters.app}"`,
    filters.provider && `provider "${providerDisplayName(filters.provider)}"`,
    filters.model && `model "${filters.model}"`,
    filters.status && `status ${STATUS_FILTER_LABELS[filters.status]}`,
    filters.from && `from ${filters.from}`,
    filters.to && `to ${filters.to}`,
  ].filter((name): name is string => typeof name === "string"), [filters]);

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
          <UsageFilterBar
            facets={summaryQuery.data?.facets}
            filters={filters}
            onFilterChange={onFilterChange}
          />
          <Card className="gap-3 py-4">
            <CardHeader className="gap-0 px-5">
              <CardTitle className="text-base">Request logs</CardTitle>
              <CardDescription>Newest provider requests, newest first.</CardDescription>
            </CardHeader>
            <CardContent className="px-5">
              {(logsQuery.data?.length ?? 0) === 0 ? (
                activeFilterNames.length > 0 ? (
                  <EmptyState
                    icon={ScrollText}
                    title="No requests match the current filters"
                    message={`No observed requests match ${activeFilterNames.join(", ")}. Clear a filter to widen the view.`}
                  />
                ) : (
                  <EmptyState
                    icon={ScrollText}
                    title="No requests observed yet"
                    message="Model calls made through the runner's provider proxy appear here as they happen. Requests that bypass the proxy — legacy adapters and direct provider traffic — are not captured yet."
                  />
                )
              ) : (
                <div className="overflow-x-auto">
                  <table aria-label="Usage request logs" className="w-full text-sm">
                    <thead className="text-muted-foreground">
                      <tr className="border-b border-border">
                        <th scope="col" className="py-2 pr-4 text-left font-medium">Time</th>
                        <th scope="col" className="px-4 py-2 text-left font-medium">App</th>
                        <th scope="col" className="px-4 py-2 text-left font-medium">Provider</th>
                        <th scope="col" className="px-4 py-2 text-left font-medium">Model</th>
                        <th scope="col" className="px-4 py-2 text-right font-medium">Cost</th>
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
                          <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums">
                            {requestCostCell(row)}
                          </td>
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
