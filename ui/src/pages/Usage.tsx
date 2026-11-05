import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ScrollText, RefreshCw } from "lucide-react";
import { USAGE_STATUS_FILTERS, type UsageStatusFilter, type UsageSummaryFacets } from "@paperclipai/shared";
import { usageApi, type UsageLogFilters } from "../api/usage";
import {
  USAGE_PAGE_SIZES,
  USAGE_TIME_RANGE_LABELS,
  USAGE_TIME_RANGE_MS,
  type UsagePageSize,
  type UsagePreferenceFilters,
  type UsagePreferences,
  type UsageTimeRange,
  readUsagePreferences,
  writeUsagePreferences,
} from "../lib/usage-preferences";
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
import { cn, formatCents, formatDateTime, formatDurationMs, formatTokens, providerDisplayName } from "../lib/utils";
import { UsageTokensChart } from "./usage/UsageTokensChart";
import type { UsageRequestLogPage, UsageRequestLogRow, UsageSummary } from "@paperclipai/shared";

const NO_COMPANY = "__none__";

/** How often the page re-reads the usage endpoints while it is visible. */
const USAGE_POLL_MS = 30_000;

/**
 * How far the URL's absolute window start may drift from a preset's span and
 * still label the select with that preset. Only client-written bounds are
 * ever exact; a shared link opened later reads as a custom range, which is
 * honest — its window is anchored to when the link was made, not now.
 */
const PRESET_MATCH_TOLERANCE_MS = 60_000;

/** URL-friendly status classes with the labels the log table's Status column speaks. */
const STATUS_FILTER_OPTIONS: { value: UsageStatusFilter; label: string }[] = [
  { value: "success", label: "2xx success" },
  { value: "client_error", label: "4xx client error" },
  { value: "server_error", label: "5xx server error" },
  { value: "other", label: "Other (1xx, 3xx, 6xx, no status)" },
];

const STATUS_FILTER_LABELS = Object.fromEntries(
  STATUS_FILTER_OPTIONS.map((option) => [option.value, option.label]),
) as Record<UsageStatusFilter, string>;

function isUsageStatusFilter(value: string | null): value is UsageStatusFilter {
  return value != null && (USAGE_STATUS_FILTERS as readonly string[]).includes(value);
}

/**
 * The page's request-filter dimensions read from the URL's search params —
 * shareable, and they survive a refresh (the Costs page precedent). An
 * unrecognized status class in a hand-edited URL is dropped rather than sent
 * to the server, which would 400 it; the selects only ever write known values.
 */
function filterDimsFromSearchParams(searchParams: URLSearchParams): UsagePreferenceFilters {
  const filters: UsagePreferenceFilters = {};
  const app = searchParams.get("app");
  if (app) filters.app = app;
  const provider = searchParams.get("provider");
  if (provider) filters.provider = provider;
  const model = searchParams.get("model");
  if (model) filters.model = model;
  const status = searchParams.get("status");
  if (isUsageStatusFilter(status)) filters.status = status;
  return filters;
}

function isDateParam(value: string | null): value is string {
  return value != null && !Number.isNaN(new Date(value).getTime());
}

/**
 * The time window the URL carries, as the server receives it: `from`/`to`
 * bounds a read, absence means all time. A hand-edited URL is user input,
 * not API traffic — a bound the browser cannot parse (or a reversed window)
 * is ignored here and the view falls back to the remembered preset, instead
 * of forwarding it and 400-ing the whole page. That is the same asymmetry as
 * the status class above (05 review F4): direct API callers still get the
 * server's strict validation; the page never forwards what it cannot parse.
 * The pair is dropped as a unit because the window is one control.
 */
function boundsFromSearchParams(searchParams: URLSearchParams): { from?: string; to?: string } {
  const from = searchParams.get("from");
  const to = searchParams.get("to");
  if (!isDateParam(from) || !isDateParam(to)) {
    if (from == null && to == null) return {};
    if (from == null && isDateParam(to)) return { to };
    if (to == null && isDateParam(from)) return { from };
    return {};
  }
  if (new Date(from) > new Date(to)) return {};
  return { from, to };
}

/**
 * The absolute window of a range preset (docs/specs/usage-request-logs.md,
 * UI): presets are rolling and open-ended, so a bounded preset sends only
 * `from` and polling keeps admitting newer rows; "all" bounds nothing.
 * The preset name — never these absolutes — is what localStorage remembers.
 */
function presetBounds(range: UsageTimeRange): { from?: string; to?: string } {
  if (range === "all") return {};
  return { from: new Date(Date.now() - USAGE_TIME_RANGE_MS[range]).toISOString() };
}

/**
 * The preset a window's bounds correspond to, for the select's label; null
 * when the bounds are custom (an explicit `to`, or a `from` no preset's
 * rolling span matches within tolerance). Evaluated against a frozen clock
 * so the label cannot drift to "custom" while the page sits open.
 */
function presetForBounds(bounds: { from?: string; to?: string }): UsageTimeRange | null {
  if (!bounds.from && !bounds.to) return "all";
  if (!bounds.from || bounds.to) return null;
  const span = Date.now() - new Date(bounds.from).getTime();
  for (const range of ["24h", "7d", "30d"] as const) {
    if (Math.abs(span - USAGE_TIME_RANGE_MS[range]) <= PRESET_MATCH_TOLERANCE_MS) return range;
  }
  return null;
}

const WINDOW_PARAM_KEYS = ["app", "provider", "model", "status", "from", "to"] as const;

/**
 * The URL params the page wants, given the URL it has, the company's stored
 * preferences and the remembered preset's absolute window. This one pure
 * function drives both the reads (the page never queries the raw URL) and
 * the URL writer effect below, so the two can never disagree.
 *
 * Per dimension an explicit param wins — that is what makes a shared link
 * show what it says — and an absent one is seeded from the stored
 * preferences. When `wholesale` is set (a company switch: the params in the
 * URL describe the previous company's view) every dimension is re-seeded
 * from the new company's preferences instead. An unusable window (absent,
 * unparseable or reversed — see boundsFromSearchParams) is always replaced
 * by the preset window.
 */
function normalizedParams(
  current: URLSearchParams,
  stored: UsagePreferences,
  presetWindow: { from?: string; to?: string },
  wholesale: boolean,
): URLSearchParams {
  const next = new URLSearchParams(current);
  if (wholesale) {
    for (const key of WINDOW_PARAM_KEYS) next.delete(key);
  }
  const rawFrom = next.get("from");
  const rawTo = next.get("to");
  const usableWindow =
    (isDateParam(rawFrom) || rawFrom == null) &&
    (isDateParam(rawTo) || rawTo == null) &&
    !(isDateParam(rawFrom) && isDateParam(rawTo) && new Date(rawFrom) > new Date(rawTo)) &&
    (rawFrom != null || rawTo != null);
  if (!usableWindow) {
    if (presetWindow.from) next.set("from", presetWindow.from);
    else next.delete("from");
    next.delete("to"); // presets are open-ended so polling admits new rows
  }
  if (!next.get("app") && stored.filters.app) next.set("app", stored.filters.app);
  if (!next.get("provider") && stored.filters.provider) next.set("provider", stored.filters.provider);
  if (!next.get("model") && stored.filters.model) next.set("model", stored.filters.model);
  if (!isUsageStatusFilter(next.get("status"))) {
    next.delete("status");
    if (stored.filters.status) next.set("status", stored.filters.status);
  }
  return next;
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
 * the badge counts the unpriced rows the total does not cover. `busy` marks
 * the block while a bridged refetch is in flight — the stale numbers stay
 * readable but clearly not final.
 */
function SummaryCards({ summary, busy }: { summary: UsageSummary | undefined; busy: boolean }) {
  return (
    <Card aria-busy={busy} className={cn("py-4", busy && "opacity-60 transition-opacity")}>
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
 * The Usage filter bar: the time-range preset select (whose selection is
 * computed client-side into the URL's absolute from/to), data-driven app
 * chips (All + one per facet value, never an app without requests in the
 * window), provider/model/status selects fed by the same facets, the status
 * classes matching the log table's Status column, and the page size. Every
 * control writes the URL (window and filters) or the remembered preferences
 * (page size), so a filtered view can be shared or restored next visit.
 */
function UsageFilterBar({ facets, filters, onFilterChange, selectedRange, onRangeChange, pageSize, onPageSizeChange, refreshing, onRefresh }: {
  facets: UsageSummaryFacets | undefined;
  filters: UsageLogFilters;
  onFilterChange: (key: "app" | "provider" | "model" | "status", value: string | null) => void;
  selectedRange: UsageTimeRange | "custom";
  onRangeChange: (range: UsageTimeRange) => void;
  pageSize: UsagePageSize;
  onPageSizeChange: (size: UsagePageSize) => void;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const selectClass = "w-auto min-w-40";
  return (
    <div className="flex flex-wrap items-center gap-2">
      <NativeSelect
        aria-label="Time range"
        className={selectClass}
        value={selectedRange}
        onChange={(event) => {
          const range = event.target.value;
          if (range !== "custom") onRangeChange(range as UsageTimeRange);
        }}
      >
        {(Object.keys(USAGE_TIME_RANGE_LABELS) as UsageTimeRange[]).map((range) => (
          <option key={range} value={range}>{USAGE_TIME_RANGE_LABELS[range]}</option>
        ))}
        {/* Present only when the URL's bounds match no preset, so the select
            never silently lies about which window is applied. */}
        {selectedRange === "custom" ? <option value="custom">Custom range</option> : null}
      </NativeSelect>
      <Button variant="outline" size="sm" aria-label="Refresh usage data" onClick={onRefresh}>
        <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />
        Refresh
      </Button>
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
        {/* Present only when the URL's (or a remembered) model sits outside
            the window's top-50 facets, so the select keeps showing the value
            that is actually applied instead of silently reading as All. */}
        {filters.model != null && !(facets?.models ?? []).some((facet) => facet.value === filters.model) ? (
          <option value={filters.model}>{filters.model}</option>
        ) : null}
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
      <NativeSelect
        aria-label="Rows per page"
        className={selectClass}
        value={String(pageSize)}
        onChange={(event) => onPageSizeChange(Number(event.target.value) as UsagePageSize)}
      >
        {USAGE_PAGE_SIZES.map((size) => (
          <option key={size} value={String(size)}>{size} / page</option>
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
  const companyId = selectedCompanyId ?? NO_COMPANY;

  // Per-company display preferences (docs/specs/usage-request-logs.md, UI):
  // the time-range preset, page size and request filters are remembered in
  // localStorage and restored on the next visit. The state below is the live
  // selection — initialized from storage per company and kept in step with
  // the storage by the handlers. The derivation must read this state, never
  // a mount-time snapshot: a snapshot would resurrect a filter the user just
  // cleared, because the URL transition lags the click by one router pass.
  const [preferences, setPreferences] = useState<UsagePreferences>(() => readUsagePreferences(companyId));
  const [preferencesFor, setPreferencesFor] = useState(companyId);
  if (preferencesFor !== companyId) {
    // Company switch: re-read the new company's remembered selection. Doing
    // it during render (the "reset state when a prop changes" pattern) keeps
    // the first render of the new company already on its own preferences.
    setPreferencesFor(companyId);
    setPreferences(readUsagePreferences(companyId));
  }

  // The remembered preset's absolute window, anchored when the selection is
  // made (mount or a range change) — not recomputed per render, or the URL
  // normalization below would mint a new `from` on every pass and refetch.
  const presetWindow = useMemo(() => presetBounds(preferences.range), [companyId, preferences.range]);

  // What the URL should look like. On a first visit an explicit param wins
  // (a shared link shows what it says) and absent dimensions are seeded from
  // the company's preferences; when the URL still carries a previous
  // company's view, everything is re-seeded from the new company instead.
  // The reads always consume this derived state — never the raw URL — so a
  // router transition that has not landed yet cannot make the page read the
  // wrong window, and the seed write below is cosmetic (shareability).
  const [seededFor, setSeededFor] = useState<string | null>(null);
  const urlCarriesOtherCompany = seededFor != null && seededFor !== companyId;
  const expectedParams = useMemo(
    () => normalizedParams(searchParams, preferences, presetWindow, urlCarriesOtherCompany),
    [searchParams, preferences, presetWindow, urlCarriesOtherCompany],
  );
  const normalized = useMemo(
    () => searchParams.toString() === expectedParams.toString(),
    [searchParams, expectedParams],
  );

  // Keep the shareable URL in step with the derived state (replace: true —
  // view state, not history). This also cleans a hand-edited unparseable
  // window on the next pass, and re-seeds wholesale after a company switch.
  useEffect(() => {
    if (!selectedCompanyId || normalized) return;
    setSearchParams(() => expectedParams, { replace: true });
  }, [selectedCompanyId, normalized, expectedParams]);

  // Acknowledge the URL as this company's once it is normalized: the next
  // company change then re-seeds wholesale instead of merging into it.
  useEffect(() => {
    if (selectedCompanyId && normalized && seededFor !== companyId) setSeededFor(companyId);
  }, [selectedCompanyId, normalized, seededFor, companyId]);

  const filterDims = useMemo(() => filterDimsFromSearchParams(expectedParams), [expectedParams]);
  const bounds = useMemo(() => boundsFromSearchParams(expectedParams), [expectedParams]);
  const filters = useMemo<UsageLogFilters>(() => ({ ...filterDims, ...bounds }), [filterDims, bounds]);

  /**
   * Adopt a new preference set: the live state first (the derivation reads
   * it), then the company's storage key. The window is stored as the preset
   * name (never absolute dates), so "last 24 hours" re-anchors to the visit,
   * not to when it was picked.
   */
  const persistPreferences = (next: UsagePreferences) => {
    setPreferences(next);
    if (selectedCompanyId) writeUsagePreferences(selectedCompanyId, next);
  };

  /** Write one filter to the URL and the company's remembered filters; `null` removes the param so links stay clean. */
  const onFilterChange = (key: "app" | "provider" | "model" | "status", value: string | null) => {
    const dims: UsagePreferenceFilters = { ...filterDims };
    if (value) {
      // The status select only ever offers the known classes.
      if (key === "status") dims.status = value as UsageStatusFilter;
      else dims[key] = value;
    } else {
      delete dims[key];
    }
    persistPreferences({ ...preferences, filters: dims });
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

  /**
   * Apply a time-range preset: the preset name is remembered, and the URL
   * receives its freshly computed absolute bounds so the shareable link
   * stays complete. Selecting a bounded preset deletes `to` — presets are
   * open-ended, which keeps polling admitting newer rows.
   */
  const onRangeChange = (range: UsageTimeRange) => {
    persistPreferences({ ...preferences, range });
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        const preset = presetBounds(range);
        if (preset.from) next.set("from", preset.from);
        else next.delete("from");
        next.delete("to");
        return next;
      },
      { replace: true },
    );
  };

  /** Page size lives in the preferences only — it is not part of a shareable URL. */
  const onPageSizeChange = (size: UsagePageSize) => {
    persistPreferences({ ...preferences, pageSize: size });
  };

  /**
   * Manual refresh: re-read both endpoints for the current view (docs/specs/
   * usage-request-logs.md, UI). The poll's clock is not disturbed —
   * refetch() simply brings the next read forward.
   */
  const onRefresh = () => {
    logsQuery.refetch();
    summaryQuery.refetch();
  };

  /**
   * Keyset page turns (docs/specs/usage-request-logs.md, API). Next anchors
   * the next read at this page's `nextCursor`; Previous replays the stored
   * cursor of the page before. Both stamp the current epoch, so the state
   * they write can only ever be read by the view they were clicked in.
   */
  const onNextPage = () => {
    const next = logsQuery.data?.nextCursor;
    if (!next) return;
    setPagination({ epoch: paginationEpoch, cursor: next, history: [...activeHistory, activeCursor] });
  };
  const onPrevPage = () => {
    if (activeHistory.length === 0) return;
    setPagination({
      epoch: paginationEpoch,
      cursor: activeHistory[activeHistory.length - 1]!,
      history: activeHistory.slice(0, -1),
    });
  };

  useEffect(() => {
    setBreadcrumbs([{ label: "Usage" }]);
  }, [setBreadcrumbs]);

  // Filter switches keep the previous rows/cards on screen while the narrowed
  // read loads — a full-page skeleton per chip click reads as breakage. The
  // placeholder only ever bridges within one company.
  //
  // Pagination is keyset (docs/specs/usage-request-logs.md, API): the current
  // page's `after` cursor anchors the read, so it must live in the query key
  // or page one and page two would share a cache entry. The epoch folds every
  // input the cursor is meaningless against — company, filters, page size —
  // so a changed epoch simply reads as "page one" without a reset effect, and
  // a stale history can never be applied to a new read.
  const [pagination, setPagination] = useState<{ epoch: string; cursor: string | null; history: (string | null)[] }>({
    epoch: "",
    cursor: null,
    history: [],
  });
  const paginationEpoch = `${companyId}|${JSON.stringify(filters)}|${preferences.pageSize}`;
  const onFirstPage = pagination.epoch !== paginationEpoch;
  const activeCursor = onFirstPage ? null : pagination.cursor;
  const activeHistory = onFirstPage ? [] : pagination.history;
  const page = activeHistory.length + 1;
  const logsQuery = useQuery({
    queryKey: queryKeys.usageRequestLogs(companyId, filters, preferences.pageSize, activeCursor),
    queryFn: () => usageApi.logs(companyId, filters, preferences.pageSize, activeCursor),
    enabled: !!selectedCompanyId,
    placeholderData: keepPreviousDataForSameCompany<UsageRequestLogPage>(companyId),
    // Refresh on mount, on demand, and every 30 seconds while the page is
    // open; the poll pauses while the tab is hidden (docs/specs/
    // usage-request-logs.md, UI).
    refetchInterval: USAGE_POLL_MS,
    refetchIntervalInBackground: false,
  });
  const summaryQuery = useQuery({
    queryKey: queryKeys.usageSummary(companyId, filters),
    // The browser's IANA timezone drives the server-side series bucketing.
    queryFn: () => usageApi.summary(companyId, Intl.DateTimeFormat().resolvedOptions().timeZone, filters),
    enabled: !!selectedCompanyId,
    placeholderData: keepPreviousDataForSameCompany<UsageSummary>(companyId),
    refetchInterval: USAGE_POLL_MS,
    refetchIntervalInBackground: false,
  });
  // While a filter change refetches behind the placeholder bridge, the chips
  // and selects already read as applied but the cards/chart/table still show
  // the previous (unfiltered) numbers — mark those regions busy so the stale
  // figures are not mistaken for the answer (initial load keeps its skeleton;
  // this only covers the bridged case — a background poll refetches real data
  // and must not flicker the page).
  const refreshing = logsQuery.isFetching || summaryQuery.isFetching;
  const bridging =
    (logsQuery.isFetching && logsQuery.isPlaceholderData) || (summaryQuery.isFetching && summaryQuery.isPlaceholderData);

  // The select's label: which preset the current window's bounds correspond
  // to, or custom. Memoized on the bounds so the label is computed against a
  // frozen clock and cannot drift to "custom" while the page sits open.
  const selectedRange = useMemo(() => presetForBounds(bounds) ?? "custom", [bounds]);

  // Human names for the active filters; the filtered empty state points at
  // them instead of showing a bare empty table. The time window is not named
  // here — it is a first-class control in the filter bar.
  const activeFilterNames = useMemo(() => [
    filterDims.app && `app "${filterDims.app}"`,
    filterDims.provider && `provider "${providerDisplayName(filterDims.provider)}"`,
    filterDims.model && `model "${filterDims.model}"`,
    filterDims.status && `status ${STATUS_FILTER_LABELS[filterDims.status]}`,
  ].filter((name): name is string => typeof name === "string"), [filterDims]);

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
          <SummaryCards summary={summaryQuery.data} busy={bridging} />
          <UsageTokensChart series={summaryQuery.data?.series} busy={bridging} />
          <UsageFilterBar
            facets={summaryQuery.data?.facets}
            filters={filters}
            onFilterChange={onFilterChange}
            selectedRange={selectedRange}
            onRangeChange={onRangeChange}
            pageSize={preferences.pageSize}
            onPageSizeChange={onPageSizeChange}
            refreshing={refreshing}
            onRefresh={onRefresh}
          />
          <Card aria-busy={bridging} className={cn("gap-3 py-4", bridging && "opacity-60 transition-opacity")}>
            <CardHeader className="gap-0 px-5">
              <CardTitle className="text-base">Request logs</CardTitle>
              <CardDescription>Newest provider requests, newest first.</CardDescription>
            </CardHeader>
            <CardContent className="px-5">
              {(logsQuery.data?.rows.length ?? 0) === 0 ? (
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
                      {logsQuery.data!.rows.map((row) => (
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
                          {/* Aligned with the status classes: 6xx+ transport errors read as "other", not failures. */}
                          <td className={`px-4 py-3 text-right tabular-nums${row.httpStatus != null && row.httpStatus >= 400 && row.httpStatus < 600 ? " text-destructive" : ""}`}>
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
              {logsQuery.data && logsQuery.data.rows.length > 0 ? (
                <div className="mt-3 flex items-center justify-between border-t border-border pt-3">
                  <p aria-live="polite" className="text-xs tabular-nums text-muted-foreground">
                    {logsQuery.data.total} matching {logsQuery.data.total === 1 ? "request" : "requests"}
                  </p>
                  <div className="flex items-center gap-2">
                    {/* While the placeholder bridge shows the previous read
                        behind a changed epoch, its cursor is meaningless for
                        the pending read — both turns are dead until the real
                        page settles. */}
                    <Button variant="outline" size="sm" disabled={page === 1 || logsQuery.isPlaceholderData} onClick={onPrevPage}>
                      Previous
                    </Button>
                    <span className="text-xs tabular-nums text-muted-foreground">Page {page}</span>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!logsQuery.data.nextCursor || logsQuery.isPlaceholderData}
                      onClick={onNextPage}
                    >
                      Next
                    </Button>
                  </div>
                </div>
              ) : null}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
