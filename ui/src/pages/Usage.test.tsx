// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Usage } from "./Usage";
import { ApiError } from "../api/client";
import { formatDateTime } from "../lib/utils";
import type { UsageRequestLogPage, UsageRequestLogRow, UsageSummary } from "@paperclipai/shared";

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

/** The frozen clock the preference tests read windows against. */
const NOW = new Date("2026-11-05T12:00:00Z");
const DEFAULT_FROM = "2026-11-04T12:00:00.000Z"; // last 24 hours
const FROM_7D = "2026-10-29T12:00:00.000Z";
const FROM_30D = "2026-10-06T12:00:00.000Z";

/** One keyset page as the logs endpoint now answers (docs/specs/usage-request-logs.md, API). */
function pageOf(rows: UsageRequestLogRow[], total: number = rows.length, nextCursor: string | null = null): UsageRequestLogPage {
  return { rows, total, nextCursor };
}

/**
 * Every logs read carries the page size and the keyset cursor (null on page
 * one) on top of the filters, per the paginated endpoint contract.
 */
function expectLastLogsCall(filters: Record<string, unknown>, limit: number = 20, after: string | null = null) {
  expect(usageLogsMock).toHaveBeenLastCalledWith("company-1", filters, limit, after);
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
    facets: { apps: [], providers: [], models: [], modelsTruncated: false },
    ...overrides,
  };
}

function summaryWithFacets(): UsageSummary {
  return summary({
    facets: {
      apps: [{ value: "opencode", requests: 5 }],
      providers: [{ value: "openrouter", requests: 3 }, { value: "anthropic", requests: 2 }],
      models: [{ value: "z-ai/glm-4.6", requests: 5 }],
      modelsTruncated: false,
    },
  });
}

describe("Usage page", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null = null;
  let activeQueryClient: QueryClient | null = null;

  function renderPage(initialUrl = "/") {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    activeQueryClient = queryClient;
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

  /**
   * Re-renders the mounted page in place (same router and query client), so
   * a test can change the mocked company selection mid-flight the way a
   * company switch does in the app.
   */
  function rerenderPage() {
    act(() => {
      root!.render(
        <MemoryRouter initialEntries={[]}>
          <QueryClientProvider client={activeQueryClient!}>
            <div>
              <Usage />
              <LocationProbe />
            </div>
          </QueryClientProvider>
        </MemoryRouter>,
      );
    });
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

    async function clickButton(label: "Next" | "Previous") {
      const button = [...container.querySelectorAll("button")].find((el) => el.textContent === label)!;
      await act(async () => {
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await Promise.resolve();
      });
    }



/**
 * The shareable URL's params, compared parsed: URLSearchParams serializes
 * the colons of an ISO `from` as %3A, which would make exact-string
 * assertions unreadable without saying anything about the state.
 */
function expectLocationParams(pairs: Record<string, string>) {
  const actual = new URLSearchParams(locationSearch());
  const keys = Object.keys(pairs);
  expect([...actual.keys()].sort()).toEqual([...keys].sort());
  for (const key of keys) expect(actual.get(key)).toBe(pairs[key]);
}

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    companyState.selectedCompanyId = "company-1";
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
    usageLogsMock.mockReset();
    usageLogsMock.mockResolvedValue(pageOf([]));
    usageSummaryMock.mockReset();
    usageSummaryMock.mockResolvedValue(summary());
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container.remove();
    localStorage.clear();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("fetches the usage logs endpoint for the selected company", async () => {
    renderPage();
    await act(async () => {
      await vi.waitFor(() => expect(usageLogsMock).toHaveBeenCalledExactlyOnceWith("company-1", { from: DEFAULT_FROM }, 20, null));
    });
    expect(setBreadcrumbsMock).toHaveBeenCalledWith([{ label: "Usage" }]);
  });

  it("renders request rows with the P1 skeleton columns", async () => {
    usageLogsMock.mockResolvedValue(pageOf([
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
    ]));
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
    usageLogsMock.mockResolvedValue(pageOf([
      row({ costCents: "150.0000000", costStatus: "priced" }),
      row({ id: "44444444-4444-4444-8444-444444444444", requestId: "req-unpriced", costCents: null, costStatus: "unpriced" }),
    ]));
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
        { from: DEFAULT_FROM },
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
    usageLogsMock.mockResolvedValue(pageOf([row()]));
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
    usageLogsMock.mockResolvedValue(pageOf([
      row({ httpStatus: null, durationMs: null }),
    ]));
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
      expectLastLogsCall({ app: "ghost", from: DEFAULT_FROM });
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
        await vi.waitFor(() => expectLastLogsCall({ app: "opencode", from: DEFAULT_FROM }));
      });
      expect(usageSummaryMock).toHaveBeenLastCalledWith("company-1", expect.any(String), { app: "opencode", from: DEFAULT_FROM });
      expectLocationParams({ app: "opencode", from: DEFAULT_FROM });
    });

    it("initializes filters from the URL and drops them again on All", async () => {
      usageSummaryMock.mockResolvedValue(summaryWithFacets());
      renderPage("/?app=opencode&status=client_error");
      await act(async () => {
        await vi.waitFor(() => expectLastLogsCall({ app: "opencode", status: "client_error", from: DEFAULT_FROM }));
      });
      await act(async () => {
        await vi.waitFor(() => expect(container.querySelector('div[aria-label="Filter by app"]')).not.toBeNull());
      });
      const allChip = container.querySelector('div[aria-label="Filter by app"] button')!;
      await act(async () => {
        allChip.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await act(async () => {
        await vi.waitFor(() => expectLastLogsCall({ status: "client_error", from: DEFAULT_FROM }));
      });
      expectLocationParams({ status: "client_error", from: DEFAULT_FROM });
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
        await vi.waitFor(() => expectLastLogsCall({ provider: "openrouter", from: DEFAULT_FROM }));
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
        await vi.waitFor(() => expectLastLogsCall({ provider: "openrouter", model: "z-ai/glm-4.6", status: "server_error", from: DEFAULT_FROM }));
      });
      expect(usageSummaryMock).toHaveBeenLastCalledWith(
        "company-1",
        expect.any(String),
        { provider: "openrouter", model: "z-ai/glm-4.6", status: "server_error", from: DEFAULT_FROM },
      );
      expectLocationParams({ provider: "openrouter", model: "z-ai/glm-4.6", status: "server_error", from: DEFAULT_FROM });
    });

    it("keeps showing a selected model the window's facets no longer list", async () => {
      usageSummaryMock.mockResolvedValue(summaryWithFacets());
      // A shared/remembered URL can name a model outside the current window's
      // top-50 facets — the select must still display the applied value.
      renderPage("/?model=openai/gpt-5.2");
      await act(async () => {
        await vi.waitFor(() => expectLastLogsCall({ model: "openai/gpt-5.2", from: DEFAULT_FROM }));
      });
      await act(async () => {
        await vi.waitFor(() => expect(container.querySelector('select[aria-label="Filter by model"]')).not.toBeNull());
      });
      const modelSelect = container.querySelector('select[aria-label="Filter by model"]') as HTMLSelectElement;
      await act(async () => {
        await vi.waitFor(() => expect(modelSelect.value).toBe("openai/gpt-5.2"));
      });
      const option = modelSelect.querySelector('option[value="openai/gpt-5.2"]')!;
      expect(option.textContent).toBe("openai/gpt-5.2");
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

  describe("table tabs", () => {
    /** The tab triggers as the table card's header renders them. */
    function tabTriggers(): HTMLElement[] {
      return [...container.querySelectorAll<HTMLElement>('[role="tab"]')];
    }
    function tabByLabel(label: string): HTMLElement {
      return tabTriggers().find((el) => el.textContent!.includes(label))!;
    }
    /** Radix tab triggers activate on mousedown, not click. */
    async function clickTab(label: string) {
      await act(async () => {
        tabByLabel(label).dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        await Promise.resolve();
      });
    }

    it("shows Request logs, Providers and Models tabs with a visible P2 marker on the placeholders", async () => {
      usageLogsMock.mockResolvedValue(pageOf([row()]));
      renderPage();
      await act(async () => {
        await vi.waitFor(() => expect(container.querySelector("tbody tr")).not.toBeNull());
      });
      expect(tabTriggers()).toHaveLength(3);
      expect(tabByLabel("Request logs").getAttribute("aria-selected")).toBe("true");
      // The placeholder tabs are real, clickable controls, visibly marked P2.
      for (const label of ["Providers", "Models"]) {
        const tab = tabByLabel(label);
        expect(tab.tagName).toBe("BUTTON");
        expect(tab.hasAttribute("disabled")).toBe(false);
        expect(tab.textContent).toContain(label);
        expect(tab.textContent).toContain("P2");
      }
      expect(tabByLabel("Request logs").textContent).not.toContain("P2");
    });

    it("renders a short coming-in-P2 panel instead of an empty table on the placeholder tabs", async () => {
      renderPage();
      await act(async () => {
        await vi.waitFor(() => expect(usageLogsMock).toHaveBeenCalledExactlyOnceWith("company-1", { from: DEFAULT_FROM }, 20, null));
      });
      // The tab strip lives in the settled card, past the initial skeleton.
      await act(async () => {
        await vi.waitFor(() => expect(tabTriggers()).toHaveLength(3));
      });
      await clickTab("Providers");
      expect(container.querySelector("table")).toBeNull();
      expect(container.textContent).toContain("per-provider breakdown");
      // The logs empty state must not bleed into the placeholder view.
      expect(container.textContent).not.toContain("No requests observed yet");
      await clickTab("Models");
      expect(container.querySelector("table")).toBeNull();
      expect(container.textContent).toContain("per-model breakdown");
      expect(container.textContent).not.toContain("No requests observed yet");
    });

    it("switching tabs sends no requests and restores the logs view with filters, page and cursor intact", async () => {
      usageLogsMock.mockImplementation((_companyId: string, _filters: unknown, _limit: number, after: string | null) => {
        if (after == null) return Promise.resolve(pageOf([row({ requestId: "tab-1", occurredAt: "2026-11-04T10:00:00Z" })], 2, "cursor-tab"));
        if (after === "cursor-tab") return Promise.resolve(pageOf([row({ requestId: "tab-2", occurredAt: "2026-11-04T09:00:00Z" })], 2, null));
        return Promise.reject(new Error(`unexpected cursor ${after}`));
      });
      renderPage();
      await act(async () => {
        await vi.waitFor(() => expect(container.querySelector('select[aria-label="Filter by status"]')).not.toBeNull());
      });
      const statusSelect = container.querySelector('select[aria-label="Filter by status"]') as HTMLSelectElement;
      await act(async () => {
        statusSelect.value = "success";
        statusSelect.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await act(async () => {
        await vi.waitFor(() => expectLastLogsCall({ status: "success", from: DEFAULT_FROM }));
      });
      await act(async () => {
        await vi.waitFor(() => expect(container.querySelector("tbody tr")).not.toBeNull());
      });
      await clickButton("Next");
      const pageTwoTime = formatDateTime("2026-11-04T09:00:00Z", { includeSeconds: true });
      await act(async () => {
        await vi.waitFor(() => expect([...container.querySelectorAll("tbody tr td:first-child")].map((td) => td.textContent)).toEqual([pageTwoTime]));
      });
      const logsCalls = usageLogsMock.mock.calls.length;
      const summaryCalls = usageSummaryMock.mock.calls.length;
      // The switch itself triggers no reads — the queries stay mounted and
      // only the card's content is swapped.
      await clickTab("Providers");
      expect(usageLogsMock.mock.calls.length).toBe(logsCalls);
      expect(usageSummaryMock.mock.calls.length).toBe(summaryCalls);
      expect(container.querySelector("table")).toBeNull();
      await clickTab("Models");
      expect(usageLogsMock.mock.calls.length).toBe(logsCalls);
      expect(usageSummaryMock.mock.calls.length).toBe(summaryCalls);
      // Back: the full view returns exactly where it was — same filter, same
      // cursor-anchored page, no refetch.
      await clickTab("Request logs");
      expect(usageLogsMock.mock.calls.length).toBe(logsCalls);
      expect(usageSummaryMock.mock.calls.length).toBe(summaryCalls);
      expect(tabByLabel("Request logs").getAttribute("aria-selected")).toBe("true");
      expect([...container.querySelectorAll("tbody tr td:first-child")].map((td) => td.textContent)).toEqual([pageTwoTime]);
      expect(usageLogsMock).toHaveBeenLastCalledWith("company-1", { status: "success", from: DEFAULT_FROM }, 20, "cursor-tab");
      expectLocationParams({ status: "success", from: DEFAULT_FROM });
    });
  });

  describe("pagination", () => {
    /** Rows for the walk test: seven distinct requests across three pages. */
    const walkRows: UsageRequestLogRow[] = Array.from({ length: 7 }, (_, index) =>
      row({
        id: `55555555-5555-4555-8555-${String(index).padStart(12, "0")}`,
        requestId: `req-${index}`,
        occurredAt: new Date(Date.UTC(2026, 10, 4, 12, index)).toISOString(),
      }),
    );
    /** The Time-cell text each walk row renders (the table's row identity). */
    const times = (rows: UsageRequestLogRow[]) =>
      rows.map((r) => formatDateTime(r.occurredAt, { includeSeconds: true }));

    /** Three keyset pages keyed by the `after` cursor, as the server would serve them. */
    function mockThreePages() {
      usageLogsMock.mockImplementation((_companyId: string, _filters: unknown, _limit: number, after: string | null) => {
        if (after == null) return Promise.resolve(pageOf(walkRows.slice(0, 3), 7, "cursor-1"));
        if (after === "cursor-1") return Promise.resolve(pageOf(walkRows.slice(3, 6), 7, "cursor-2"));
        if (after === "cursor-2") return Promise.resolve(pageOf(walkRows.slice(6, 7), 7, null));
        return Promise.reject(new Error(`unexpected cursor ${after}`));
      });
    }

    function renderedRowTimes(): string[] {
      return [...container.querySelectorAll("tbody tr td:first-child")].map((td) => td.textContent!);
    }

    async function waitForRendered(expected: string[]) {
      await act(async () => {
        await vi.waitFor(() => expect(renderedRowTimes()).toEqual(expected));
      });
    }

    it("walks every row exactly once across pages: no duplicates, no gaps", async () => {
      mockThreePages();
      renderPage();
      const seen: string[] = [];
      await waitForRendered(times(walkRows.slice(0, 3)));
      seen.push(...renderedRowTimes());
      await clickButton("Next");
      await waitForRendered(times(walkRows.slice(3, 6)));
      seen.push(...renderedRowTimes());
      await clickButton("Next");
      await waitForRendered(times(walkRows.slice(6, 7)));
      seen.push(...renderedRowTimes());
      // Every row, in order, exactly once.
      expect(seen).toEqual(times(walkRows));
      expect(new Set(seen).size).toBe(seen.length);
      expect(usageLogsMock).toHaveBeenNthCalledWith(2, "company-1", { from: DEFAULT_FROM }, 20, "cursor-1");
      expect(usageLogsMock).toHaveBeenNthCalledWith(3, "company-1", { from: DEFAULT_FROM }, 20, "cursor-2");
    });

    it("renders the total matching count and disables turning past the last page", async () => {
      mockThreePages();
      renderPage();
      await act(async () => {
        await vi.waitFor(() => expect(container.textContent).toContain("7 matching requests"));
      });
      await clickButton("Next");
      await waitForRendered(times(walkRows.slice(3, 6)));
      await clickButton("Next");
      await waitForRendered(times(walkRows.slice(6, 7)));
      expect(container.textContent).toContain("Page 3");
      const next = [...container.querySelectorAll("button")].find((button) => button.textContent === "Next")!;
      expect(next.hasAttribute("disabled")).toBe(true);
    });

    it("returns to the previous page's anchored read with Previous", async () => {
      mockThreePages();
      renderPage();
      await waitForRendered(times(walkRows.slice(0, 3)));
      await clickButton("Next");
      await waitForRendered(times(walkRows.slice(3, 6)));
      await clickButton("Previous");
      await act(async () => {
        await vi.waitFor(() => expect(usageLogsMock).toHaveBeenLastCalledWith("company-1", { from: DEFAULT_FROM }, 20, null));
      });
      await waitForRendered(times(walkRows.slice(0, 3)));
      expect(container.textContent).toContain("Page 1");
    });

    it("disables both page turns while a filter change bridges the previous page", async () => {
      mockThreePages();
      renderPage();
      await waitForRendered(times(walkRows.slice(0, 3)));
      await clickButton("Next");
      await waitForRendered(times(walkRows.slice(3, 6)));
      // The narrowed read hangs: the placeholder bridge keeps page two (and
      // its nextCursor) on screen while the new epoch's page one is in
      // flight — its cursor must not be reachable.
      const deferred = createDeferred<UsageRequestLogPage>();
      usageLogsMock.mockImplementation(() => deferred.promise);
      const statusSelect = container.querySelector('select[aria-label="Filter by status"]') as HTMLSelectElement;
      await act(async () => {
        statusSelect.value = "server_error";
        statusSelect.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await act(async () => {
        await vi.waitFor(() => {
          const next = [...container.querySelectorAll("button")].find((button) => button.textContent === "Next")!;
          expect(next.hasAttribute("disabled")).toBe(true);
        });
      });
      const previous = [...container.querySelectorAll("button")].find((button) => button.textContent === "Previous")!;
      expect(previous.hasAttribute("disabled")).toBe(true);
      await act(async () => {
        deferred.resolve(pageOf(walkRows.slice(0, 3), 7, "cursor-filtered"));
        await deferred.promise;
      });
      // The real page settles and the turns come back.
      await act(async () => {
        await vi.waitFor(() => {
          const next = [...container.querySelectorAll("button")].find((button) => button.textContent === "Next")!;
          expect(next.hasAttribute("disabled")).toBe(false);
        });
      });
    });

    it("starts over at page one when a filter changes", async () => {
      mockThreePages();
      renderPage();
      await waitForRendered(times(walkRows.slice(0, 3)));
      await clickButton("Next");
      await act(async () => {
        await vi.waitFor(() => expect(usageLogsMock).toHaveBeenLastCalledWith("company-1", { from: DEFAULT_FROM }, 20, "cursor-1"));
      });
      const statusSelect = container.querySelector('select[aria-label="Filter by status"]') as HTMLSelectElement;
      await act(async () => {
        statusSelect.value = "success";
        statusSelect.dispatchEvent(new Event("change", { bubbles: true }));
      });
      // The narrowed read is a fresh walk: page one, no cursor, no stale history.
      await act(async () => {
        await vi.waitFor(() => expectLastLogsCall({ status: "success", from: DEFAULT_FROM }));
      });
      expect(container.textContent).toContain("Page 1");
    });

    it("changes the page size, restarts at page one and remembers it", async () => {
      mockThreePages();
      renderPage();
      await waitForRendered(times(walkRows.slice(0, 3)));
      await clickButton("Next");
      await act(async () => {
        await vi.waitFor(() => expect(usageLogsMock).toHaveBeenLastCalledWith("company-1", { from: DEFAULT_FROM }, 20, "cursor-1"));
      });
      const sizeSelect = container.querySelector('select[aria-label="Rows per page"]') as HTMLSelectElement;
      await act(async () => {
        sizeSelect.value = "50";
        sizeSelect.dispatchEvent(new Event("change", { bubbles: true }));
      });
      // A different page size is a different walk: page one, no cursor.
      await act(async () => {
        await vi.waitFor(() => expect(usageLogsMock).toHaveBeenLastCalledWith("company-1", { from: DEFAULT_FROM }, 50, null));
      });
      expect(container.textContent).toContain("Page 1");
      expect(JSON.parse(localStorage.getItem("paperclip.usagePrefs:company-1")!))
        .toEqual(expect.objectContaining({ pageSize: 50 }));
    });
  });

  describe("remembered preferences and time range", () => {
    function seedPreferences(companyId: string, preferences: unknown) {
      localStorage.setItem(`paperclip.usagePrefs:${companyId}`, JSON.stringify(preferences));
    }
    function storedPreferences(companyId: string): Record<string, unknown> {
      return JSON.parse(localStorage.getItem(`paperclip.usagePrefs:${companyId}`)!);
    }

    /** The filter bar renders once the first read lands; wait for a select. */
    async function selectByLabel(label: string): Promise<HTMLSelectElement> {
      let select: HTMLSelectElement | null = null;
      await act(async () => {
        await vi.waitFor(() => {
          select = container.querySelector(`select[aria-label="${label}"]`);
          expect(select).not.toBeNull();
        });
      });
      return select as unknown as HTMLSelectElement;
    }

    it("seeds a first visit with the spec defaults — last 24 hours, 20 rows — and writes nothing", async () => {
      renderPage();
      await act(async () => {
        await vi.waitFor(() => expect(usageLogsMock).toHaveBeenCalledExactlyOnceWith(
          "company-1",
          { from: DEFAULT_FROM },
          20,
          null,
        ));
      });
      // The URL carries the resolved absolute window so the view stays shareable.
      expectLocationParams({ from: DEFAULT_FROM });
      expect((await selectByLabel("Time range")).value).toBe("24h");
      expect((await selectByLabel("Rows per page")).value).toBe("20");
      // A first visit's defaults are implied by absent storage.
      expect(localStorage.getItem("paperclip.usagePrefs:company-1")).toBeNull();
    });

    it("restores the remembered range, page size and filters, producing the same request on the next visit", async () => {
      seedPreferences("company-1", {
        range: "7d",
        pageSize: 50,
        filters: { provider: "openrouter", status: "server_error" },
      });
      renderPage();
      await act(async () => {
        await vi.waitFor(() => expect(usageLogsMock).toHaveBeenCalledExactlyOnceWith(
          "company-1",
          { from: FROM_7D, provider: "openrouter", status: "server_error" },
          50,
          null,
        ));
      });
      expectLocationParams({ from: FROM_7D, provider: "openrouter", status: "server_error" });
      // The next visit replays the identical request against the same storage.
      act(() => root?.unmount());
      container.remove();
      container = document.createElement("div");
      document.body.appendChild(container);
      usageLogsMock.mockClear();
      // waitFor polls advance the faked clock; re-anchor it so the rolling
      // window re-derives the same absolute bounds.
      vi.setSystemTime(NOW);
      renderPage();
      await act(async () => {
        await vi.waitFor(() => expect(usageLogsMock).toHaveBeenCalledExactlyOnceWith(
          "company-1",
          { from: FROM_7D, provider: "openrouter", status: "server_error" },
          50,
          null,
        ));
      });
    });

    it("lets an explicit URL param win over the remembered filters, seeding only the absent ones", async () => {
      seedPreferences("company-1", { range: "7d", pageSize: 20, filters: { app: "opencode" } });
      renderPage("/?provider=anthropic");
      await act(async () => {
        await vi.waitFor(() => expect(usageLogsMock).toHaveBeenCalledExactlyOnceWith(
          "company-1",
          { from: FROM_7D, app: "opencode", provider: "anthropic" },
          20,
          null,
        ));
      });
    });

    it("ignores a from the browser cannot parse and falls back to the remembered preset", async () => {
      seedPreferences("company-1", { range: "30d", pageSize: 20, filters: {} });
      renderPage("/?from=nope");
      await act(async () => {
        await vi.waitFor(() => expect(usageLogsMock).toHaveBeenCalledExactlyOnceWith(
          "company-1",
          { from: FROM_30D },
          20,
          null,
        ));
      });
      // The seed pass replaced the unusable bound with the preset's.
      expectLocationParams({ from: FROM_30D });
    });

    it("ignores a reversed window the same way", async () => {
      renderPage("/?from=2026-11-05T00:00:00Z&to=2026-11-04T00:00:00Z");
      await act(async () => {
        await vi.waitFor(() => expect(usageLogsMock).toHaveBeenCalledExactlyOnceWith(
          "company-1",
          { from: DEFAULT_FROM },
          20,
          null,
        ));
      });
      expectLocationParams({ from: DEFAULT_FROM });
    });

    it("applies a custom from/to handed in the URL and labels the select Custom", async () => {
      renderPage("/?from=2026-11-01T00:00:00Z&to=2026-11-02T00:00:00Z");
      await act(async () => {
        await vi.waitFor(() => expect(usageLogsMock).toHaveBeenCalledExactlyOnceWith(
          "company-1",
          { from: "2026-11-01T00:00:00Z", to: "2026-11-02T00:00:00Z" },
          20,
          null,
        ));
      });
      expect((await selectByLabel("Time range")).value).toBe("custom");
      // Custom bounds are a view state, never written over the remembered preset.
      expect(localStorage.getItem("paperclip.usagePrefs:company-1")).toBeNull();
    });

    it("applies a preset selection to the URL and remembers it, including All time", async () => {
      renderPage();
      await act(async () => {
        await vi.waitFor(() => expect(usageLogsMock).toHaveBeenCalledExactlyOnceWith(
          "company-1",
          { from: DEFAULT_FROM },
          20,
          null,
        ));
      });
      const rangeSelect = await selectByLabel("Time range");
      // waitFor polls advance the faked clock; re-anchor it so the preset's
      // fresh window derives the exact absolute bounds.
      vi.setSystemTime(NOW);
      await act(async () => {
        rangeSelect.value = "30d";
        rangeSelect.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await act(async () => {
        await vi.waitFor(() => expectLastLogsCall({ from: FROM_30D }));
      });
      expectLocationParams({ from: FROM_30D });
      expect(storedPreferences("company-1")).toEqual(expect.objectContaining({ range: "30d" }));
      // "All time" bounds nothing — no from, no to.
      await act(async () => {
        rangeSelect.value = "all";
        rangeSelect.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await act(async () => {
        await vi.waitFor(() => expectLastLogsCall({}));
      });
      expect(locationSearch()).toBe("");
      expect(storedPreferences("company-1")).toEqual(expect.objectContaining({ range: "all" }));
    });

    it("does not resurrect a cleared filter from storage after the seed pass", async () => {
      seedPreferences("company-1", { range: "24h", pageSize: 20, filters: { app: "opencode" } });
      renderPage();
      await act(async () => {
        await vi.waitFor(() => expectLastLogsCall({ app: "opencode", from: DEFAULT_FROM }));
      });
      let allChip: HTMLButtonElement | null = null;
      await act(async () => {
        await vi.waitFor(() => {
          allChip = container.querySelector('div[aria-label="Filter by app"] button');
          expect(allChip).not.toBeNull();
        });
      });
      await act(async () => {
        (allChip as unknown as HTMLButtonElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await act(async () => {
        await vi.waitFor(() => expectLastLogsCall({ from: DEFAULT_FROM }));
      });
      expectLocationParams({ from: DEFAULT_FROM });
      // The cleared state is the new remembered one.
      expect(storedPreferences("company-1")).toEqual(expect.objectContaining({ filters: {} }));
    });

    it("switches companies to their own remembered selection", async () => {
      seedPreferences("company-1", { range: "7d", pageSize: 20, filters: {} });
      seedPreferences("company-2", { range: "all", pageSize: 100, filters: { app: "opencode" } });
      renderPage();
      await act(async () => {
        await vi.waitFor(() => expect(usageLogsMock).toHaveBeenCalledExactlyOnceWith(
          "company-1",
          { from: FROM_7D },
          20,
          null,
        ));
      });
      companyState.selectedCompanyId = "company-2";
      rerenderPage();
      await act(async () => {
        await vi.waitFor(() => expect(usageLogsMock).toHaveBeenLastCalledWith(
          "company-2",
          { app: "opencode" },
          100,
          null,
        ));
      });
      // The previous company's window did not leak into the new company's URL.
      expectLocationParams({ app: "opencode" });
    });
  });

  describe("polling and refresh", () => {
    /**
     * One flush pass under faked timers: microtasks plus a 0ms tick —
     * react-query's store notification lands on the (faked) timer tick, not
     * a bare microtask, so the render needs it to catch up.
     */
    async function flushPass() {
      await act(async () => {
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(0);
      });
    }

    /** Drains the fetch promise chain under faked timers (no clock movement). */
    async function settle() {
      for (let turn = 0; turn < 6; turn += 1) {
        await flushPass();
      }
    }

    /** Flushes until a condition holds (vi.waitFor would advance the faked clock). */
    async function settleUntil(check: () => boolean) {
      for (let turn = 0; turn < 50 && !check(); turn += 1) {
        await flushPass();
      }
      expect(check()).toBe(true);
    }

    function setTabHidden(hidden: boolean) {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (hidden ? "hidden" : "visible") });
      window.dispatchEvent(new Event("visibilitychange"));
    }

    afterEach(() => {
      // Drop the visibilityState override so jsdom's own getter applies again.
      delete (document as { visibilityState?: unknown }).visibilityState;
    });

    it("re-reads both endpoints every 30 seconds while the page is open", async () => {
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"], now: NOW });
      renderPage();
      await settle();
      const logsCalls = usageLogsMock.mock.calls.length;
      const summaryCalls = usageSummaryMock.mock.calls.length;
      expect(logsCalls).toBeGreaterThan(0);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      await settle();
      expect(usageLogsMock.mock.calls.length).toBeGreaterThan(logsCalls);
      expect(usageSummaryMock.mock.calls.length).toBeGreaterThan(summaryCalls);
    });

    it("pauses the poll while the tab is hidden and resumes when it is visible again", async () => {
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"], now: NOW });
      renderPage();
      await settle();
      const callsAtHide = usageLogsMock.mock.calls.length;
      setTabHidden(true);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(90_000);
      });
      await settle();
      // Three poll ticks passed without a single extra read.
      expect(usageLogsMock.mock.calls.length).toBe(callsAtHide);
      setTabHidden(false);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      await settle();
      expect(usageLogsMock.mock.calls.length).toBeGreaterThan(callsAtHide);
    });

    it("keeps a cursor-anchored page stable when a poll brings newer rows", async () => {
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"], now: NOW });
      const pageTwoRow = row({ requestId: "req-anchored", occurredAt: "2026-11-04T11:00:00Z" });
      usageLogsMock.mockImplementation((_companyId: string, _filters: unknown, _limit: number, after: string | null) => {
        if (after == null) {
          // Page one keeps admitting newer rows on every read.
          return Promise.resolve(pageOf([row({ requestId: `newer-${usageLogsMock.mock.calls.length}` })], 4, "cursor-1"));
        }
        return Promise.resolve(pageOf([pageTwoRow], 4, null));
      });
      renderPage();
      await settle();
      await settleUntil(() => [...container.querySelectorAll("button")].some((el) => el.textContent === "Next"));
      await clickButton("Next");
      await settle();
      // The anchored page fetched once through its cursor.
      await act(async () => {
        await vi.waitFor(() => expect(usageLogsMock).toHaveBeenLastCalledWith(
          "company-1",
          { from: DEFAULT_FROM },
          20,
          "cursor-1",
        ));
      });
      const anchoredCells = [...container.querySelectorAll("tbody tr td")].map((td) => td.textContent);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      await settle();
      // The poll re-read the SAME anchored page — the cursor survived, so the
      // newer rows that landed on page one cannot shift this view.
      expect(usageLogsMock).toHaveBeenLastCalledWith("company-1", { from: DEFAULT_FROM }, 20, "cursor-1");
      expect([...container.querySelectorAll("tbody tr td")].map((td) => td.textContent)).toEqual(anchoredCells);
    });

    it("does not flicker the busy state while a background poll refetches", async () => {
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"], now: NOW });
      renderPage();
      await settle();
      expect(document.querySelector('[aria-busy="true"]')).toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      await settle();
      // The poll re-read real data: the cards and table stay marked not-busy.
      expect(document.querySelector('[aria-busy="true"]')).toBeNull();
    });

    it("re-reads both endpoints on the manual refresh button", async () => {
      renderPage();
      await act(async () => {
        await vi.waitFor(() => expect(usageLogsMock).toHaveBeenCalledExactlyOnceWith(
          "company-1",
          { from: DEFAULT_FROM },
          20,
          null,
        ));
      });
      let refreshButton: HTMLButtonElement | null = null;
      await act(async () => {
        await vi.waitFor(() => {
          refreshButton = container.querySelector('button[aria-label="Refresh usage data"]');
          expect(refreshButton).not.toBeNull();
        });
      });
      usageLogsMock.mockClear();
      usageSummaryMock.mockClear();
      await act(async () => {
        (refreshButton as unknown as HTMLButtonElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await Promise.resolve();
      });
      await act(async () => {
        await vi.waitFor(() => {
          expect(usageLogsMock).toHaveBeenCalledTimes(1);
          expect(usageSummaryMock).toHaveBeenCalledTimes(1);
        });
      });
      // The refresh re-reads the current view, cursor included.
      expect(usageLogsMock).toHaveBeenLastCalledWith("company-1", { from: DEFAULT_FROM }, 20, null);
    });
  });
});
