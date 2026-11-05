/**
 * Per-request usage records for the runner provider proxy, delivered over the
 * existing runner→server PRP event channel. Mirrors the provider-performance
 * contract: content-free, bounded, and re-validated before any durable write.
 *
 * P1 boundary (ADR-0002): only traffic that flows through the OpenCode driver's
 * provider proxy is observed. Records reach the server in both topologies: the
 * in-process path hands them to the native session executor directly, and in a
 * runnerd topology the opencode-app-server-proxy forwards them as a
 * `paperclip/providerRequestUsage` notification that the Rust event bridge
 * (runner-core provider_events.rs) passes through losslessly. Runner builds
 * older than that notification, and traffic bypassing the proxy, are not
 * captured.
 */

/** Open-code compatible usage block fields the proxy understands (P1). */
export const USAGE_CAPTURE_ENV = "PAPERCLIP_USAGE_CAPTURE";
/** `payload.kind` marker on the existing `harness.diagnostic` PRP event. */
export const PROVIDER_REQUEST_USAGE_KIND = "provider_request";

export interface ProviderRequestUsageTokens {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteTokens: number | null;
  outputTokens: number | null;
}

/** One completed upstream chat-completions exchange as observed by the proxy. */
export interface ProviderRequestUsageRecord {
  /** Runner-generated; unique per (run, request) so re-delivery is idempotent. */
  requestId: string;
  app: string;
  provider: string;
  biller: string;
  model: string;
  startedAtMs: number;
  endedAtMs: number;
  /** First upstream body byte; null when no body arrived. */
  ttftMs: number | null;
  /** Upstream HTTP status; null when the upstream never responded. */
  httpStatus: number | null;
  providerRequestId: string | null;
  usage: ProviderRequestUsageTokens | null;
  /** True when the proxy had to retry without an injected stream_options.include_usage after the upstream refused it, so usage could not be observed. */
  usageMissing: boolean;
}

/** What the proxy hands to the sink: timing and status only. */
export interface ProviderRequestUsageObservation {
  requestId: string;
  startedAtMs: number;
  endedAtMs: number;
  ttftMs: number | null;
  httpStatus: number | null;
  providerRequestId: string | null;
  usage: ProviderRequestUsageTokens | null;
  usageMissing: boolean;
}

/** The proxy's view of the capture sink; app/provider/biller/model are the sink's identity. */
export interface ProviderRequestUsageSink {
  record(observation: ProviderRequestUsageObservation): void;
}

/** Capture is on by default; operators opt out with 0/off. */
export function usageCaptureEnabled(environment: NodeJS.ProcessEnv | undefined): boolean {
  const value = environment?.[USAGE_CAPTURE_ENV];
  return !(value === "0" || value?.toLowerCase() === "off");
}

/** Same provider/biller split as the server's resolveNativeBilling for OpenCode models. */
export function usageProviderAndBillerFromModel(model: string): { provider: string; biller: string } {
  const parts = model.split("/");
  if (parts.length < 2 || !parts[0]) return { provider: "unknown", biller: "unknown" };
  const biller = parts[0];
  const provider = biller === "openrouter" && parts.length > 2 && parts[1] ? parts[1] : biller;
  return { provider, biller };
}

const maxDurationMs = 24 * 60 * 60 * 1000;
// Matches the usage_request_logs retention horizon; older records would be
// swept anyway, so they are refused instead of corrupting the log ordering.
const maxAgeMs = 90 * 24 * 60 * 60 * 1000;
const futureToleranceMs = 60 * 1000;
const maxTokenValue = Number.MAX_SAFE_INTEGER;

function boundedText(value: unknown, maxLength: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength ? value : null;
}

function nonnegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= maxTokenValue ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseUsageTokens(value: unknown): ProviderRequestUsageTokens | null {
  if (!isRecord(value)) return null;
  // A present-but-invalid count means the block was misread; null the whole
  // block instead of storing partial garbage. Absent fields stay null.
  const fields: Array<[keyof ProviderRequestUsageTokens, unknown]> = [
    ["inputTokens", value.inputTokens],
    ["cachedInputTokens", value.cachedInputTokens],
    ["cacheWriteTokens", value.cacheWriteTokens],
    ["outputTokens", value.outputTokens],
  ];
  const parsed = Object.fromEntries(fields.map(([key, raw]) => {
    if (raw === undefined || raw === null) return [key, null];
    const count = nonnegativeInteger(raw);
    return count === null ? [key, "invalid"] : [key, count];
  })) as Record<keyof ProviderRequestUsageTokens, number | "invalid" | null>;
  if (Object.values(parsed).some(entry => entry === "invalid")) return null;
  return {
    inputTokens: parsed.inputTokens === "invalid" ? null : parsed.inputTokens,
    cachedInputTokens: parsed.cachedInputTokens === "invalid" ? null : parsed.cachedInputTokens,
    cacheWriteTokens: parsed.cacheWriteTokens === "invalid" ? null : parsed.cacheWriteTokens,
    outputTokens: parsed.outputTokens === "invalid" ? null : parsed.outputTokens,
  };
}

/**
 * Project an event payload into a bounded usage record. Returns null for
 * anything that is not a well-formed `provider_request` payload so a hostile
 * or stale runner cannot corrupt the log.
 */
export function parseProviderRequestUsageRecord(
  payload: unknown,
  observedAtMs: number,
): ProviderRequestUsageRecord | null {
  if (!isRecord(payload) || payload.kind !== PROVIDER_REQUEST_USAGE_KIND || !isRecord(payload.request)) return null;
  const value = payload.request;
  const requestId = boundedText(value.requestId, 200);
  const app = boundedText(value.app, 100);
  const provider = boundedText(value.provider, 200);
  const biller = boundedText(value.biller, 200);
  const model = boundedText(value.model, 400);
  const { startedAtMs, endedAtMs } = value;
  if (!requestId || !app || !provider || !biller || !model) return null;
  if (typeof startedAtMs !== "number" || typeof endedAtMs !== "number"
    || !Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs)
    || startedAtMs < observedAtMs - maxAgeMs
    || endedAtMs < startedAtMs
    || endedAtMs - startedAtMs > maxDurationMs
    || endedAtMs > observedAtMs + futureToleranceMs) return null;
  const ttftMs = value.ttftMs === null ? null : nonnegativeInteger(value.ttftMs);
  if (value.ttftMs !== null && ttftMs === null) return null;
  if (ttftMs !== null && ttftMs > endedAtMs - startedAtMs) return null;
  const httpStatus = value.httpStatus === null ? null : nonnegativeInteger(value.httpStatus);
  if (value.httpStatus !== null && (httpStatus === null || httpStatus < 100 || httpStatus > 599)) return null;
  const providerRequestId = value.providerRequestId === null ? null : boundedText(value.providerRequestId, 400);
  if (value.providerRequestId !== null && providerRequestId === null) return null;
  // The flag is optional (runner builds older than the include_usage retry do
  // not send it) but must be boolean when present.
  const usageMissing = value.usageMissing === undefined ? false : value.usageMissing;
  if (typeof usageMissing !== "boolean") return null;
  return {
    requestId, app, provider, biller, model, startedAtMs, endedAtMs,
    ttftMs, httpStatus, providerRequestId,
    usage: value.usage === null ? null : parseUsageTokens(value.usage),
    usageMissing,
  };
}
