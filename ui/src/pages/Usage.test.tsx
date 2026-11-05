// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";
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

/** Observes the page's shareable filter URL as the router sees it. */
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location-probe">{location.search}</div>;
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

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
    facets: { apps: [], providers: [], models: [] },
    ...overrides,
  };
}

function summaryWithFacets(): UsageSummary {
  return summary({
    facets: {
      apps: [{ value: "opencode", requests: 5 }],
      providers: [{ value: "openrouter", requests: 3 }, { value: "anthropic", requests: 2 }],
      models: [{ value: "z-ai/glm-4.6", requests: 5 }],
    },
  });
}

describe("Usage page", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null = null;

  function renderPage(initialUrl = "/") {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    act(() => {
      root!.render(
        <MemoryRouter initialEntries={[initialUrl]}>
          <QueryClientProvider client={queryClient}>
            <div>
              <Usage />
              <LocationProbe />
            </div>
          </QueryClientProvider>
        </MemoryRouter>,
      );
    });
    return queryClient;
  }

  /** Read one summary metric by its label, as the cards present it. */
  function metricValue(label: string): string | null {
    const dt = [...container.querySelectorAll("dt")].find((el) => el.textContent === label);
    return dt?.nextElementSibling?.textContent ?? null;
  }

  /** The app chip labels ("All" first), counts stripped. */
  function appChipLabels(): string[] {
    return [...container.querySelectorAll('div[aria-label="Filter by app"] button')]
      .map((button) => button.textContent!.replace(/\d+$/, ""));
  }

  function locationSearch(): string {
    return container.querySelector('[data-testid="location-probe"]')!.textContent ?? "";
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
      await vi.waitFor(() => expect(usageLogsMock).toHaveBeenCalledExactlyOnceWith("company-1", {}));
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
    expect(headers).toEqual(["Time", "App", "Provider", "Model", "Cost", "Status", "Duration"]);

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

  it("renders per-row cost as the allocated amount, or Unpriced in a warning tone", async () => {
    usageLogsMock.mockResolvedValue([
      row({ costCents: "150.0000000", costStatus: "priced" }),
      row({ id: "44444444-4444-4444-8444-444444444444", requestId: "req-unpriced", costCents: null, costStatus: "unpriced" }),
    ]);
    renderPage();
    await act(async () => {
      await vi.waitFor(() => expect(container.querySelectorAll("tbody tr")).toHaveLength(2));
    });

    const rows = [...container.querySelectorAll("tbody tr")];
    const costCell = (tr: Element) => tr.querySelectorAll("td")[4]!;
    // Priced rows show their allocated share; unpriced rows show the
    // data-quality notice in a warning tone, never a $0.00 price.
    expect(costCell(rows[0]!).textContent).toBe("$1.50");
    expect(costCell(rows[1]!).textContent).toBe("Unpriced");
    expect(costCell(rows[1]!).firstElementChild!.className).toMatch(/amber/);
    // An unpriced row is a data-quality notice, never a zero price.
    for (const tr of rows) expect(costCell(tr).textContent).not.toBe("$0.00");
  });

  it("fetches the usage summary endpoint with the browser's timezone for the selected company", async () => {
    renderPage();
    await act(async () => {
      await vi.waitFor(() => expect(usageSummaryMock).toHaveBeenCalledExactlyOnceWith(
        "company-1",
        Intl.DateTimeFormat().resolvedOptions().timeZone,
        {},
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
    usageSummaryMock.mockResolvedValue(summary({ totalCostCents: "1250.0000000" }));
    renderPage();
    await act(async () => {
      await vi.waitFor(() => expect(metricValue("Total requests")).toBe("12"));
    });
    // Headline row: the Total Cost card sums the window's priced rows and
    // carries the unpriced badge while any row lacks an allocation.
    expect(metricValue("Total cost")).toContain("$12.50");
    expect(metricValue("Total cost")).toContain("12 unpriced");
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

  it("omits the unpriced badge once every request carries an allocation", async () => {
    usageSummaryMock.mockResolvedValue(summary({ totalCostCents: "99.5000000", unpricedCount: 0 }));
    renderPage();
    await act(async () => {
      await vi.waitFor(() => expect(metricValue("Total cost")).toContain("$1.00"));
    });
    expect(metricValue("Total cost")).not.toContain("unpriced");
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
    expect(cells[4]).toBe("Unpriced");
    expect(cells[5]).toBe("—");
    expect(cells[6]).toBe("—");
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

  describe("filters", () => {
    it("renders app chips from the summary facets plus an All item", async () => {
      usageSummaryMock.mockResolvedValue(summaryWithFacets());
      renderPage();
      await act(async () => {
        await vi.waitFor(() => expect(appChipLabels()).toEqual(["All", "opencode"]));
      });
      // Chips carry their window request count.
      const chip = [...container.querySelectorAll('div[aria-label="Filter by app"] button')][1]!;
      expect(chip.textContent).toContain("5");
    });

    it("renders only facet chips even when the URL names an app the window never saw", async () => {
      usageSummaryMock.mockResolvedValue(summaryWithFacets());
      renderPage("/?app=ghost");
      await act(async () => {
        await vi.waitFor(() => expect(appChipLabels()).toEqual(["All", "opencode"]));
      });
      // No dead chip for "ghost" — but the filter still applies to the data.
      expect(usageLogsMock).toHaveBeenLastCalledWith("company-1", { app: "ghost" });
    });

    it("applies the clicked app chip to both reads and the URL", async () => {
      usageSummaryMock.mockResolvedValue(summaryWithFacets());
      renderPage();
      await act(async () => {
        await vi.waitFor(() => expect(appChipLabels()).toContain("opencode"));
      });
      const chip = [...container.querySelectorAll('div[aria-label="Filter by app"] button')]
        .find((button) => button.textContent!.startsWith("opencode"))!;
      await act(async () => {
        chip.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await act(async () => {
        await vi.waitFor(() => expect(usageLogsMock).toHaveBeenLastCalledWith("company-1", { app: "opencode" }));
      });
      expect(usageSummaryMock).toHaveBeenLastCalledWith("company-1", expect.any(String), { app: "opencode" });
      expect(locationSearch()).toBe("?app=opencode");
    });

    it("initializes filters from the URL and drops them again on All", async () => {
      usageSummaryMock.mockResolvedValue(summaryWithFacets());
      renderPage("/?app=opencode&status=client_error");
      await act(async () => {
        await vi.waitFor(() => expect(usageLogsMock).toHaveBeenLastCalledWith(
          "company-1",
          { app: "opencode", status: "client_error" },
        ));
      });
      await act(async () => {
        await vi.waitFor(() => expect(container.querySelector('div[aria-label="Filter by app"]')).not.toBeNull());
      });
      const allChip = container.querySelector('div[aria-label="Filter by app"] button')!;
      await act(async () => {
        allChip.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await act(async () => {
        await vi.waitFor(() => expect(usageLogsMock).toHaveBeenLastCalledWith("company-1", { status: "client_error" }));
      });
      expect(locationSearch()).toBe("?status=client_error");
    });

    it("applies the provider, model and status selects to both reads and the URL", async () => {
      usageSummaryMock.mockResolvedValue(summaryWithFacets());
      renderPage();
      await act(async () => {
        await vi.waitFor(() => expect(container.querySelector('select[aria-label="Filter by provider"]')).not.toBeNull());
      });
      const providerSelect = container.querySelector('select[aria-label="Filter by provider"]') as HTMLSelectElement;
      await act(async () => {
        providerSelect.value = "openrouter";
        providerSelect.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await act(async () => {
        await vi.waitFor(() => expect(usageLogsMock).toHaveBeenLastCalledWith("company-1", { provider: "openrouter" }));
      });

      const modelSelect = container.querySelector('select[aria-label="Filter by model"]') as HTMLSelectElement;
      // The model options come from the summary facets; wait for them before
      // selecting a value the select does not carry yet.
      await act(async () => {
        await vi.waitFor(() => expect(
          container.querySelector('select[aria-label="Filter by model"] option[value="z-ai/glm-4.6"]'),
        ).not.toBeNull());
      });
      await act(async () => {
        modelSelect.value = "z-ai/glm-4.6";
        modelSelect.dispatchEvent(new Event("change", { bubbles: true }));
      });
      const statusSelect = container.querySelector('select[aria-label="Filter by status"]') as HTMLSelectElement;
      await act(async () => {
        statusSelect.value = "server_error";
        statusSelect.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await act(async () => {
        await vi.waitFor(() => expect(usageLogsMock).toHaveBeenLastCalledWith(
          "company-1",
          { provider: "openrouter", model: "z-ai/glm-4.6", status: "server_error" },
        ));
      });
      expect(usageSummaryMock).toHaveBeenLastCalledWith(
        "company-1",
        expect.any(String),
        { provider: "openrouter", model: "z-ai/glm-4.6", status: "server_error" },
      );
      expect(locationSearch()).toBe("?provider=openrouter&model=z-ai%2Fglm-4.6&status=server_error");
    });

    it("shows the filtered empty state naming the current filters", async () => {
      renderPage("/?app=opencode&status=client_error");
      await act(async () => {
        await vi.waitFor(() => expect(container.textContent).toContain("No requests match the current filters"));
      });
      // The empty state names every active filter, not a bare empty table.
      expect(container.textContent).toContain('app "opencode"');
      expect(container.textContent).toContain("status 4xx client error");
      expect(container.textContent).not.toContain("No requests observed yet");
    });

    it("marks the data regions busy while a filter change refetches behind the bridge", async () => {
      renderPage();
      await act(async () => {
        await vi.waitFor(() => expect(metricValue("Total requests")).toBe("12"));
      });
      // The summary read for the narrowed window hangs: the placeholder
      // bridge keeps the previous data on screen, now marked busy so the
      // stale figures are not mistaken for the filtered answer.
      const deferred = createDeferred<UsageSummary>();
      usageSummaryMock.mockImplementation(() => deferred.promise);
      const statusSelect = container.querySelector('select[aria-label="Filter by status"]') as HTMLSelectElement;
      await act(async () => {
        statusSelect.value = "server_error";
        statusSelect.dispatchEvent(new Event("change", { bubbles: true }));
      });
      // The logs read settles into the filtered empty state while the summary
      // is still in flight — content, not skeleton.
      await act(async () => {
        await vi.waitFor(() => expect(container.textContent).toContain("No requests match the current filters"));
      });
      expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
      expect(metricValue("Total requests")).toBe("12");
      await act(async () => {
        deferred.resolve(summary({ totalRequests: 3 }));
        await deferred.promise;
      });
      await act(async () => {
        await vi.waitFor(() => expect(container.querySelector('[aria-busy="true"]')).toBeNull());
      });
      expect(metricValue("Total requests")).toBe("3");
    });
  });
});
