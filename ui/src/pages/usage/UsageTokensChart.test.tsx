// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UsageTokensChart, niceCeiling } from "./UsageTokensChart";
import { formatDateTime, formatTokens } from "../../lib/utils";
import type { UsageSummarySeriesPoint } from "@paperclipai/shared";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function point(overrides: Partial<UsageSummarySeriesPoint> = {}): UsageSummarySeriesPoint {
  return { bucketStart: "2026-11-04T13:00:00Z", tokens: 0, requests: 0, ...overrides };
}

describe("niceCeiling", () => {
  it("rounds the window maximum up to a 1/2/2.5/5 x 10^n scale value", () => {
    expect(niceCeiling(0)).toBe(1);
    expect(niceCeiling(1)).toBe(1);
    expect(niceCeiling(2)).toBe(2);
    expect(niceCeiling(2.5)).toBe(2.5);
    expect(niceCeiling(3)).toBe(5);
    expect(niceCeiling(700)).toBe(1000);
    expect(niceCeiling(2500)).toBe(2500);
    expect(niceCeiling(3000)).toBe(5000);
    expect(niceCeiling(6000)).toBe(10000);
  });
});

describe("UsageTokensChart", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null = null;

  function renderChart(series: UsageSummarySeriesPoint[] | undefined) {
    root = createRoot(container);
    act(() => {
      root!.render(<UsageTokensChart series={series} />);
    });
  }

  function barGroups(): NodeListOf<SVGGElement> {
    return container.querySelectorAll('[data-testid="usage-chart-bar"]');
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container.remove();
  });

  it("renders one bar column per bucket, including zero buckets as empty stubs", () => {
    renderChart([
      point({ bucketStart: "2026-11-04T13:00:00Z", tokens: 1500, requests: 3 }),
      point({ bucketStart: "2026-11-04T14:00:00Z", tokens: 0, requests: 0 }),
      point({ bucketStart: "2026-11-04T15:00:00Z", tokens: 4500, requests: 9 }),
    ]);
    expect(barGroups()).toHaveLength(3);
    // The zero bucket renders a stub column (not absent), flagged for tests.
    expect(container.querySelectorAll('[data-testid="usage-chart-bar"][data-zero]')).toHaveLength(1);
    expect(container.textContent).not.toContain("No requests observed");
  });

  it("labels the y axis with a nice maximum and its half", () => {
    renderChart([point({ tokens: 3000, requests: 1 })]);
    const labels = [...container.querySelectorAll("svg text")].map((text) => text.textContent);
    expect(labels).toContain("5.0k"); // niceCeiling(3000)
    expect(labels).toContain("2.5k"); // half of the maximum
    expect(labels).toContain("0");
  });

  it("labels buckets with the local hour, and the local date for midnight buckets", () => {
    // Construct both instants in the test runner's local timezone so the
    // expectation holds regardless of where CI runs.
    const hourIso = new Date(2026, 10, 4, 13, 0, 0).toISOString(); // local 13:00
    const midnightIso = new Date(2026, 10, 4, 0, 0, 0).toISOString(); // local midnight
    renderChart([
      point({ bucketStart: hourIso, tokens: 10, requests: 1 }),
      point({ bucketStart: midnightIso, tokens: 20, requests: 1 }),
    ]);
    const labels = [...container.querySelectorAll("svg text")].map((text) => text.textContent);
    const hourLabel = new Date(hourIso).toLocaleTimeString("en-US", { hour: "numeric" });
    expect(labels).toContain(hourLabel);
    expect(labels).toContain(new Date(midnightIso).toLocaleDateString("en-US", { month: "short", day: "numeric" }));
  });

  it("exposes time, tokens and requests for each bucket through its hover title", () => {
    renderChart([point({ bucketStart: "2026-11-04T13:00:00Z", tokens: 1500, requests: 3 })]);
    const title = barGroups()[0]!.querySelector("title");
    expect(title?.textContent).toContain(formatDateTime("2026-11-04T13:00:00Z"));
    expect(title?.textContent).toContain(formatTokens(1500));
    expect(title?.textContent).toContain("3");
  });

  it("keeps the chart skeleton with a caption when every bucket is zero", () => {
    renderChart([
      point({ bucketStart: "2026-11-04T13:00:00Z" }),
      point({ bucketStart: "2026-11-04T14:00:00Z" }),
    ]);
    expect(barGroups()).toHaveLength(2);
    expect(container.querySelectorAll('[data-testid="usage-chart-bar"][data-zero]')).toHaveLength(2);
    expect(container.textContent).toContain("No token activity in this window.");
  });

  it("explains an empty series instead of drawing an axis", () => {
    renderChart([]);
    expect(barGroups()).toHaveLength(0);
    expect(container.textContent).toContain("No requests observed in this window.");
  });

  it("shows a loading placeholder while the summary has not arrived", () => {
    renderChart(undefined);
    expect(barGroups()).toHaveLength(0);
    expect(container.textContent).toContain("Loading");
  });
});
