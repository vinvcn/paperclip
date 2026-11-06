// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AiConnectionKeySlot } from "@paperclipai/shared";
import { KeyPoolSlotList } from "./KeyPoolSlotList";

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

describe("KeyPoolSlotList", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("renders one read-only row per slot with state, occupancy and cooldown facts", async () => {
    await act(async () => root.render(
      <KeyPoolSlotList slots={[
        slot(),
        slot({ slot: 2, id: "slot-2", label: null, state: "rpm_cooldown", cooldownUntil: "2026-11-06T12:30:00.000Z", cooldownReason: "rpm" }),
        slot({ slot: 3, id: "slot-3", label: "nim-account-3", state: "healthy", activeRunId: "run-9", leaseExpiresAt: "2026-11-06T13:00:00.000Z" }),
        slot({ slot: 4, id: "slot-4", enabled: false }),
      ]} />,
    ));
    const rows = container.querySelectorAll("li");
    expect(rows).toHaveLength(4);
    expect(rows[0]!.textContent).toContain("Slot 1");
    expect(rows[0]!.textContent).toContain("nim-account-1");
    expect(rows[0]!.textContent).toContain("Healthy");
    expect(rows[1]!.textContent).toContain("Slot 2");
    expect(rows[1]!.textContent).toContain("RPM cooldown");
    expect(rows[2]!.textContent).toContain("Slot 3");
    expect(rows[2]!.textContent).toContain("In use by a run");
    expect(rows[3]!.textContent).toContain("Disabled");
  });

  it("stays read-only: no buttons, inputs or key values appear", async () => {
    await act(async () => root.render(<KeyPoolSlotList slots={[slot({ label: "nim-account-1" })]} />));
    expect(container.querySelector("button, input")).toBeNull();
  });

  it("renders the empty state for a pool without slots", async () => {
    await act(async () => root.render(<KeyPoolSlotList slots={[]} />));
    expect(container.textContent).toContain("No pooled keys");
  });
});
