export type OpenCodeReasoningMode = "default" | "disabled" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

export const OPEN_CODE_REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;

/** A per-turn custom-gateway effort, or the provider's configured default. */
export function parseOpenCodeReasoningMode(value: unknown): OpenCodeReasoningMode {
  if (value === undefined || value === "default") return "default";
  if (value === "disabled") return value;
  if (typeof value === "string" && OPEN_CODE_REASONING_EFFORTS.includes(value as Exclude<OpenCodeReasoningMode, "default" | "disabled">)) return value as OpenCodeReasoningMode;
  throw new Error("turn.reasoningMode must be default, disabled, or a supported effort");
}
