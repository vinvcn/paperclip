// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, KeyPoolFailureSnapshot } from "@paperclipai/shared";
import { agentsApi } from "@/api/agents";
import { issuesApi } from "@/api/issues";
import { queryKeys } from "@/lib/queryKeys";
import { useKeyPoolFailureRecovery } from "./use-key-pool-failure-recovery";

// Radix Popover relies on Pointer Capture APIs that jsdom omits.
beforeAll(() => {
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.hasPointerCapture ??= () => false;
  if (!globalThis.ResizeObserver) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
  }
});

const { toastSpy } = vi.hoisted(() => ({ toastSpy: vi.fn() }));
const { connectionModels } = vi.hoisted(() => ({
  connectionModels: {
    models: [{ id: "paperclip/model-two", label: "Model Two" }],
    isLoading: false,
    error: null,
    refreshing: false,
    refreshModels: undefined,
    resolveModel: (model: string) => model,
  },
}));

vi.mock("@/context/ToastContext", () => ({
  useToastActions: () => ({ pushToast: toastSpy }),
}));

// The hook only builds the actions; the connection catalog shape itself is
// pinned by useConnectionModels and KeyPoolFailureActions tests.
vi.mock("@/components/ai-connections/useConnectionModels", () => ({
  useConnectionModels: () => connectionModels,
}));

const companyId = "22222222-2222-4222-8222-222222222222";
const issueId = "44444444-4444-4444-8444-444444444444";
const connectionId = "11111111-1111-4111-8111-111111111111";
const grantId = "33333333-3333-4333-8333-333333333333";

const agent = {
  id: "agent-1",
  adapterType: "paperclip_runner",
  adapterConfig: { provider: "openai" },
  runtimeConfig: {
    aiConnection: { mode: "shared", provider: "openai", method: "api_key", connectionId, grantId },
  },
} as unknown as Agent;

const snapshot: KeyPoolFailureSnapshot = {
  reason: "rate_limited",
  slot: 3,
  model: "z-ai/glm-5.3-flash",
  state: "rpm_cooldown",
  cooldownUntil: null,
  connectionId,
};

describe("useKeyPoolFailureRecovery", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let client: QueryClient;
  const retryFailedRun = vi.spyOn(agentsApi, "retryFailedRun");
  const updateIssue = vi.spyOn(issuesApi, "update");

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    container = document.createElement("div");
    document.body.append(container);
    toastSpy.mockReset();
    retryFailedRun.mockReset().mockResolvedValue({ runId: "successor-run", issueId: null } as never);
    updateIssue.mockReset().mockResolvedValue({ id: issueId } as never);
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    root = null;
    container.remove();
    vi.useRealTimers();
  });

  const flush = async () => {
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
  };

  const render = async (props: {
    snapshot?: KeyPoolFailureSnapshot | null;
    runId?: string | null;
    resolveFailedRun?: (runId: string) => { agentId: string; agent?: Agent } | undefined;
  } = {}) => {
    const observedRuns = new Map([["run-observed", { agentId: "agent-1", agent }]]);
    const resolve = props.resolveFailedRun ?? ((runId: string) => observedRuns.get(runId));
    const component = (
      <QueryClientProvider client={client}>
        <HookHarness
          options={{
            companyId,
            issueId,
            runsQueryRef: issueId,
            assigneeAdapterOverrides: null,
            resolveFailedRun: resolve,
          }}
          snapshot={"snapshot" in props ? props.snapshot ?? null : snapshot}
          runId={"runId" in props ? props.runId ?? null : "run-observed"}
        />
      </QueryClientProvider>
    );
    await act(async () => {
      root = createRoot(container);
      root.render(component);
    });
    await flush();
  };

  /** Radix Popover opens on the pointerdown→pointerup sequence, not a bare click. */
  const pointerClick = (selector: string) => {
    const el = container.querySelector<HTMLElement>(selector)!;
    el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }));
    el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, button: 0 }));
    el.click();
  };

  it("wakes the resolved failed run with the failed slot as a one-shot avoid", async () => {
    const invalidate = vi.spyOn(client, "invalidateQueries").mockResolvedValue(undefined as never);
    await render();
    container.querySelector<HTMLElement>('[data-testid="key-pool-try-again"]')!.click();
    await flush();
    expect(retryFailedRun).toHaveBeenCalledExactlyOnceWith(
      "agent-1", "run-observed", companyId, { avoidKeySlot: 3 },
    );
    // The re-dispatch refreshes the runs surfaces the marker and banner read.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.issues.runs(issueId) });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.issues.liveRuns(issueId) });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.issues.activeRun(issueId) });
  });

  it("switches keys by re-dispatching with a clean pool pick (no avoid)", async () => {
    await render();
    container.querySelector<HTMLElement>('[data-testid="key-pool-switch-key"]')!.click();
    await flush();
    expect(retryFailedRun).toHaveBeenCalledExactlyOnceWith(
      "agent-1", "run-observed", companyId, { avoidKeySlot: null },
    );
    expect(updateIssue).not.toHaveBeenCalled();
  });

  it("saves the model override from the connection catalog, then re-dispatches", async () => {
    await render();
    container.querySelector<HTMLElement>('[data-testid="key-pool-switch-model"]')!.click();
    await flush();
    // Radix portals the popover into document.body.
    const options = [...document.querySelectorAll<HTMLElement>('[data-testid="key-pool-model-option"]')];
    expect(options.map((option) => option.getAttribute("data-model"))).toEqual(["paperclip/model-two"]);
    options[0]!.click();
    await flush();
    expect(updateIssue).toHaveBeenCalledExactlyOnceWith(issueId, {
      assigneeAdapterOverrides: { adapterConfig: { model: "paperclip/model-two" } },
    });
    expect(retryFailedRun).toHaveBeenCalledExactlyOnceWith(
      "agent-1", "run-observed", companyId, { avoidKeySlot: null },
    );
  });

  it("renders nothing when the failed run cannot be resolved", async () => {
    await render({ runId: "run-gone" });
    expect(container.querySelector('[data-testid="key-pool-failure-actions"]')).toBeNull();
    expect(retryFailedRun).not.toHaveBeenCalled();
  });
});

function HookHarness(props: {
  options: Parameters<typeof useKeyPoolFailureRecovery>[0];
  snapshot: KeyPoolFailureSnapshot | null;
  runId: string | null;
}) {
  const { renderActions } = useKeyPoolFailureRecovery(props.options);
  return <>{renderActions({ snapshot: props.snapshot, runId: props.runId })}</>;
}
