import { describe, expect, it } from "vitest";
import {
  createUsageCaptureSink,
  extractProviderUsageBlock,
  usageTokensFromBlock,
} from "./usage-capture.js";

describe("usage capture sink", () => {
  const observation = {
    requestId: "req-1",
    startedAtMs: 1000,
    endedAtMs: 1500,
    ttftMs: 40,
    httpStatus: 200,
    providerRequestId: "up-1",
    usageMissing: false,
    usage: { inputTokens: 10, cachedInputTokens: null, cacheWriteTokens: null, outputTokens: 4 },
  };

  it("buffers observations until a delivery callback is wired, then delivers directly", () => {
    const sink = createUsageCaptureSink({ app: "opencode", model: "paperclip/openai/gpt-5.2" });
    sink.record(observation);
    expect(sink.take()).toHaveLength(1);
    expect(sink.take()).toHaveLength(0);
    const delivered: unknown[] = [];
    sink.onRecord(record => delivered.push(record));
    sink.record(observation);
    expect(delivered).toHaveLength(1);
    expect(sink.take()).toHaveLength(0);
  });

  it("projects app, provider and biller from the qualified model, not the request body model", () => {
    const sink = createUsageCaptureSink({ app: "opencode", model: "openrouter/anthropic/claude-sonnet-4" });
    sink.record({ ...observation, requestId: "req-2" });
    const [record] = sink.take();
    expect(record).toMatchObject({
      app: "opencode",
      provider: "anthropic",
      biller: "openrouter",
      model: "openrouter/anthropic/claude-sonnet-4",
    });
    expect(record.endedAtMs - record.startedAtMs).toBe(500);
  });

  it("stamps pooled key attribution onto every record (ticket 04)", () => {
    const sink = createUsageCaptureSink({
      app: "opencode",
      model: "paperclip/meta/llama-3.3-70b-instruct",
      keySlot: 3,
      connectionId: "conn-uuid-1",
    });
    sink.record({ ...observation, requestId: "req-slot" });
    expect(sink.take()[0]).toMatchObject({ keySlot: 3, connectionId: "conn-uuid-1" });
  });

  it("leaves key attribution null when the credential is not pooled (backward compatibility)", () => {
    const sink = createUsageCaptureSink({ app: "opencode", model: "paperclip/gpt-5.2" });
    sink.record({ ...observation, requestId: "req-plain" });
    const record = sink.take()[0]!;
    expect(record.keySlot).toBeNull();
    expect(record.connectionId).toBeNull();
  });

  it("bounds the buffer when nothing drains it", () => {
    const sink = createUsageCaptureSink({ app: "opencode", model: "paperclip/gpt-5.2", capacity: 3 });
    for (let index = 0; index < 10; index += 1) sink.record({ ...observation, requestId: `req-${index}` });
    expect(sink.take()).toHaveLength(3);
  });

  it("keeps buffering when the delivery callback throws", () => {
    const sink = createUsageCaptureSink({ app: "opencode", model: "paperclip/gpt-5.2" });
    sink.onRecord(() => { throw new Error("deliver failed"); });
    sink.record(observation);
    expect(sink.take()).toHaveLength(1);
  });
});

describe("provider usage block extraction", () => {
  it("reads the usage object from a plain JSON response tail", () => {
    const body = JSON.stringify({
      id: "chatcmpl-1",
      choices: [{ message: { role: "assistant", content: "hi" } }],
      usage: { prompt_tokens: 101, completion_tokens: 22, prompt_tokens_details: { cached_tokens: 60 } },
    });
    expect(usageTokensFromBlock(extractProviderUsageBlock(body))).toEqual({
      inputTokens: 101,
      cachedInputTokens: 60,
      cacheWriteTokens: null,
      outputTokens: 22,
    });
  });

  it("reads the usage object from the last SSE frame that carries one", () => {
    const tail = [
      'data: {"id":"c1","choices":[{"delta":{"content":"abc def ghi jkl mno pqr stu vwx"}}]}',
      "",
      'data: {"id":"c1","choices":[{"delta":{"content":"more"}}],"usage":null}',
      "",
      'data: {"id":"c1","choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3,"cache_creation_input_tokens":2}}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    expect(usageTokensFromBlock(extractProviderUsageBlock(tail))).toEqual({
      inputTokens: 7,
      cachedInputTokens: null,
      cacheWriteTokens: 2,
      outputTokens: 3,
    });
  });

  it("recovers the usage object from a truncated JSON tail", () => {
    const head = '{"id":"chatcmpl-1","object":"chat.completion","choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"long answer"}}],"usage":{"prompt_tokens":';
    const truncated = `${"x".repeat(200)}${head}33,"completion_tokens":9}}`;
    expect(usageTokensFromBlock(extractProviderUsageBlock(truncated))).toEqual({
      inputTokens: 33,
      cachedInputTokens: null,
      cacheWriteTokens: null,
      outputTokens: 9,
    });
  });

  it("returns null when no usage block is present", () => {
    expect(extractProviderUsageBlock('{"choices":[{"message":{"content":"no usage here"}}]}')).toBeNull();
    expect(extractProviderUsageBlock("data: {\"choices\":[]}\n\ndata: [DONE]\n\n")).toBeNull();
    expect(extractProviderUsageBlock("")).toBeNull();
  });

  it("returns null tokens when the usage block carries no observable counts", () => {
    expect(usageTokensFromBlock({})).toBeNull();
    expect(usageTokensFromBlock({ prompt_tokens: "12" })).toBeNull();
    expect(usageTokensFromBlock(null)).toBeNull();
  });
});
