import { USAGE_STATUS_FILTERS, type UsageStatusFilter } from "@paperclipai/shared";

/**
 * The Usage page's per-company display preferences (docs/specs/
 * usage-request-logs.md, UI): the time-range preset, the page size and the
 * last-used request filters, persisted to localStorage so the next visit
 * restores them. Keys follow the repo's `paperclip.<name>:<companyId>` style
 * (see agent-order.ts); every read and write is guarded because storage can
 * throw in restricted browser contexts (private mode, quota).
 */
export const USAGE_TIME_RANGES = ["24h", "7d", "30d", "all"] as const;
export type UsageTimeRange = (typeof USAGE_TIME_RANGES)[number];

/** Spec UI: the page size choices are 20 / 50 / 100 rows. */
export const USAGE_PAGE_SIZES = [20, 50, 100] as const;
export type UsagePageSize = (typeof USAGE_PAGE_SIZES)[number];

/** Window length of each bounded preset; `all` has none. */
export const USAGE_TIME_RANGE_MS: Record<Exclude<UsageTimeRange, "all">, number> = {
  "24h": 24 * 60 * 60_000,
  "7d": 7 * 24 * 60 * 60_000,
  "30d": 30 * 24 * 60 * 60_000,
};

export const USAGE_TIME_RANGE_LABELS: Record<UsageTimeRange, string> = {
  "24h": "Last 24 hours",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  all: "All time",
};

/** First visit defaults per the spec: the last 24 hours, 20 rows per page. */
export const DEFAULT_USAGE_PREFERENCES: UsagePreferences = {
  range: "24h",
  pageSize: 20,
  filters: {},
};

/** The request-filter dimensions a visitor's last selection can carry. */
export interface UsagePreferenceFilters {
  app?: string;
  provider?: string;
  model?: string;
  status?: UsageStatusFilter;
}

export interface UsagePreferences {
  range: UsageTimeRange;
  pageSize: UsagePageSize;
  filters: UsagePreferenceFilters;
}

const USAGE_PREFS_PREFIX = "paperclip.usagePrefs";

export function usagePreferencesStorageKey(companyId: string): string {
  return `${USAGE_PREFS_PREFIX}:${companyId}`;
}

function defaultPreferences(): UsagePreferences {
  return { ...DEFAULT_USAGE_PREFERENCES, filters: {} };
}

function normalizeFilters(value: unknown): UsagePreferenceFilters {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const filters: UsagePreferenceFilters = {};
  for (const key of ["app", "provider", "model"] as const) {
    if (typeof record[key] === "string" && record[key] !== "") filters[key] = record[key];
  }
  if (
    typeof record.status === "string" &&
    (USAGE_STATUS_FILTERS as readonly string[]).includes(record.status)
  ) {
    filters.status = record.status as UsageStatusFilter;
  }
  return filters;
}

function normalizePreferences(value: unknown): UsagePreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) return defaultPreferences();
  const record = value as Record<string, unknown>;
  const range = (USAGE_TIME_RANGES as readonly unknown[]).includes(record.range)
    ? (record.range as UsageTimeRange)
    : DEFAULT_USAGE_PREFERENCES.range;
  const pageSize = (USAGE_PAGE_SIZES as readonly unknown[]).includes(record.pageSize)
    ? (record.pageSize as UsagePageSize)
    : DEFAULT_USAGE_PREFERENCES.pageSize;
  return { range, pageSize, filters: normalizeFilters(record.filters) };
}

export function readUsagePreferences(companyId: string): UsagePreferences {
  try {
    const raw = localStorage.getItem(usagePreferencesStorageKey(companyId));
    if (!raw) return defaultPreferences();
    return normalizePreferences(JSON.parse(raw) as unknown);
  } catch {
    return defaultPreferences();
  }
}

export function writeUsagePreferences(companyId: string, preferences: UsagePreferences): void {
  try {
    localStorage.setItem(usagePreferencesStorageKey(companyId), JSON.stringify(preferences));
  } catch {
    // Restricted browser contexts (private mode, quota) lose the preference
    // for the next visit; the page itself must keep working.
  }
}
