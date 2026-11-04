import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from "node:http";
import type { IncomingMessage } from "node:http";
import { AddressInfo } from "node:net";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { startOpenCodeProviderProxy } from "./provider-proxy.js";
import { createUsageCaptureSink } from "./usage-capture.js";

const upstreams: Array<{ server: Server }> = [];
let upstreamPort = 0;
let upstreamRequests: Array<{ body: string; headers: IncomingHttpHeaders }> = [];

async function listen(server: Server): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

function useUpstream(handler: (req: IncomingMessage, res: ServerResponse, body: string) => void) {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      upstreamRequests.push({ body, headers: req.headers });
      handler(req, res, body);
    });
  });
  upstreams.push({ server });
  return listen(server).then(port => {
    upstreamPort = port;
    return port;
  });
}

function sink() {
  return createUsageCaptureSink({ app: "opencode", model: "paperclip/openai/gpt-5.2" });
}

function proxyFor(capture: ReturnType<typeof sink> | null, port = upstreamPort) {
  return startOpenCodeProviderProxy(`http://127.0.0.1:${port}/v1`, "upstream-key", "openai/gpt-5.2", {}, capture);
}

async function completeProxy(proxy: Awaited<ReturnType<typeof startOpenCodeProviderProxy>>, sinkToDrain?: ReturnType<typeof sink>) {
  await proxy.close();
  return sinkToDrain ? sinkToDrain.take() : [];
}

async function post(
  proxy: Awaited<ReturnType<typeof startOpenCodeProviderProxy>>,
  body: string,
  init: { authorization?: string; method?: string; url?: string; signal?: AbortSignal } = {},
) {
  return fetch(`${proxy.baseURL}${init.url ?? "/chat/completions"}`, {
    method: init.method ?? "POST",
    headers: { "Content-Type": "application/json", ...(init.authorization === null ? {} : { Authorization: `Bearer ${init.authorization ?? proxy.token}` }) },
    body,
    signal: init.signal,
  });
}

const chatBody = JSON.stringify({ model: "openai/gpt-5.2", messages: [{ role: "user", content: "hi" }] });

beforeEach(() => {
  upstreamRequests = [];
});

afterAll(async () => {
  for (const { server } of upstreams.splice(0)) {
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
  }
});

describe("OpenCode provider proxy usage observation", () => {
  it("records exactly one row for a non-streaming call with tokens, upstream id and forwarded body untouched", async () => {
    await useUpstream((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json", "x-request-id": "up-77" });
      res.end(JSON.stringify({
        id: "up-77",
        choices: [{ message: { role: "assistant", content: "hello" } }],
        usage: { prompt_tokens: 120, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 80 } },
      }));
    });
    const capture = sink();
    const proxy = await proxyFor(capture);
    try {
      const response = await post(proxy, chatBody);
      expect(response.status).toBe(200);
      const payload = await response.json() as { usage: { prompt_tokens: number } };
      expect(payload.usage.prompt_tokens).toBe(120);
      expect(upstreamRequests).toHaveLength(1);
      expect(upstreamRequests[0]!.body).toBe(chatBody);
      expect(upstreamRequests[0]!.headers.authorization).toBe("Bearer upstream-key");
      const records = capture.take();
      expect(records).toHaveLength(1);
      const record = records[0]!;
      expect(record).toMatchObject({
        app: "opencode",
        provider: "paperclip",
        biller: "paperclip",
        model: "paperclip/openai/gpt-5.2",
        httpStatus: 200,
        providerRequestId: "up-77",
        usage: { inputTokens: 120, cachedInputTokens: 80, cacheWriteTokens: null, outputTokens: 30 },
      });
      expect(record.requestId).toMatch(/[0-9a-f-]{36}/);
      expect(record.startedAtMs).toBeLessThanOrEqual(record.endedAtMs);
      expect(record.endedAtMs - record.startedAtMs).toBeLessThan(10_000);
      expect(record.ttftMs).not.toBeNull();
      expect(record.ttftMs!).toBeLessThanOrEqual(record.endedAtMs - record.startedAtMs);
    } finally {
      await completeProxy(proxy);
    }
  });

  it("parses usage from the final SSE frame of a streamed response and keeps timing ordered", async () => {
    await useUpstream((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write('data: {"id":"c1","choices":[{"delta":{"content":"abc"}}]}\n\n');
      setTimeout(() => {
        res.write('data: {"id":"c1","choices":[{"delta":{"content":"def"}}]}\n\n');
        res.write('data: {"id":"c1","choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3}}\n\n');
        res.write("data: [DONE]\n\n");
        res.end();
      }, 20);
    });
    const capture = sink();
    const proxy = await proxyFor(capture);
    try {
      const response = await post(proxy, chatBody);
      expect(response.status).toBe(200);
      await response.text();
      const [record] = capture.take();
      expect(record).not.toBeUndefined();
      expect(record.httpStatus).toBe(200);
      expect(record.usage).toEqual({ inputTokens: 7, cachedInputTokens: null, cacheWriteTokens: null, outputTokens: 3 });
      expect(record.ttftMs).not.toBeNull();
      expect(record.endedAtMs - record.startedAtMs).toBeGreaterThanOrEqual(record.ttftMs!);
    } finally {
      await completeProxy(proxy);
    }
  });

  it("keeps token columns null when a streamed response never reports usage", async () => {
    await useUpstream((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write('data: {"id":"c1","choices":[{"delta":{"content":"abc"}}]}\n\n');
      res.end("data: [DONE]\n\n");
    });
    const capture = sink();
    const proxy = await proxyFor(capture);
    try {
      const response = await post(proxy, chatBody);
      expect(response.status).toBe(200);
      await response.text();
      const [record] = capture.take();
      expect(record.httpStatus).toBe(200);
      expect(record.usage).toBeNull();
    } finally {
      await completeProxy(proxy);
    }
  });

  it("records upstream error statuses with no token data and still answers the client", async () => {
    await useUpstream((_req, res) => {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "rate limited" } }));
    });
    const capture = sink();
    const proxy = await proxyFor(capture);
    try {
      const response = await post(proxy, chatBody);
      expect(response.status).toBe(429);
      await response.text();
      const [record] = capture.take();
      expect(record).toMatchObject({ httpStatus: 429, usage: null, providerRequestId: null });
    } finally {
      await completeProxy(proxy);
    }
  });

  it("records a redirect rejection with its upstream status", async () => {
    await useUpstream((_req, res) => {
      res.writeHead(302, { Location: "https://elsewhere.example/chat" });
      res.end();
    });
    const capture = sink();
    const proxy = await proxyFor(capture);
    try {
      const response = await post(proxy, chatBody);
      expect(response.status).toBe(502);
      const [record] = capture.take();
      expect(record.httpStatus).toBe(302);
    } finally {
      await completeProxy(proxy);
    }
  });

  it("records a null upstream status when the upstream is unreachable", async () => {
    const capture = sink();
    const proxy = await proxyFor(capture, await freePort());
    try {
      const response = await post(proxy, chatBody);
      expect(response.status).toBe(502);
      const records = capture.take();
      expect(records).toHaveLength(1);
      expect(records[0]!.httpStatus).toBeNull();
      expect(records[0]!.usage).toBeNull();
      expect(records[0]!.ttftMs).toBeNull();
    } finally {
      await completeProxy(proxy);
    }
  });

  it("still records the exchange when the client aborts a stream mid-flight", async () => {
    await useUpstream((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write('data: {"id":"c1","choices":[{"delta":{"content":"abc"}}]}\n\n');
      // Never ends; the client abort drives the teardown.
    });
    const capture = sink();
    const proxy = await proxyFor(capture);
    try {
      const response = await post(proxy, chatBody, { signal: AbortSignal.timeout(150) });
      // Headers arrive before the abort; the aborted body stream is what rejects.
      await expect(response.text()).rejects.toThrow();
      await new Promise(resolve => setTimeout(resolve, 50));
      const records = capture.take();
      expect(records).toHaveLength(1);
      expect(records[0]!.httpStatus).toBe(200);
      expect(records[0]!.usage).toBeNull();
    } finally {
      await completeProxy(proxy);
    }
  });

  function headRequest(proxy: Awaited<ReturnType<typeof startOpenCodeProviderProxy>>, method: string, authorization?: string) {
    return fetch(`${proxy.baseURL}/chat/completions`, {
      method,
      headers: { Authorization: `Bearer ${authorization ?? proxy.token}` },
    });
  }

  it("produces no record for requests the proxy rejects before the upstream", async () => {
    await useUpstream((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
    const capture = sink();
    const proxy = await proxyFor(capture);
    try {
      expect((await post(proxy, chatBody, { authorization: "wrong" })).status).toBe(401);
      expect((await headRequest(proxy, "GET")).status).toBe(404);
      expect((await post(proxy, "not json")).status).toBe(400);
      expect((await post(proxy, JSON.stringify({ model: "other/model" }))).status).toBe(400);
      expect(capture.take()).toHaveLength(0);
    } finally {
      await completeProxy(proxy);
    }
  });

  it("passes traffic through byte-identically when capture is off", async () => {
    const payload = JSON.stringify({ id: "x", choices: [] });
    await useUpstream((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(payload);
    });
    const proxy = await proxyFor(null);
    try {
      const response = await post(proxy, chatBody);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(payload);
    } finally {
      await completeProxy(proxy);
    }
  });
});

async function freePort(): Promise<number> {
  const { createServer: netCreateServer } = await import("node:net");
  const probe = netCreateServer();
  await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  return port;
}
