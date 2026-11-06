import { describe, expect, it } from "vitest";
import { readWakeKeyPoolAvoidSlot } from "./execution-configuration.js";

describe("readWakeKeyPoolAvoidSlot (ticket 06)", () => {
  it("reads the validated one-shot avoid slot from a retry wake context", () => {
    expect(readWakeKeyPoolAvoidSlot({ keyPoolAvoidSlot: 3 })).toBe(3);
  });
  it("returns null when the wake carries no avoid", () => {
    expect(readWakeKeyPoolAvoidSlot({ issueId: "x" })).toBeNull();
    expect(readWakeKeyPoolAvoidSlot(undefined)).toBeNull();
  });
  it.each([0, -2, 1.5, "3", true, null])("defensively rejects a malformed stored value %p", value => {
    expect(readWakeKeyPoolAvoidSlot({ keyPoolAvoidSlot: value })).toBeNull();
  });
});
