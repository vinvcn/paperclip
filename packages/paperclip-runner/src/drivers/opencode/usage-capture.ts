import type {
  ProviderRequestUsageObservation,
  ProviderRequestUsageRecord,
  ProviderRequestUsageTokens,
} from "../../contracts/usage-capture.js";
import { usageProviderAndBillerFromModel } from "../../contracts/usage-capture.js";

/** Bytes of the upstream response tail kept for usage extraction. */
export const USAGE_TAIL_BYTES = 128 * 1024;

/**
 * Buffers per-request usage observations from the provider proxy and hands
 * each one to the driver session as soon as a delivery callback is wired.
 * The buffer exists only for records that complete before the session wires
 * its callback; delivery is the primary path so the final request of a turn
 * cannot be lost to the terminal-turn drain ordering.
 */
export interface UsageCaptureSink {
  record(observation: ProviderRequestUsageObservation): void;
  onRecord(deliver: ((record: ProviderRequestUsageRecord) => void) | null): void;
  take(): ProviderRequestUsageRecord[];
}

export function createUsageCaptureSink(input: {
  app: string;
  model: string;
  /** Pooled key attribution (ticket 04); absent for non-pooled credentials. */
  keySlot?: number | null;
  connectionId?: string | null;
  capacity?: number;
}): UsageCaptureSink {
  const capacity = input.capacity ?? 4096;
  const { provider, biller } = usageProviderAndBillerFromModel(input.model);
  const buffered: ProviderRequestUsageRecord[] = [];
  let deliver: ((record: ProviderRequestUsageRecord) => void) | null = null;
  return {
    record(observation) {
      const record: ProviderRequestUsageRecord = {
        app: input.app,
        provider,
        biller,
        model: input.model,
        keySlot: input.keySlot ?? null,
        connectionId: input.connectionId ?? null,
        ...observation,
      };
      if (deliver) {
        try {
          deliver(record);
          return;
        } catch {
          // Fall through: the buffer keeps the record for the terminal drain.
        }
      }
      if (buffered.length < capacity) buffered.push(record);
    },
    onRecord(next) {
      deliver = next;
    },
    take() {
      return buffered.splice(0);
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Extract an OpenAI-compatible `usage` object from the tail of a response
 * body. Handles plain JSON and SSE (the last `data:` frame carrying a usage
 * object wins). The tail may start mid-frame after the byte cap; candidates
 * that fail to parse are skipped rather than treated as "no usage".
 */
export function extractProviderUsageBlock(bodyTail: string): Record<string, unknown> | null {
  let rest = bodyTail;
  for (;;) {
    const index = rest.lastIndexOf("data:");
    if (index < 0) break;
    const lineEnd = rest.indexOf("\n", index);
    const line = rest.slice(index + 5, lineEnd === -1 ? undefined : lineEnd).trim();
    if (line && line !== "[DONE]" && line.includes("usage")) {
      try {
        const frame = JSON.parse(line) as unknown;
        if (isRecord(frame) && isRecord(frame.usage)) return frame.usage;
      } catch {
        // A frame truncated by the tail cap; keep scanning older frames.
      }
    }
    if (index === 0) break;
    rest = rest.slice(0, index);
  }
  const key = bodyTail.lastIndexOf('"usage"');
  if (key === -1) return null;
  const start = bodyTail.indexOf("{", key);
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let cursor = start; cursor < bodyTail.length; cursor += 1) {
    const character = bodyTail[cursor];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(bodyTail.slice(start, cursor + 1)) as unknown;
          return isRecord(parsed) ? parsed : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * Project an OpenAI-compatible usage block onto the token columns. Returns
 * null when no count could be observed, so unobserved requests stay null
 * instead of zero.
 */
export function usageTokensFromBlock(block: Record<string, unknown> | null): ProviderRequestUsageTokens | null {
  if (!block) return null;
  const details = isRecord(block.prompt_tokens_details) ? block.prompt_tokens_details : {};
  const inputTokens = count(block.prompt_tokens);
  const cachedInputTokens = count(details.cached_tokens) ?? count(block.cache_read_input_tokens);
  const cacheWriteTokens = count(block.cache_creation_input_tokens);
  const outputTokens = count(block.completion_tokens);
  if (inputTokens === null && cachedInputTokens === null && cacheWriteTokens === null && outputTokens === null) return null;
  return { inputTokens, cachedInputTokens, cacheWriteTokens, outputTokens };
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}
