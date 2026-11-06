// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiConnectionKeySlot, KeyPoolFailureSnapshot } from "@paperclipai/shared";
import { KeyPoolFailureActions } from "./KeyPoolFailureActions";

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

const companyId = "22222222-2222-4222-8222-222222222222";
const connectionId = "11111111-1111-4111-8111-111111111111";
const grantId = "33333333-3333-4333-8333-333333333333";

const binding = {
  mode: "shared" as const,
  provider: "openai" as const,
  method: "api_key" as const,
  connectionId,
  grantId,
};

const snapshot: KeyPoolFailureSnapshot = {
  reason: "rate_limited",
  slot: 3,
  model: "z-ai/glm-5.3-flash",
  state: "rpm_cooldown",
  cooldownUntil: null,
  connectionId,
};

const slot = (overrides: Partial<AiConnectionKeySlot> = {}): AiConnectionKeySlot => ({
  id: `slot-${overrides.slot ?? 1}`,
  slot: 1,
  label: "nim-account-1",
  enabled: true,
  state: "healthy",
  cooldownUntil: null,
  cooldownReason: null,
  activeRunId: null,
  leaseExpiresAt: null,
  leaseAgentId: null,
  lastAssignedAgentId: null,
  createdAt: "2026-11-06T00:00:00.000Z",
  updatedAt: "2026-11-06T00:00:00.000Z",
  ...overrides,
});

function makeConnection(overrides: Record<string, unknown> = {}) {
  return {
    id: connectionId,
    grantId,
    provider: "openai",
    name: "NIM gateway",
    ownership: "shared",
    isDefault: false,
    ownerUserId: null,
    status: "connected",
    method: "api_key",
    routing: {
      kind: "gateway",
      protocol: "chat",
      baseUrl: "https://integrate.api.nvidia.example/v1",
      auth: "bearer",
      models: [
        { id: "z-ai/glm-5.3-flash", label: "GLM 5.3 Flash" },
        { id: "meta/llama-3.3-70b-instruct" },
      ],
    },
    ...overrides,
  };
}

describe("KeyPoolFailureActions", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let client: QueryClient;
  const fetchMock = vi.fn();
  const retry = vi.fn().mockResolvedValue(undefined);
  const switchModelRetry = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("fetch", fetchMock);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    container = document.createElement("div");
    document.body.append(container);
    fetchMock.mockReset().mockImplementation((url: string, init: RequestInit) => {
      if (url.endsWith("/ai-connections")) {
        return Promise.resolve(Response.json({
          connections: [makeConnection()],
          currentUserId: "user-1",
        }));
      }
      if (url.endsWith("/keys")) {
        return Promise.resolve(Response.json({
          connectionId,
          slots: [
            slot(),
            slot({ slot: 3, id: "slot-3", state: "rpm_cooldown", cooldownUntil: "2026-11-06T12:30:00.000Z", cooldownReason: "rpm" }),
          ],
        }));
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    root = null;
    container.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const flush = async () => {
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
  };

  const render = async (props: Partial<Parameters<typeof KeyPoolFailureActions>[0]> = {}) => {
    const component = (
      <QueryClientProvider client={client}>
        <KeyPoolFailureActions
          companyId={companyId}
          snapshot={snapshot}
          binding={binding}
          harness="opencode_local"
          retryPending={false}
          onRetry={retry}
          onSwitchModelRetry={switchModelRetry}
          {...props}
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

  it("offers the four recovery actions: try-again-avoid, switch-key, switch-model and key status", async () => {
    await render();
    expect(container.querySelector('[data-testid="key-pool-try-again"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="key-pool-switch-key"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="key-pool-switch-model"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="key-pool-key-status"]')).not.toBeNull();
    expect(container.textContent).toContain("picks another key");
  });

  it("retries the failed run avoiding the failed slot once", async () => {
    await render();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="key-pool-try-again"]')!.click();
    });
    expect(retry).toHaveBeenCalledExactlyOnceWith({ avoidKeySlot: 3 });
    expect(switchModelRetry).not.toHaveBeenCalled();
  });

  it("retries the failed run letting the pool switch keys", async () => {
    await render();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="key-pool-switch-key"]')!.click();
    });
    expect(retry).toHaveBeenCalledExactlyOnceWith({ avoidKeySlot: null });
  });

  it("disables the retry actions while a retry is pending", async () => {
    await render({ retryPending: true });
    expect((container.querySelector('[data-testid="key-pool-try-again"]') as HTMLButtonElement).disabled).toBe(true);
    expect((container.querySelector('[data-testid="key-pool-switch-key"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it("switches the model from the connection catalog in place", async () => {
    await render();
    await act(async () => { pointerClick('[data-testid="key-pool-switch-model"]'); await vi.advanceTimersByTimeAsync(10); });
    // Radix portals the popover into document.body.
    const options = [...document.querySelectorAll('[data-testid="key-pool-model-option"]')];
    expect(options.map((option) => option.getAttribute("data-model"))).toEqual([
      "paperclip/z-ai/glm-5.3-flash",
      "paperclip/meta/llama-3.3-70b-instruct",
    ]);
    await act(async () => {
      (options[1] as HTMLElement).click();
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(switchModelRetry).toHaveBeenCalledExactlyOnceWith("paperclip/meta/llama-3.3-70b-instruct");
    expect(retry).not.toHaveBeenCalled();
  });

  it("shows the pooled-key status from the shared slot list in its popover", async () => {
    await render();
    await act(async () => { pointerClick('[data-testid="key-pool-key-status"]'); await vi.advanceTimersByTimeAsync(10); });
    await flush();
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/keys"))).toBe(true);
    expect(document.body.textContent).toContain("Slot 1");
    expect(document.body.textContent).toContain("Slot 3");
    expect(document.body.textContent).toContain("RPM cooldown");
    // Read-only panel: no management actions inside the popover.
    const popover = document.querySelector('[data-testid="key-pool-status-panel"]');
    expect(popover?.querySelector("button, input")).toBeNull();
  });

  it("hides actions their inputs cannot support", async () => {
    // No failed slot (assignment-time exhaustion), no snapshot connection
    // reference, and a connection without a routed model catalog.
    await render({
      snapshot: {
        reason: "pool_exhausted",
        slots: [{ slot: 5, state: "healthy", model: null, cooldownUntil: null,
          leasedByRunId: "run-x", leasedByAgentId: null, leasedByAgentName: "Chief" }],
      },
      binding: undefined,
    });
    expect(container.querySelector('[data-testid="key-pool-try-again"]')).toBeNull();
    expect(container.querySelector('[data-testid="key-pool-switch-model"]')).toBeNull();
    expect(container.querySelector('[data-testid="key-pool-key-status"]')).toBeNull();
    // Switching keys stays available: the pool resolves the contention itself.
    expect(container.querySelector('[data-testid="key-pool-switch-key"]')).not.toBeNull();
  });
});
