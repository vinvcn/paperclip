import type { TranscriptEntry } from "@paperclipai/adapter-utils";
import type { UsageRequestLogRow } from "@paperclipai/shared";

export type TaskChatTps = {
  value: number;
  estimated: boolean;
  average: boolean;
} | null;

const LIVE_WINDOW_MS = 5_000;

function timestamp(value: string): number | null {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** ASCII ≈4 chars/token; non-ASCII one char/token. Never label this exact. */
export function estimatedTextTokens(text: string): number {
  const ascii = (text.match(/[\x00-\x7F]/g) ?? []).length;
  return (ascii / 4) + (text.length - ascii);
}

export function requestTps(row: Pick<UsageRequestLogRow, "outputTokens" | "durationMs" | "ttftMs">): number | null {
  if (row.outputTokens == null || row.durationMs == null) return null;
  const durationMs = row.ttftMs == null ? row.durationMs : row.durationMs - row.ttftMs;
  if (row.outputTokens < 0 || durationMs <= 0) return null;
  return row.outputTokens * 1000 / durationMs;
}

export function formatTps(value: number): string {
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} TPS`;
}

/**
 * Generation speed excludes TTFT. Native usage entries carry the cumulative
 * run total observed at each usage event; the visible aggregate remains one
 * final result entry. Text fallback uses the latest five-second text window.
 */
export function liveTps(entries: readonly TranscriptEntry[], nowMs: number): TaskChatTps {
  const samples = entries.flatMap((entry): Array<{ atMs: number; outputTokens: number }> => {
    if (entry.kind !== "result") return [];
    if (entry.subtype === "paperclip_runner_usage" && entry.usageSamples) {
      return entry.usageSamples.flatMap(sample => {
        const atMs = timestamp(sample.ts);
        return atMs == null ? [] : [{ atMs, outputTokens: sample.outputTokens }];
      });
    }
    if (entry.subtype === "paperclip.usage") return [{ atMs: timestamp(entry.ts) ?? Number.NaN, outputTokens: entry.outputTokens }];
    return [];
  });
  const latest = samples.at(-1);
  if (latest && nowMs - latest.atMs > LIVE_WINDOW_MS) return null;
  if (samples.length > 1 && latest) {
    const start = samples.find(sample => latest.atMs - sample.atMs <= LIVE_WINDOW_MS) ?? samples[0];
    const elapsedMs = latest.atMs - start.atMs;
    if (elapsedMs > 0 && latest.outputTokens > start.outputTokens) {
      return { value: (latest.outputTokens - start.outputTokens) * 1000 / elapsedMs, estimated: false, average: false };
    }
  }
  const textEntries = entries.flatMap((entry) => {
    if (entry.kind !== "assistant" && entry.kind !== "thinking") return [];
    const atMs = timestamp(entry.ts);
    return atMs == null ? [] : [{ atMs, tokens: estimatedTextTokens(entry.text) }];
  });
  const first = textEntries[0];
  if (!first || nowMs <= first.atMs) return null;
  const latestMs = Math.max(nowMs, textEntries.at(-1)!.atMs);
  const lastTextMs = textEntries.at(-1)!.atMs;
  if (nowMs - lastTextMs > LIVE_WINDOW_MS) return null;
  const firstMs = Math.max(first.atMs, latestMs - LIVE_WINDOW_MS);
  const elapsedMs = latestMs - firstMs;
  if (elapsedMs <= 0) return null;
  const textTokens = textEntries.reduce((sum, entry) => sum + (latestMs - entry.atMs <= LIVE_WINDOW_MS ? entry.tokens : 0), 0);
  return { value: textTokens * 1000 / (latestMs - firstMs), estimated: true, average: false };
}

/** Total output / full run duration, including TTFT. */
export function averageTps(entries: readonly TranscriptEntry[], startedAtMs: number | null, finishedAtMs: number | null): TaskChatTps {
  if (startedAtMs == null || finishedAtMs == null || finishedAtMs <= startedAtMs) return null;
  const outputTokens = entries.flatMap((entry): number[] => entry.kind === "result" && (entry.subtype === "paperclip_runner_usage" || entry.subtype === "paperclip.usage") ? [entry.outputTokens] : []).reduce((sum, tokens) => sum + tokens, 0);
  if (outputTokens > 0) return { value: outputTokens * 1000 / (finishedAtMs - startedAtMs), estimated: false, average: true };
  const textTokens = entries.filter(entry => entry.kind === "assistant" || entry.kind === "thinking").reduce((sum, entry) => sum + estimatedTextTokens(entry.text), 0);
  return textTokens > 0 ? { value: textTokens * 1000 / (finishedAtMs - startedAtMs), estimated: true, average: true } : null;
}

export function tpsLabel(tps: TaskChatTps): string | undefined {
  return tps ? `${tps.average ? "平均 " : ""}${formatTps(tps.value)}${tps.estimated ? "（估算）" : ""}` : undefined;
}
