import { describe, expect, it } from "vitest";
import type { TranscriptEntry } from "@paperclipai/adapter-utils";
import { averageTps, estimatedTextTokens, formatTps, liveTps, requestTps } from "./live-tps";

function usage(ts: string, outputTokens: number): TranscriptEntry {
  return { kind: "result", ts, text: "", inputTokens: 0, outputTokens, cachedTokens: 0, costUsd: 0, subtype: "paperclip_runner_usage", isError: false, errors: [] };
}

function usageTimeline(...samples: [string, number][]): TranscriptEntry {
  const last = samples.at(-1)!;
  const aggregate = usage(last[0], last[1]);
  if (aggregate.kind !== "result") throw new Error("usage fixture must be a result");
  return { ...aggregate, usageSamples: samples.map(([ts, outputTokens]) => ({ ts, outputTokens })) };
}

describe("live TPS", () => {
  it("uses provider samples over a five-second generation window, excluding TTFT", () => {
    const entries: TranscriptEntry[] = [
      { kind: "assistant", ts: "2026-11-12T08:00:02.000Z", text: "Generating", channel: "progress" },
      usageTimeline(["2026-11-12T08:00:02.000Z", 20], ["2026-11-12T08:00:04.000Z", 110]),
    ];
    expect(liveTps(entries, Date.parse("2026-11-12T08:00:04Z"))).toEqual({ value: 90 / 2, estimated: false, average: false });
  });

  it("falls back to an explicitly estimated text speed", () => {
    expect(liveTps([{ kind: "assistant", ts: "2026-11-12T08:00:00Z", text: "a".repeat(32) }], Date.parse("2026-11-12T08:00:02Z"))).toEqual({ value: 4, estimated: true, average: false });
  });

  it("uses a five-second window", () => {
    const entries: TranscriptEntry[] = [usageTimeline(...[0, 1, 2, 3, 4, 5].map(index => [new Date(1700000000000 + index * 1000).toISOString(), index * 20] as [string, number]))];
    expect(liveTps(entries, 1700000005000)).toEqual({ value: 20, estimated: false, average: false });
  });

  it("does not keep a stale usage rate visible after generation stops", () => {
    const entries = [usageTimeline(["2026-11-12T08:00:02Z", 20], ["2026-11-12T08:00:04Z", 110])];
    expect(liveTps(entries, Date.parse("2026-11-12T08:00:10Z"))).toBeNull();
  });
});

describe("run average TPS", () => {
  it("includes TTFT in the full-run denominator and freezes on terminal", () => {
    const entries: TranscriptEntry[] = [
      { kind: "assistant", ts: "2026-11-12T00:00:04Z", text: "answer" },
      { kind: "result", ts: "2026-11-12T00:00:16Z", text: "", inputTokens: 100, outputTokens: 1120, cachedTokens: 0, costUsd: 0, subtype: "paperclip_runner_usage", isError: false, errors: [] },
    ];
    expect(averageTps(entries, Date.parse("2026-11-12T08:00:00Z"), Date.parse("2026-11-12T08:00:16Z"))).toEqual({ value: 1120 / 16, estimated: false, average: true });
    expect(liveTps([{ kind: "assistant", ts: "2026-11-12T08:00:04Z", text: "answer" }], Date.parse("2026-11-12T08:00:04Z"))).toBeNull();
  });

  it("marks the text-derived final average as estimated", () => {
    const entries: TranscriptEntry[] = [{ kind: "assistant", ts: "2026-11-12T00:00:04Z", text: "a".repeat(4480) }];
    expect(averageTps(entries, 0, 16_000)).toEqual({ value: 70, estimated: true, average: true });
  });
});

describe("Usage request TPS", () => {
  it("uses output generation duration, not the request's TTFT", () => {
    expect(requestTps({ outputTokens: 1120, durationMs: 16_000, ttftMs: 4_000 })).toBeCloseTo(93.3333333);
  });
  it("falls back to full duration only when TTFT is unknown", () => {
    expect(requestTps({ outputTokens: 100, durationMs: 2_000, ttftMs: null })).toBe(50);
  });
  it("returns null for unavailable output, duration or a zero denominator", () => {
    expect(requestTps({ outputTokens: null, durationMs: 100, ttftMs: 0 })).toBeNull();
    expect(requestTps({ outputTokens: 100, durationMs: 200, ttftMs: 200 })).toBeNull();
  });
  it("formats sub-100 speeds with one decimal", () => expect(formatTps(38.4)).toBe("38.4 TPS"));
});
