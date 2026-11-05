// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Usage } from "./Usage";
import { ApiError } from "../api/client";
import { formatDateTime } from "../lib/utils";
import type { UsageRequestLogRow, UsageSummary } from "@paperclipai/shared";

const usageLogsMock = vi.hoisted(() => vi.fn());
const usageSummaryMock = vi.hoisted(() => vi.fn());
vi.mock("../api/usage", () => ({ usageApi: { logs: usageLogsMock, summary: usageSummaryMock } }));

const setBreadcrumbsMock = vi.hoisted(() => vi.fn());

const companyState = vi.hoisted(() => ({ selectedCompanyId: "company-1" as string | null }));
vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: companyState.selectedCompanyId }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: setBreadcrumbsMock }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function row(overrides: Partial<UsageRequestLogRow> = {}): UsageRequestLogRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "company-1",
    runId: "22222222-2222-4222-8222-222222222222",
    agentId: null,
    issueId: null,
    projectId: null,
    app: "opencode",
    provider: "openrouter",
    biller: "openrouter",
    model: "z-ai/glm-4.6",
    inputTokens: 1200,
    cachedInputTokens: 300,
    cacheWriteTokens: 0,
    outputTokens: 450,
    costCents: null,
    costStatus: "unpriced",
    durationMs: 850,
    ttftMs: 210,
    httpStatus: 200,
    providerRequestId: "prov-req-1",
    requestId: "req-1",
    occurredAt: "2026-11-04T12:00:00Z",
    metadata: null,
    createdAt: "2026-11-04T12:00:01Z",
    ...overrides,
  };
}

function summary(overrides: Partial<UsageSummary> = {}): UsageSummary {
  return {
    companyId: "company-1",
    totalRequests: 12,
    totalCostCents: "0",
    freshInputTokens: 1500,
    cachedInputTokens: 500,
    cacheWriteTokens: 200,
    outputTokens: 800,
    tokensProcessed: 3000,
    cacheHitRate: 0.25,
    unpricedCount: 12,
    series: [],
    ...overrides,
  };
}

describe("Usage page", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null = null;

  function renderPage() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    act(() => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <Usage />
        </QueryClientProvider>,
      );
    });
    return queryClient;
  }

  /** Read one summary metric by its label, as the cards present it. */
  function metricValue(label: string): string | null {
    const dt = [...container.querySelectorAll("dt")].find((el) => el.textContent === label);
    return dt?.nextElementSibling?.textContent ?? null;
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    companyState.selectedCompanyId = "company-1";
    usageLogsMock.mockReset();
    usageLogsMock.mockResolvedValue([]);
    usageSummaryMock.mockReset();
    usageSummaryMock.mockResolvedValue(summary());
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container.remove();
    vi.clearAllMocks();
  });

  it("fetches the usage logs endpoint for the selected company", async () => {
    renderPage();
    await act(async () => {
      await vi.waitFor(() => expect(usageLogsMock).toHaveBeenCalledExactlyOnceWith("company-1"));
    });
    expect(setBreadcrumbsMock).toHaveBeenCalledWith([{ label: "Usage" }]);
  });

  it("renders request rows with the P1 skeleton columns", async () => {
    usageLogsMock.mockResolvedValue([
      row(),
      row({
        id: "33333333-3333-4333-8333-333333333333",
        requestId: "req-2",
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        httpStatus: 502,
        durationMs: 12_400,
        occurredAt: "2026-11-04T13:30:00Z",
      }),
    ]);
    renderPage();
    await act(async () => {
      await vi.waitFor(() => expect(container.querySelector("tbody tr")).not.toBeNull());
    });

    const headers = [...container.querySelectorAll("th[scope=col]")].map((th) => th.textContent);
    expect(headers).toEqual(["Time", "App", "Provider", "Model", "Status", "Duration"]);

    const [first, second] = [...container.querySelectorAll("tbody tr")];
    // Times render in the browser's local timezone via the shared date formatter.
    expect(first.textContent).toContain(formatDateTime("2026-11-04T12:00:00Z", { includeSeconds: true }));
    expect(first.textContent).toContain("opencode");
    expect(first.textContent).toContain("OpenRouter");
    expect(first.textContent).toContain("z-ai/glm-4.6");
    expect(first.textContent).toContain("200");
    expect(first.textContent).toContain("850ms");

    expect(second.textContent).toContain("Anthropic");
    expect(second.textContent).toContain("claude-sonnet-4-5");
    expect(second.textContent).toContain("502");
    expect(second.textContent).toContain("12.4s");
  });

  it("fetches the usage summary endpoint with the browser's timezone for the selected company", async () => {
    renderPage();
    await act(async () => {
      await vi.waitFor(() => expect(usageSummaryMock).toHaveBeenCalledExactlyOnceWith(
        "company-1",
        Intl.DateTimeFormat().resolvedOptions().timeZone,
      ));
    });
  });

  it("renders the summary's token series as chart columns, zero buckets included", async () => {
    usageSummaryMock.mockResolvedValue(summary({
      series: [
        { bucketStart: "2026-11-04T13:00:00Z", tokens: 2000, requests: 4 },
        { bucketStart: "2026-11-04T14:00:00Z", tokens: 0, requests: 0 },
        { bucketStart: "2026-11-04T15:00:00Z", tokens: 1000, requests: 2 },
      ],
    }));
    renderPage();
    await act(async () => {
      await vi.waitFor(() => expect(container.querySelectorAll('[data-testid="usage-chart-bar"]')).toHaveLength(3));
    });
    expect(container.querySelectorAll('[data-testid="usage-chart-bar"][data-zero]')).toHaveLength(1);
    expect(container.textContent).toContain("Tokens");
  });

  it("renders the summary cards with formatted totals inside one bordered block", async () => {
    usageLogsMock.mockResolvedValue([row()]);
    renderPage();
    await act(async () => {
      await vi.waitFor(() => expect(metricValue("Total requests")).toBe("12"));
    });
    // Headline row: Total Cost is a placeholder until cost attribution lands.
    expect(metricValue("Total cost")).toBe("—");
    expect(metricValue("Total requests")).toBe("12");
    expect(metricValue("Tokens processed")).toBe("3.0k");
    expect(metricValue("Cache hit rate")).toBe("25.0%");
    // Secondary row.
    expect(metricValue("Fresh input")).toBe("1.5k");
    expect(metricValue("Output")).toBe("800");
    expect(metricValue("Cache write")).toBe("200");
    expect(metricValue("Cache hit")).toBe("500");
    // Both rows live in one bordered block (4+4), per the approved mock.
    const blocks = [...container.querySelectorAll("dl")];
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.querySelectorAll("dt")).toHaveLength(4);
    expect(blocks[1]!.querySelectorAll("dt")).toHaveLength(4);
  });

  it("renders the cache hit rate as an em dash when the denominator is zero", async () => {
    usageSummaryMock.mockResolvedValue(summary({ cacheHitRate: null, freshInputTokens: 0, cachedInputTokens: 0 }));
    renderPage();
    await act(async () => {
      await vi.waitFor(() => expect(metricValue("Cache hit rate")).not.toBeNull());
    });
    expect(metricValue("Cache hit rate")).toBe("—");
  });

  it("renders missing status and duration as em dashes", async () => {
    usageLogsMock.mockResolvedValue([
      row({ httpStatus: null, durationMs: null }),
    ]);
    renderPage();
    await act(async () => {
      await vi.waitFor(() => expect(container.querySelector("tbody tr")).not.toBeNull());
    });
    const cells = [...container.querySelectorAll("tbody tr td")].map((td) => td.textContent);
    expect(cells[4]).toBe("—");
    expect(cells[5]).toBe("—");
  });

  it("shows the explanatory empty state when no requests were observed", async () => {
    renderPage();
    await act(async () => {
      await vi.waitFor(() => expect(container.textContent).toContain("No requests observed yet"));
    });
    // The known P1 boundary: only traffic through the provider proxy is captured.
    expect(container.textContent).toContain("provider proxy");
    expect(container.querySelector("table")).toBeNull();
  });

  it("renders the endpoint's 401/403 authorization failure message", async () => {
    usageLogsMock.mockRejectedValue(
      new ApiError("Usage is outside this actor's authorization boundary", 403, {
        error: "usage_outside_authorization_boundary",
      }),
    );
    renderPage();
    await act(async () => {
      await vi.waitFor(() => expect(container.querySelector('[role="alert"]')).not.toBeNull());
    });
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Usage is outside this actor's authorization boundary");
    expect(container.querySelector("table")).toBeNull();
  });

  it("renders a generic failure message for unexpected errors", async () => {
    usageLogsMock.mockRejectedValue(new Error("network gone"));
    renderPage();
    await act(async () => {
      await vi.waitFor(() => expect(container.querySelector('[role="alert"]')).not.toBeNull());
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Usage data could not be loaded. Please try again shortly.",
    );
  });

  it("asks for an organization when none is selected", async () => {
    companyState.selectedCompanyId = null;
    renderPage();
    await act(async () => {
      await Promise.resolve();
    });
    expect(usageLogsMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Select an organization to view usage.");
  });
});
