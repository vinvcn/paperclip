import type { UsageRequestLogPage, UsageRequestLogRow, UsageStatusFilter, UsageSummary } from "@paperclipai/shared";
import { api } from "./client";

/**
 * The Usage page's filter dimensions, carried to both usage reads
 * (docs/specs/usage-request-logs.md, API). Absent keys mean "no filter".
 * `from`/`to` carry the time window to the server — a preset selection is
 * computed client-side into absolute bounds (an open-ended preset sends only
 * `from` so polling keeps admitting new rows); "all" sends neither. Model ids
 * contain slashes, so every value goes through URLSearchParams encoding.
 */
export interface UsageLogFilters {
  app?: string;
  provider?: string;
  model?: string;
  status?: UsageStatusFilter;
  from?: string;
  to?: string;
}

function usageFilterParams(filters: UsageLogFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.app) params.set("app", filters.app);
  if (filters.provider) params.set("provider", filters.provider);
  if (filters.model) params.set("model", filters.model);
  if (filters.status) params.set("status", filters.status);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  return params;
}

/**
 * Usage request log reads (docs/specs/usage-request-logs.md). The logs
 * endpoint returns one keyset page: the newest rows matching the filters,
 * the total matching count, and the cursor (`<occurred-at ISO>,<row id>`) to
 * pass back as `after` for the next-older page — null on the last page.
 * Authorization mirrors the costs read endpoints.
 */
export const usageApi = {
  logs: (companyId: string, filters: UsageLogFilters = {}, limit: number = 20, after?: string | null) => {
    const params = usageFilterParams(filters);
    params.set("limit", String(limit));
    if (after) params.set("after", after);
    return api.get<UsageRequestLogPage>(
      `/companies/${companyId}/usage/logs?${params.toString()}`,
    );
  },
  /**
   * `timeZone` is the viewer's IANA timezone (the browser reports it via
   * `Intl.DateTimeFormat().resolvedOptions().timeZone`); the server buckets
   * the summary's series into local hours or days with it. The summary
   * response also carries the window's filter facets, so the filter
   * controls and the filtered totals share one request.
   */
  summary: (companyId: string, timeZone?: string, filters: UsageLogFilters = {}) => {
    const params = usageFilterParams(filters);
    if (timeZone) params.set("tz", timeZone);
    const query = params.toString();
    return api.get<UsageSummary>(
      `/companies/${companyId}/usage/summary${query ? `?${query}` : ""}`,
    );
  },
};

export type { UsageRequestLogRow };
