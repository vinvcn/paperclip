// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_USAGE_PREFERENCES,
  readUsagePreferences,
  usagePreferencesStorageKey,
  writeUsagePreferences,
} from "./usage-preferences";

describe("usage preferences storage", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("keys the preferences per company so switching companies reads its own", () => {
    expect(usagePreferencesStorageKey("company-1")).toBe("paperclip.usagePrefs:company-1");
    expect(usagePreferencesStorageKey("company-2")).not.toBe(usagePreferencesStorageKey("company-1"));
  });

  it("falls back to the spec defaults on a first visit: last 24 hours, 20 rows", () => {
    expect(readUsagePreferences("company-1")).toEqual(DEFAULT_USAGE_PREFERENCES);
    expect(readUsagePreferences("company-1")).toEqual({ range: "24h", pageSize: 20, filters: {} });
  });

  it("round-trips a written selection", () => {
    writeUsagePreferences("company-1", {
      range: "7d",
      pageSize: 50,
      filters: { provider: "openrouter", status: "server_error" },
    });
    expect(readUsagePreferences("company-1")).toEqual({
      range: "7d",
      pageSize: 50,
      filters: { provider: "openrouter", status: "server_error" },
    });
    // Company-scoped: another company still sees its own defaults.
    expect(readUsagePreferences("company-2")).toEqual(DEFAULT_USAGE_PREFERENCES);
  });

  it("falls back to the defaults for corrupt JSON instead of throwing", () => {
    localStorage.setItem(usagePreferencesStorageKey("company-1"), "{not json");
    expect(readUsagePreferences("company-1")).toEqual(DEFAULT_USAGE_PREFERENCES);
  });

  it("normalizes stored values: unknown range, page size and status fall back or drop", () => {
    localStorage.setItem(
      usagePreferencesStorageKey("company-1"),
      JSON.stringify({ range: "10m", pageSize: 37, filters: { status: "bogus", app: "", model: 5 } }),
    );
    expect(readUsagePreferences("company-1")).toEqual({
      range: DEFAULT_USAGE_PREFERENCES.range,
      pageSize: DEFAULT_USAGE_PREFERENCES.pageSize,
      filters: {},
    });
  });

  it("keeps only the request-filter dimensions and non-empty strings", () => {
    localStorage.setItem(
      usagePreferencesStorageKey("company-1"),
      JSON.stringify({
        range: "30d",
        pageSize: 100,
        filters: { app: "opencode", provider: "anthropic", from: "2026-01-01T00:00:00Z", extra: "x" },
      }),
    );
    expect(readUsagePreferences("company-1")).toEqual({
      range: "30d",
      pageSize: 100,
      filters: { app: "opencode", provider: "anthropic" },
    });
  });

  it("returns the defaults when localStorage throws (restricted browser contexts)", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    expect(readUsagePreferences("company-1")).toEqual(DEFAULT_USAGE_PREFERENCES);
  });

  it("keeps the page working when writing throws (private mode, quota)", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    expect(() =>
      writeUsagePreferences("company-1", { range: "all", pageSize: 100, filters: {} }),
    ).not.toThrow();
  });
});
