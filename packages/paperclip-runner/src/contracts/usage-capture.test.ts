import { describe, expect, it } from "vitest";
import {
  parseProviderRequestUsageRecord,
  usageCaptureEnabled,
  usageProviderAndBillerFromModel,
  USAGE_CAPTURE_ENV,
  PROVIDER_REQUEST_USAGE_KIND,
  type ProviderRequestUsageRecord,
} from "./usage-capture.js";

function validRecord(overrides: Partial<ProviderRequestUsageRecord> = {}): ProviderRequestUsageRecord {
  const startedAtMs = Date.now() - 50;
  return {
    requestId: "0f0e0d0c-0b0a-4948-8786-854433221100",
    app: "opencode",
    provider: "paperclip",
    biller: "paperclip",
    model: "paperclip/openai/gpt-5.2",
    startedAtMs,
    endedAtMs: startedAtMs + 40,
    ttftMs: 12,
    httpStatus: 200,
    providerRequestId: "upstream-1",
    usage: { inputTokens: 100, cachedInputTokens: 40, cacheWriteTokens: null, outputTokens: 20 },
    usageMissing: false,
    ...overrides,
  };
}

describe("usage capture contract", () => {
  it("captures by default and only disables on explicit 0/off", () => {
    expect(USAGE_CAPTURE_ENV).toBe("PAPERCLIP_USAGE_CAPTURE");
    expect(usageCaptureEnabled(undefined)).toBe(true);
    expect(usageCaptureEnabled({})).toBe(true);
    expect(usageCaptureEnabled({ [USAGE_CAPTURE_ENV]: "1" })).toBe(true);
    expect(usageCaptureEnabled({ [USAGE_CAPTURE_ENV]: "" })).toBe(true);
    expect(usageCaptureEnabled({ [USAGE_CAPTURE_ENV]: "0" })).toBe(false);
    expect(usageCaptureEnabled({ [USAGE_CAPTURE_ENV]: "off" })).toBe(false);
    expect(usageCaptureEnabled({ [USAGE_CAPTURE_ENV]: "OFF" })).toBe(false);
  });

  it("splits provider and biller the same way the server's native billing does", () => {
    expect(usageProviderAndBillerFromModel("paperclip/openai/gpt-5.2")).toEqual({ provider: "paperclip", biller: "paperclip" });
    expect(usageProviderAndBillerFromModel("openrouter/anthropic/claude-sonnet-4")).toEqual({ provider: "anthropic", biller: "openrouter" });
    expect(usageProviderAndBillerFromModel("openrouter/gpt-5.2")).toEqual({ provider: "openrouter", biller: "openrouter" });
    expect(usageProviderAndBillerFromModel("bare-model")).toEqual({ provider: "unknown", biller: "unknown" });
    expect(usageProviderAndBillerFromModel("")).toEqual({ provider: "unknown", biller: "unknown" });
  });

  it("accepts a well-formed provider_request payload and projects every bounded field", () => {
    const now = Date.now();
    const record = validRecord({ startedAtMs: now - 50, endedAtMs: now - 10 });
    const parsed = parseProviderRequestUsageRecord(
      { kind: PROVIDER_REQUEST_USAGE_KIND, request: record },
      now,
    );
    expect(parsed).toEqual(record);
  });

  it("rejects payloads that are not provider_request usage records", () => {
    const now = Date.now();
    expect(parseProviderRequestUsageRecord({ kind: "other", request: validRecord() }, now)).toBeNull();
    expect(parseProviderRequestUsageRecord({ request: validRecord() }, now)).toBeNull();
    expect(parseProviderRequestUsageRecord(validRecord(), now)).toBeNull();
    expect(parseProviderRequestUsageRecord(null, now)).toBeNull();
    expect(parseProviderRequestUsageRecord({ kind: PROVIDER_REQUEST_USAGE_KIND, request: "nope" }, now)).toBeNull();
    expect(parseProviderRequestUsageRecord({ kind: PROVIDER_REQUEST_USAGE_KIND, request: [] }, now)).toBeNull();
  });

  it("drops malformed field values instead of storing them", () => {
    const now = Date.now();
    const cases: Array<Partial<ProviderRequestUsageRecord>> = [
      { requestId: "" },
      { requestId: "x".repeat(300) },
      { app: "" },
      { model: "" },
      { startedAtMs: Number.NaN },
      { startedAtMs: now - 91 * 24 * 60 * 60 * 1000 },
      { endedAtMs: now + 10 * 60 * 1000 },
      { endedAtMs: now - 100, startedAtMs: now - 50 },
      { startedAtMs: now - 40 * 60 * 60 * 1000, endedAtMs: now },
      { ttftMs: -1 },
      { ttftMs: 100, startedAtMs: now - 50, endedAtMs: now - 10 },
      { httpStatus: 99 },
      { httpStatus: 1000.5 },
      { providerRequestId: 42 as unknown as string },
    ];
    for (const overrides of cases) {
      expect(parseProviderRequestUsageRecord({ kind: PROVIDER_REQUEST_USAGE_KIND, request: validRecord(overrides) }, now)).toBeNull();
    }
  });

  it("keeps the record but discards the usage block when a token count is malformed", () => {
    const now = Date.now();
    for (const usage of [
      { inputTokens: -5, cachedInputTokens: null, cacheWriteTokens: null, outputTokens: 1 },
      { inputTokens: Number.MAX_SAFE_INTEGER + 1, cachedInputTokens: null, cacheWriteTokens: null, outputTokens: 1 },
      { inputTokens: 1.5, cachedInputTokens: null, cacheWriteTokens: null, outputTokens: 1 },
    ]) {
      const parsed = parseProviderRequestUsageRecord({ kind: PROVIDER_REQUEST_USAGE_KIND, request: validRecord({ usage }) }, now);
      expect(parsed).not.toBeNull();
      expect(parsed!.usage).toBeNull();
    }
    expect(parseProviderRequestUsageRecord(
      { kind: PROVIDER_REQUEST_USAGE_KIND, request: validRecord({ usage: "junk" as unknown as ProviderRequestUsageRecord["usage"] }) },
      now,
    )?.usage).toBeNull();
  });

  it("keeps records without usage, ttft or provider request id (degraded capture)", () => {
    const now = Date.now();
    const record = validRecord({
      ttftMs: null,
      httpStatus: null,
      providerRequestId: null,
      usage: null,
      startedAtMs: now - 30,
      endedAtMs: now - 25,
    });
    expect(parseProviderRequestUsageRecord({ kind: PROVIDER_REQUEST_USAGE_KIND, request: record }, now)).toEqual(record);
  });

  it("carries the usage_missing flag through the durable parse boundary", () => {
    const now = Date.now();
    // Older runner builds do not send the flag; it parses as false.
    const legacy = validRecord() as Partial<ProviderRequestUsageRecord>;
    delete legacy.usageMissing;
    expect(parseProviderRequestUsageRecord(
      { kind: PROVIDER_REQUEST_USAGE_KIND, request: legacy as ProviderRequestUsageRecord },
      now,
    )).toMatchObject({ usageMissing: false });
    expect(parseProviderRequestUsageRecord(
      { kind: PROVIDER_REQUEST_USAGE_KIND, request: validRecord({ usageMissing: true }) },
      now,
    )).toMatchObject({ usageMissing: true });
    // A non-boolean flag is malformed and drops the whole record.
    expect(parseProviderRequestUsageRecord(
      { kind: PROVIDER_REQUEST_USAGE_KIND, request: validRecord({ usageMissing: "yes" as unknown as boolean }) },
      now,
    )).toBeNull();
  });
});
