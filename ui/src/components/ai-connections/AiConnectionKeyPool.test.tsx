// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AiConnectionKeySlotList } from "@paperclipai/shared";
import { AiConnectionKeyPool } from "./AiConnectionKeyPool";

const connectionId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";

const slot = (overrides: Partial<AiConnectionKeySlotList["slots"][number]> = {}) => ({
  id: overrides.slot ? `slot-${overrides.slot}` : "slot-1",
  slot: 1,
  label: "nim-account-1",
  enabled: true,
  state: "healthy" as const,
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

let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
let client: QueryClient;
let pool: AiConnectionKeySlotList = { connectionId, slots: [] };
const fetchMock = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchMock);
  pool = { connectionId, slots: [] };
  fetchMock.mockReset().mockImplementation((url: string, init: RequestInit) => {
    if (url.endsWith("/keys")) {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        pool = { ...pool, slots: [...pool.slots, slot({ slot: body.slot, label: body.label ?? null })].sort((a, b) => a.slot - b.slot) };
        return Promise.resolve(Response.json(slot({ slot: body.slot, label: body.label ?? null })));
      }
      if (init?.method === "PATCH") {
        const body = JSON.parse(String(init.body));
        pool = {
          ...pool,
          slots: pool.slots.map((row) => row.slot === body.slot
            ? { ...row, ...(body.label !== undefined ? { label: body.label } : {}), ...(body.enabled !== undefined ? { enabled: body.enabled } : {}) }
            : row),
        };
        return Promise.resolve(Response.json(slot({ slot: body.slot })));
      }
      if (init?.method === "DELETE") {
        const body = JSON.parse(String(init.body));
        pool = { ...pool, slots: pool.slots.filter((row) => row.slot !== body.slot) };
        return Promise.resolve(Response.json({ ok: true }));
      }
      return Promise.resolve(Response.json(pool));
    }
    return Promise.resolve(Response.json({}));
  });
  client = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, gcTime: Infinity } } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  host.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function render() {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <AiConnectionKeyPool companyId={companyId} connectionId={connectionId} />
      </QueryClientProvider>,
    );
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(10); });
  await act(async () => { await vi.advanceTimersByTimeAsync(10); });
}

const inputByLabel = (label: string) =>
  [...host.querySelectorAll("input")].find((input) => input.getAttribute("aria-label") === label)!;
const buttonByText = (text: string) =>
  [...host.querySelectorAll("button")].find((button) => button.textContent === text)!;
/** React tracks its own value cache; writes must go through the native setter. */
const type = (input: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
};

it("lists pooled key slots with their label, health and pause state, never a key value", async () => {
  pool = { connectionId, slots: [slot(), slot({ id: "slot-2", slot: 2, label: null, enabled: false, state: "daily_cooldown", cooldownUntil: "2026-11-07T00:00:00.000Z" })] };
  await render();
  expect(host.textContent).toContain("nim-account-1");
  expect(host.textContent).toContain("Healthy");
  expect(host.textContent).toContain("Daily cooldown");
  expect(host.textContent).toContain("Disabled");
  expect(host.textContent).not.toContain("nvapi");
  expect(fetchMock.mock.calls.every(([url]) => !String(url).includes("value"))).toBe(true);
});

it("adds a key slot and refreshes the list", async () => {
  await render();
  expect(host.textContent).toContain("No pooled keys yet");
  await act(async () => {
    buttonByText("Add key").click();
    await vi.advanceTimersByTimeAsync(0);
  });
  await act(async () => {
    type(inputByLabel("Slot number"), "3");
    type(inputByLabel("Label"), "nim-account-3");
    type(inputByLabel("API key"), "fixture-new-key");
    await vi.advanceTimersByTimeAsync(0);
  });
  await act(async () => {
    buttonByText("Save key").click();
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(host.textContent).toContain("nim-account-3");
  const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit).method === "POST");
  expect(JSON.parse(String(post![1].body))).toEqual({ slot: 3, label: "nim-account-3", keyValue: "fixture-new-key" });
});

it("replaces a slot's key through the edit flow without revealing the stored value", async () => {
  pool = { connectionId, slots: [slot()] };
  await render();
  await act(async () => {
    buttonByText("Replace key").click();
    await vi.advanceTimersByTimeAsync(0);
  });
  const before = fetchMock.mock.calls.length;
  await act(async () => {
    type(inputByLabel("API key"), "fixture-rotated-key");
    await vi.advanceTimersByTimeAsync(0);
  });
  await act(async () => {
    buttonByText("Save key").click();
    await vi.advanceTimersByTimeAsync(0);
  });
  const patch = fetchMock.mock.calls.slice(before).find(([, init]) => (init as RequestInit).method === "PATCH");
  expect(JSON.parse(String(patch![1].body))).toEqual({ slot: 1, label: "nim-account-1", keyValue: "fixture-rotated-key" });
  expect(host.textContent).not.toContain("fixture-rotated-key");
});

it("pauses and removes a slot", async () => {
  pool = { connectionId, slots: [slot()] };
  await render();
  await act(async () => {
    buttonByText("Disable").click();
    await vi.advanceTimersByTimeAsync(0);
  });
  const patch = fetchMock.mock.calls.find(([, init]) => (init as RequestInit).method === "PATCH");
  expect(JSON.parse(String(patch![1].body))).toEqual({ slot: 1, enabled: false });
  await act(async () => {
    buttonByText("Remove").click();
    await vi.advanceTimersByTimeAsync(0);
  });
  const remove = fetchMock.mock.calls.find(([, init]) => (init as RequestInit).method === "DELETE");
  expect(JSON.parse(String(remove![1].body))).toEqual({ slot: 1 });
  expect(host.textContent).toContain("No pooled keys yet");
});
