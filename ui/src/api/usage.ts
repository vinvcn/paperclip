import type { UsageRequestLogRow, UsageSummary } from "@paperclipai/shared";
import { api } from "./client";

/**
 * Usage request log reads (docs/specs/usage-request-logs.md). The logs
 * endpoint returns the newest rows only in P1; filters and keyset pagination
 * arrive with the filters ticket. Authorization mirrors the costs read
 * endpoints.
 */
export const usageApi = {
  logs: (companyId: string, limit: number = 20) =>
    api.get<UsageRequestLogRow[]>(
      `/companies/${companyId}/usage/logs?limit=${limit}`,
    ),
  /**
   * `timeZone` is the viewer's IANA timezone (the browser reports it via
   * `Intl.DateTimeFormat().resolvedOptions().timeZone`); the server buckets
   * the summary's series into local hours or days with it.
   */
  summary: (companyId: string, timeZone?: string) =>
    api.get<UsageSummary>(
      `/companies/${companyId}/usage/summary${timeZone ? `?tz=${encodeURIComponent(timeZone)}` : ""}`,
    ),
};
