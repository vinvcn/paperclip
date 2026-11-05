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
  summary: (companyId: string) =>
    api.get<UsageSummary>(`/companies/${companyId}/usage/summary`),
};
