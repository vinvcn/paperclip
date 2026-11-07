// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiConnectionKeySlot } from "@paperclipai/shared";
import { AgentKeySlotPin } from "./AgentKeySlotPin";

const companyId = "22222222-2222-4222-8222-222222222222";
const connectionId = "11111111-1111-4111-8111-111111111111";

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

const slots = [
  slot(),
  slot({ id: "slot-3", slot: 3, label: "nim-account-3", state: "daily_cooldown", cooldownUntil: "2026-11-07T12:30:00.000Z", cooldownReason: "daily" }),
];

describe("AgentKeySlotPin", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let client: QueryClient;
  const fetchMock = vi.fn();
  const onChange = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("fetch", fetchMock);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    container = document.createElement("div");
    document.body.append(container);
    fetchMock.mockReset().mockImplementation((url: string) => {
      if (url.endsWith("/keys")) {
        return Promise.resolve(Response.json({ connectionId, slots }));
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    root = null;
    container.remove();
    vi.unstubAllGlobals();
  });

  const flush = async () => {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  };

  const render = async (value: number | null = null, disabled = false) => {
    await act(async () => {
      root = createRoot(container);
      root.render(
        <QueryClientProvider client={client}>
          <AgentKeySlotPin companyId={companyId} connectionId={connectionId} value={value} onChange={onChange} disabled={disabled} />
        </QueryClientProvider>,
      );
    });
    await flush();
  };

  it("lists automatic assignment plus one option per slot with its health state", async () => {
    await render();
    const select = document.querySelector<HTMLSelectElement>('[data-testid="agent-key-slot-select"]')!;
    expect(select).not.toBeNull();
    const options = [...select.options].map((option) => option.text);
    expect(options).toEqual([
      "Automatic (recommended)",
      "Slot 1 · nim-account-1",
      "Slot 3 · nim-account-3 · Daily cooldown",
    ]);
    expect(document.querySelector('[data-testid="agent-key-slot-warning"]')).toBeNull();
  });

  it("pins a slot and clears back to automatic", async () => {
    await render();
    const select = document.querySelector<HTMLSelectElement>('[data-testid="agent-key-slot-select"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!.call(select, "3");
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onChange).toHaveBeenLastCalledWith(3);
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!.call(select, "");
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it("warns when the pinned slot is in cooldown — the pin still applies", async () => {
    await render(3);
    const warning = document.querySelector('[data-testid="agent-key-slot-warning"]');
    expect(warning?.textContent).toContain("Slot 3");
    expect(warning?.textContent).toContain("daily cooldown");
    expect(warning?.textContent).toContain("still uses it");
    // The select shows the pinned value; the run matrix applies it as-is.
    expect(document.querySelector<HTMLSelectElement>('[data-testid="agent-key-slot-select"]')!.value).toBe("3");
  });

  it("stays hidden when the connection has no pool or the list cannot be read", async () => {
    fetchMock.mockReset().mockResolvedValue(Response.json({ connectionId, slots: [] }));
    await render();
    expect(container.querySelector('[data-testid="agent-key-slot-pin"]')).toBeNull();

    fetchMock.mockReset().mockRejectedValue(new Error("403"));
    await render();
    expect(container.querySelector('[data-testid="agent-key-slot-pin"]')).toBeNull();
  });
});
