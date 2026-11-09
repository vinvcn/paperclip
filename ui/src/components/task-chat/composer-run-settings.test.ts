import { describe, expect, it } from "vitest";
import type { Agent } from "@paperclipai/shared";
import {
  composerCatalogProvider, composerDefaultModel, composerEfforts, composerFastAvailable, mergeComposerRunSettings,
  readComposerRunSettings, supportsComposerModel, switchModelRetryOverrides,
} from "./composer-run-settings";

const agent = (adapterType: Agent["adapterType"], provider?: string) => ({
  adapterType, adapterConfig: provider ? { provider } : {},
}) as Agent;

describe("composer run settings", () => {
  it("resolves known adapter defaults without guessing local CLI settings", () => {
    expect(composerDefaultModel(agent("claude_local"))).toBe("");
    expect(composerDefaultModel({ ...agent("claude_local"), adapterConfig: { model: "claude-opus-5" } })).toBe("claude-opus-5");
    expect(composerDefaultModel({ ...agent("claude_local"), adapterConfig: { env: { ANTHROPIC_MODEL: "claude-sonnet-5" } } })).toBe("claude-sonnet-5");
    expect(composerDefaultModel({ ...agent("claude_local"), adapterConfig: { env: { CLAUDE_CODE_USE_BEDROCK: "1" } } })).toBe("");
    expect(composerDefaultModel({ ...agent("claude_local"), adapterConfig: { env: { CLAUDE_CODE_USE_VERTEX: "1" } } })).toBe("");
    expect(composerDefaultModel({ ...agent("claude_local"), adapterConfig: { env: { ANTHROPIC_MODEL: { type: "secret_ref", secretId: "model-secret" } } } })).toBe("");
    expect(composerDefaultModel({ ...agent("codex_local"), adapterConfig: { model: " private-codex " } })).toBe("private-codex");
    expect(composerDefaultModel(agent("codex_local"))).toBe("");
    expect(composerDefaultModel(agent("paperclip_runner", "codex"))).toBe("gpt-6.1-sol");
    expect(composerDefaultModel(agent("grok_local"))).toBe("grok-build");
    expect(composerDefaultModel(undefined)).toBe("");
  });
  it("offers native Grok effort and keeps its default model", () => {
    const native = { ...agent("paperclip_runner", "acpx"), adapterConfig: { provider: "acpx", acpxAgent: "grok", reasoningEffort: "high" } };
    expect(composerDefaultModel(native)).toBe("grok-4.7");
    expect(composerEfforts(native, "grok-4.7", ["grok-4.7"])).toEqual(["low", "medium", "high", "xhigh"]);
    expect(readComposerRunSettings({ adapterConfig: native.adapterConfig }, native.adapterType)).toMatchObject({ effort: "high" });
  });
  it("preserves the explicit native Kimi model without inventing a default or effort control", () => {
    const native = { ...agent("paperclip_runner", "acpx"), adapterConfig: { provider: "acpx", acpxAgent: "kimi" } };
    expect(composerDefaultModel(native)).toBe("");
    const configured = { ...native, adapterConfig: { ...native.adapterConfig, model: "exact-kimi-model" } };
    expect(composerDefaultModel(configured)).toBe("exact-kimi-model");
    expect(composerEfforts(configured, "exact-kimi-model", ["exact-kimi-model"])).toEqual([]);
  });
  it("shows only effort levels known for the selected harness and model", () => {
    expect(composerEfforts(agent("codex_local"), "gpt-6-astra", [])).toContain("ultra");
    expect(composerEfforts(agent("paperclip_runner", "codex"), "gpt-6-astra", [])).toContain("ultra");
    expect(composerEfforts(agent("paperclip_runner", "opencode"), "gpt-6-astra", [])).toEqual([]);
    expect(composerEfforts(agent("codex_local"), "custom-private-model", [])).toEqual([]);
    expect(composerEfforts(agent("opencode_local"), "openrouter/x/y", ["openrouter/x/y"])).toEqual([]);
    expect(composerEfforts(agent("claude_local"), "claude-sonnet-5", ["claude-sonnet-5"])).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(composerEfforts(agent("claude_local"), "claude-haiku-4-5", ["claude-haiku-4-5"])).toEqual([]);
    expect(composerEfforts(agent("grok_local"), "grok-4.7", ["grok-4.7"])).toEqual(["low", "medium", "high", "xhigh"]);
    expect(composerEfforts(agent("grok_local"), "grok-4.7", [])).toEqual([]);
    expect(composerEfforts(agent("grok_local"), "", ["grok-build"])).toEqual(["low", "medium", "high"]);
    expect(composerEfforts(agent("kimi_local"), "kimi-code/k3", ["kimi-code/k3"])).toEqual([]);
    expect(composerEfforts({ ...agent("kimi_local"), adapterConfig: { engine: "cli" } }, "kimi-code/k3", ["kimi-code/k3"])).toEqual(["low", "high", "max"]);
    expect(composerEfforts({ ...agent("kimi_local"), adapterConfig: { engine: " CLI " } }, "", ["kimi-code/kimi-for-coding"])).toEqual(["low", "high", "max"]);
    expect(composerEfforts(agent("kimi_local"), "kimi-code/kimi-for-coding-highspeed", ["kimi-code/kimi-for-coding-highspeed"])).toEqual([]);
    expect(composerFastAvailable(agent("codex_local"), "gpt-6-astra")).toBe(true);
    expect(composerFastAvailable(agent("codex_local"), "custom-private-model")).toBe(false);
    expect(supportsComposerModel(agent("process"))).toBe(false);
    expect(composerCatalogProvider({ ...agent("opencode_local"), adapterConfig: { model: "openrouter/qwen/qwen3-coder-next" } })).toBe("openrouter");
  });

  it("preserves unrelated task overrides while changing or resetting run settings", () => {
    const previous = { adapterConfig: { chrome: true, model: "old", effort: "low" }, useProjectWorkspace: true };
    expect(mergeComposerRunSettings(previous, "claude_local", { model: "claude-opus", effort: "high", fast: false }))
      .toEqual({ adapterConfig: { chrome: true, model: "claude-opus", effort: "high" }, useProjectWorkspace: true });
    const reset = mergeComposerRunSettings(previous, "claude_local", { model: null, effort: null, fast: false, keySlot: null });
    expect(reset).toEqual({ adapterConfig: { chrome: true }, useProjectWorkspace: true });
    expect(readComposerRunSettings(reset, "claude_local")).toEqual({ model: null, effort: null, fast: false, keySlot: null });
    expect(readComposerRunSettings({ adapterConfig: { reasoningEffort: "xhigh" } }, "codex_local").effort).toBe("xhigh");
    expect(mergeComposerRunSettings(previous, "codex_local", { model: "gpt-6-astra", effort: "ultra", fast: true, keySlot: null }, true))
      .toEqual({ adapterConfig: { model: "gpt-6-astra", modelReasoningEffort: "ultra", fastMode: true } });
    const runner = mergeComposerRunSettings(null, "paperclip_runner", { model: "gpt-6-astra", effort: "ultra", fast: false, keySlot: null });
    expect(runner).toEqual({ adapterConfig: { model: "gpt-6-astra", modelReasoningEffort: "ultra" } });
    expect(readComposerRunSettings(runner, "paperclip_runner").effort).toBe("ultra");
    const grok = mergeComposerRunSettings(null, "grok_local", { model: "grok-4.7", effort: "xhigh", fast: false, keySlot: null });
    expect(grok).toEqual({ adapterConfig: { model: "grok-4.7", reasoningEffort: "xhigh" } });
    expect(readComposerRunSettings(grok, "grok_local").effort).toBe("xhigh");
  });

  // Ticket 06: the task-level key pin is top-level on the overrides. It is
  // cleared by an explicit null (the reset flow), pinned by a slot number,
  // and kept when a draft never touches it (sticky for older callers).
  it("carries the task-level key slot pin beside the adapter config", () => {
    const pinned = { adapterConfig: { model: "old" }, keySlot: 3 };
    expect(mergeComposerRunSettings(pinned, "claude_local", { model: "new", effort: null, fast: false }))
      .toEqual({ adapterConfig: { model: "new" }, keySlot: 3 });
    expect(mergeComposerRunSettings(pinned, "claude_local", { model: "new", effort: null, fast: false, keySlot: 5 }))
      .toEqual({ adapterConfig: { model: "new" }, keySlot: 5 });
    expect(mergeComposerRunSettings(pinned, "claude_local", { model: null, effort: null, fast: false, keySlot: null }))
      .toEqual(null);
    // A pin alone is a valid override even without adapter config keys.
    expect(mergeComposerRunSettings(null, "claude_local", { model: null, effort: null, fast: false, keySlot: 2 }))
      .toEqual({ keySlot: 2 });
    // Reassignment starts fresh: no pin survives it.
    expect(mergeComposerRunSettings(pinned, "claude_local", { model: "new", effort: null, fast: false }, true))
      .toEqual({ adapterConfig: { model: "new" } });
    expect(readComposerRunSettings(pinned, "claude_local").keySlot).toBe(3);
    expect(readComposerRunSettings(null, "claude_local").keySlot).toBe(null);
  });

  // Ticket 06: the switch-model retry's override write — model set, effort
  // invalidated, the task key pin rides along (an explicit user decision).
  it("builds the switch-model retry overrides without dropping the key pin", () => {
    expect(switchModelRetryOverrides({ adapterConfig: { model: "old", effort: "high" }, keySlot: 3 }, "claude_local", "paperclip/meta/llama-3.3-70b-instruct"))
      .toEqual({ adapterConfig: { model: "paperclip/meta/llama-3.3-70b-instruct" }, keySlot: 3 });
    expect(switchModelRetryOverrides(null, "claude_local", "paperclip/meta/llama-3.3-70b-instruct"))
      .toEqual({ adapterConfig: { model: "paperclip/meta/llama-3.3-70b-instruct" } });
  });
});
