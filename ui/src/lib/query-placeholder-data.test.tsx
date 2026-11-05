// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keepPreviousDataForSameCompany, keepPreviousDataForSameQueryTail } from "./query-placeholder-data";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function Harness({
  issueId,
  fetchIssueRuns,
}: {
  issueId: string;
  fetchIssueRuns: (issueId: string) => Promise<string[]>;
}) {
  const { data, isLoading } = useQuery({
    queryKey: ["issues", "live-runs", issueId],
    queryFn: () => fetchIssueRuns(issueId),
    placeholderData: keepPreviousDataForSameQueryTail(issueId),
  });

  return (
    <div data-testid="query-state">
      {JSON.stringify({
        issueId,
        runs: data ?? null,
        isLoading,
      })}
    </div>
  );
}

/**
 * Same key shape as the Usage page's filter reads: company at index 1,
 * mutable filters further down the tail.
 */
function CompanyHarness({
  companyId,
  filters,
  fetchRows,
}: {
  companyId: string;
  filters: Record<string, string>;
  fetchRows: (companyId: string, filters: Record<string, string>) => Promise<string[]>;
}) {
  const { data, isPlaceholderData, isLoading } = useQuery({
    queryKey: ["usage-request-logs", companyId, filters, 20],
    queryFn: () => fetchRows(companyId, filters),
    placeholderData: keepPreviousDataForSameCompany(companyId),
  });

  return (
    <div data-testid="query-state">
      {JSON.stringify({
        companyId,
        filters,
        rows: data ?? null,
        isPlaceholderData,
        isLoading,
      })}
    </div>
  );
}

describe("keepPreviousDataForSameQueryTail", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("clears issue-scoped placeholder data when the query tail changes", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          staleTime: Number.POSITIVE_INFINITY,
        },
      },
    });
    const root = createRoot(container);
    const issueBRuns = createDeferred<string[]>();

    queryClient.setQueryData(["issues", "live-runs", "issue-a"], ["run-a"]);

    const fetchIssueRuns = (issueId: string) => {
      if (issueId === "issue-a") return Promise.resolve(["run-a"]);
      if (issueId === "issue-b") return issueBRuns.promise;
      return Promise.resolve([]);
    };

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Harness issueId="issue-a" fetchIssueRuns={fetchIssueRuns} />
        </QueryClientProvider>,
      );
      await Promise.resolve();
    });

    expect(container.textContent).toBe(JSON.stringify({
      issueId: "issue-a",
      runs: ["run-a"],
      isLoading: false,
    }));

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Harness issueId="issue-b" fetchIssueRuns={fetchIssueRuns} />
        </QueryClientProvider>,
      );
      await Promise.resolve();
    });

    expect(container.textContent).toBe(JSON.stringify({
      issueId: "issue-b",
      runs: null,
      isLoading: true,
    }));

    act(() => {
      root.unmount();
    });
    queryClient.clear();
  });
});

describe("keepPreviousDataForSameCompany", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("keeps the previous rows while the same company's refetch is in flight", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          staleTime: Number.POSITIVE_INFINITY,
        },
      },
    });
    const root = createRoot(container);
    const refetch = createDeferred<string[]>();
    const fetchRows = vi.fn()
      .mockResolvedValueOnce(["row-a"])
      .mockReturnValue(refetch.promise);

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CompanyHarness companyId="company-a" filters={{}} fetchRows={fetchRows} />
        </QueryClientProvider>,
      );
      await Promise.resolve();
    });

    await act(async () => {
      await vi.waitFor(() => expect(container.textContent).toBe(JSON.stringify({
        companyId: "company-a",
        filters: {},
        rows: ["row-a"],
        isPlaceholderData: false,
        isLoading: false,
      })));
    });

    // Same company, narrowed filters: the key tail changes, the read is
    // pending, and the previous rows stay on screen as placeholder data.
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CompanyHarness companyId="company-a" filters={{ status: "client_error" }} fetchRows={fetchRows} />
        </QueryClientProvider>,
      );
      await Promise.resolve();
    });

    expect(container.textContent).toBe(JSON.stringify({
      companyId: "company-a",
      filters: { status: "client_error" },
      rows: ["row-a"],
      isPlaceholderData: true,
      isLoading: false,
    }));

    await act(async () => {
      refetch.resolve(["row-a2"]);
      await vi.waitFor(() => expect(container.textContent).toBe(JSON.stringify({
        companyId: "company-a",
        filters: { status: "client_error" },
        rows: ["row-a2"],
        isPlaceholderData: false,
        isLoading: false,
      })));
    });

    act(() => {
      root.unmount();
    });
    queryClient.clear();
  });

  it("clears the placeholder when the company changes, never bridging across companies", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          staleTime: Number.POSITIVE_INFINITY,
        },
      },
    });
    const root = createRoot(container);
    const companyBRuns = createDeferred<string[]>();

    queryClient.setQueryData(["usage-request-logs", "company-a", {}, 20], ["row-a"]);

    const fetchRows = (companyId: string) => {
      if (companyId === "company-a") return Promise.resolve(["row-a"]);
      return companyBRuns.promise;
    };

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CompanyHarness companyId="company-a" filters={{}} fetchRows={fetchRows} />
        </QueryClientProvider>,
      );
      await Promise.resolve();
    });

    expect(container.textContent).toBe(JSON.stringify({
      companyId: "company-a",
      filters: {},
      rows: ["row-a"],
      isPlaceholderData: false,
      isLoading: false,
    }));

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CompanyHarness companyId="company-b" filters={{}} fetchRows={fetchRows} />
        </QueryClientProvider>,
      );
      await Promise.resolve();
    });

    // Company b shows its own loading state, not company a's rows.
    expect(container.textContent).toBe(JSON.stringify({
      companyId: "company-b",
      filters: {},
      rows: null,
      isPlaceholderData: false,
      isLoading: true,
    }));

    await act(async () => {
      companyBRuns.resolve(["row-b"]);
      await vi.waitFor(() => expect(container.textContent).toBe(JSON.stringify({
        companyId: "company-b",
        filters: {},
        rows: ["row-b"],
        isPlaceholderData: false,
        isLoading: false,
      })));
    });

    act(() => {
      root.unmount();
    });
    queryClient.clear();
  });

  it("never bridges when the previous key carries no company segment", () => {
    const placeholder = keepPreviousDataForSameCompany<string>("company-a");
    // A key shorter than [scope, company, ...] has no company at index 1, and
    // neither does a missing previous query — nothing may be bridged.
    expect(placeholder("stale", { queryKey: ["usage-request-logs"] } as never)).toBeUndefined();
    expect(placeholder("stale", undefined)).toBeUndefined();
  });
});
