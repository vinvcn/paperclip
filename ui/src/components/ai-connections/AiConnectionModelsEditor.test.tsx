// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { aiConnectionsApi } from "@/api/ai-connections";
import { AiConnectionModelsEditor } from "./AiConnectionModelsEditor";

vi.mock("@/api/ai-connections", () => ({ aiConnectionsApi: { updateModels: vi.fn() } }));
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
let client: QueryClient;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(aiConnectionsApi.updateModels).mockResolvedValue({ ok: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

const initial = [{ id: "team/model", label: "Team model", limit: { context: 262144, output: 65536 }, options: { reasoningEffort: "max" as const } }];
async function mount() {
  await act(async () => root.render(<QueryClientProvider client={client}><AiConnectionModelsEditor companyId="company" connectionId="connection" models={initial} /></QueryClientProvider>));
}
const button = (text: string) => [...host.querySelectorAll("button")].find(button => button.textContent === text)!;
const input = (label: string) => [...host.querySelectorAll("input")].find(input => input.getAttribute("aria-label") === label)!;
async function change(input: HTMLInputElement | HTMLSelectElement, value: string) {
  const prototype = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

it("cleans empty settings and reports success without a credential field", async () => {
  await mount();
  await change(input("Context limit"), "");
  await change(input("Output limit"), "65536");
  await change(host.querySelector<HTMLSelectElement>('[aria-label="Default reasoning effort"]')!, "");
  await act(async () => button("Save models").click());
  expect(vi.mocked(aiConnectionsApi.updateModels).mock.calls[0]?.[2]).toEqual([{ id: "team/model", label: "Team model", limit: { output: 65536 } }]);
  await vi.waitFor(() => expect(host.querySelector('[role="status"]')?.textContent).toBe("Model settings saved."));
});

it("prefills new model defaults without changing existing models", async () => {
  await mount();
  await act(async () => button("Add model").click());
  await change([...host.querySelectorAll<HTMLInputElement>('input[aria-label="Model ID"]')][1]!, "new-model");
  expect(host.querySelectorAll('input[aria-label="Model ID"]')).toHaveLength(2);
  expect([...host.querySelectorAll<HTMLInputElement>('input[aria-label="Context limit"]')].map(input => input.value)).toEqual(["262144", "262144"]);
  expect([...host.querySelectorAll<HTMLInputElement>('input[aria-label="Output limit"]')].map(input => input.value)).toEqual(["65536", "65536"]);
  expect([...host.querySelectorAll<HTMLSelectElement>('select[aria-label="Default reasoning effort"]')].map(input => input.value)).toEqual(["max", "max"]);
  await change([...host.querySelectorAll<HTMLInputElement>('input[aria-label="Context limit"]')][1]!, "");
  await act(async () => button("Save models").click());
  expect(vi.mocked(aiConnectionsApi.updateModels).mock.calls[0]?.[2]).toEqual([
    initial[0],
    { id: "new-model", limit: { output: 65536 }, options: { reasoningEffort: "max" } },
  ]);
});

it("rejects duplicate IDs and resets stale success feedback on edit", async () => {
  await mount();
  await act(async () => button("Save models").click());
  await vi.waitFor(() => expect(host.querySelector('[role="status"]')).not.toBeNull());
  await change(input("Context limit"), "1024");
  expect(host.querySelector('[role="status"]')).toBeNull();
  await change(input("Context limit"), "262144");
  await act(async () => button("Add model").click());
  expect(button("Save models").disabled).toBe(true);
  expect(host.textContent).toContain("Model ID is required.");
  await change([...host.querySelectorAll<HTMLInputElement>('input[aria-label="Model ID"]')][1]!, "team/model");
  expect(host.textContent).toContain("Model IDs must be unique.");
  expect(vi.mocked(aiConnectionsApi.updateModels)).toHaveBeenCalledTimes(1);
});

it("adopts a changed external catalog without editing credentials", async () => {
  await mount();
  await change(input("Context limit"), "1024");
  await act(async () => root.render(<QueryClientProvider client={client}><AiConnectionModelsEditor companyId="company" connectionId="connection" models={[{ id: "external/model", limit: { output: 1024 } }]} /></QueryClientProvider>));
  expect(input("Model ID").value).toBe("external/model");
  expect(input("Context limit").value).toBe("");
  expect(host.querySelector<HTMLSelectElement>('select[aria-label="Default reasoning effort"]')!.value).toBe("");
});
