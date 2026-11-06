import { describe, expect, it } from "vitest";
import { updateAgentSchema } from "./agent.js";

describe("agent update schema", () => {
  it.each(["paused", "idle", "terminated"])("accepts lifecycle status request %s", status => {
    expect(updateAgentSchema.parse({ status })).toEqual({ status });
  });
  describe("adapterConfig key slot pin", () => {
    it("accepts a positive integer pin and a null clear", () => {
      expect(updateAgentSchema.parse({ adapterConfig: { keySlot: 3 } }).adapterConfig).toEqual({ keySlot: 3 });
      expect(updateAgentSchema.parse({ adapterConfig: { keySlot: null } }).adapterConfig).toEqual({ keySlot: null });
    });
    it.each([0, -2, 1.5, "3", true])("rejects invalid keySlot pin %p", keySlot => {
      const result = updateAgentSchema.safeParse({ adapterConfig: { keySlot } });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: ["adapterConfig", "keySlot"] }),
      ]));
    });
  });
  it.each(["active", "running", "error", "pending_approval"])("rejects direct status write %s", status => {
    const result = updateAgentSchema.safeParse({ name: "Renamed", status });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: ["status"] }),
    ]));
  });
  it.each([{ spentMonthlyCents: 0 }, { name: "Renamed", spentMonthlyCents: 10 }])("rejects spend totals: %j", payload => {
    const result = updateAgentSchema.safeParse(payload);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: ["spentMonthlyCents"] }),
    ]));
  });
  it("accepts profile and budget limit changes", () => {
    expect(updateAgentSchema.parse({ name: "Renamed", budgetMonthlyCents: 100 })).toEqual({ name: "Renamed", budgetMonthlyCents: 100 });
  });
});
