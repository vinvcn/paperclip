import { randomBytes, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { createServer as createHttpServer, Agent as HttpAgent, request as requestHttp, type IncomingMessage } from "node:http";
import { Agent as HttpsAgent, request as requestHttps } from "node:https";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { getCACertificates } from "node:tls";
import { isOpenRouterUrl, OPENROUTER_ATTRIBUTION_HEADERS } from "../openrouter-attribution.js";
import type { ProviderRequestUsageSink } from "../../contracts/usage-capture.js";
import { extractProviderUsageBlock, usageTokensFromBlock, USAGE_TAIL_BYTES } from "./usage-capture.js";

/**
 * The OpenCode provider proxy: a loopback HTTP gateway in front of the real
 * provider route (`paperclip/*` and `openrouter/*` models). This is the P1
 * usage observation point (ADR-0002): when a capture sink is supplied, every
 * accepted chat-completions exchange produces exactly one usage record. With
 * `capture = null` (kill switch off) the code path is byte-identical to the
 * unobserved proxy — no sinks, no taps, no body scanning.
 */
export async function startOpenCodeProviderProxy(
  baseUrl: string,
  key: string,
  model: string,
  environment: NodeJS.ProcessEnv,
  capture: ProviderRequestUsageSink | null = null,
) {
  const upstreamUrl = new URL(`${baseUrl.replace(/\/+$/, "")}/chat/completions`);
  const token = randomBytes(32).toString("base64url");
  // Agent-local settings keep one runtime's transport configuration out of other sessions.
  const proxyEnv = {
    HTTP_PROXY: environment.http_proxy ?? environment.HTTP_PROXY ?? environment.all_proxy ?? environment.ALL_PROXY,
    HTTPS_PROXY: environment.https_proxy ?? environment.HTTPS_PROXY ?? environment.http_proxy ?? environment.HTTP_PROXY ?? environment.all_proxy ?? environment.ALL_PROXY,
    NO_PROXY: environment.no_proxy ?? environment.NO_PROXY,
  };
  const ca = [...getCACertificates("default")];
  if (environment.SSL_CERT_FILE) ca.push(await readFile(environment.SSL_CERT_FILE, "utf8"));
  if (environment.SSL_CERT_DIR) {
    for (const entry of await readdir(environment.SSL_CERT_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        const certificate = await readFile(join(environment.SSL_CERT_DIR, entry.name), "utf8");
        if (certificate.includes("-----BEGIN CERTIFICATE-----")) ca.push(certificate);
      }
    }
  }
  const agent = upstreamUrl.protocol === "https:" ? new HttpsAgent({ proxyEnv, ca }) : new HttpAgent({ proxyEnv });
  const controllers = new Set<AbortController>();
  const server = createHttpServer((request, response) => {
    const controller = new AbortController();
    controllers.add(controller);
    response.once("close", () => controller.abort());
    void (async () => {
      if (request.headers.authorization !== `Bearer ${token}`) {
        response.writeHead(401).end();
        return;
      }
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
        response.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 16 * 1024 * 1024) {
          response.writeHead(413).end();
          return;
        }
        chunks.push(Buffer.from(chunk));
      }
      const body = Buffer.concat(chunks);
      let payload: Record<string, unknown>;
      try { payload = JSON.parse(body.toString("utf8")); }
      catch { response.writeHead(400).end(); return; }
      if (!payload || typeof payload !== "object" || payload.model !== model ||
        ["models", "route", "plugins", "transforms"].some(field => Object.hasOwn(payload, field))) {
        response.writeHead(400).end();
        return;
      }
      // Usage observation. The request id is runner-generated so re-delivery
      // is idempotent; the response tail is kept only to read the usage block
      // and is never persisted or logged.
      const requestId = capture ? randomUUID() : "";
      const startedAtMs = capture ? Date.now() : 0;
      // A streamed response reports its usage only in a final SSE frame the
      // client never asks for. With capture on, the proxy injects
      // stream_options.include_usage when the client did not set it; if the
      // upstream refuses the injected field with a 4xx, the proxy retries
      // once with the client's original body and marks the record
      // usage_missing instead of failing (docs/specs/usage-request-logs.md,
      // Capture). With capture off the request bytes stay untouched.
      const clientStreamOptions: unknown = payload.stream_options;
      const clientStreamOptionsIsObject = clientStreamOptions !== null
        && typeof clientStreamOptions === "object"
        && !Array.isArray(clientStreamOptions);
      const clientSetIncludeUsage = clientStreamOptionsIsObject
        && Object.hasOwn(clientStreamOptions as object, "include_usage");
      const injectIncludeUsage = capture !== null && payload.stream === true && !clientSetIncludeUsage;
      let attemptBody = body;
      if (injectIncludeUsage) {
        attemptBody = Buffer.from(JSON.stringify({
          ...payload,
          stream_options: {
            ...(clientStreamOptionsIsObject ? clientStreamOptions as Record<string, unknown> : {}),
            include_usage: true,
          },
        }), "utf8");
      }
      let firstByteAt: number | null = null;
      let providerRequestId: string | null = null;
      let upstream: IncomingMessage | null = null;
      const tailChunks: Buffer[] = [];
      let tailBytes = 0;
      let usageMissing = false;
      let recorded = false;
      const record = (httpStatus: number | null) => {
        if (!capture || recorded) return;
        recorded = true;
        const endedAtMs = Date.now();
        capture.record({
          requestId,
          startedAtMs,
          endedAtMs,
          ttftMs: firstByteAt === null ? null : Math.max(0, firstByteAt - startedAtMs),
          httpStatus,
          providerRequestId,
          usage: usageTokensFromBlock(extractProviderUsageBlock(Buffer.concat(tailChunks).toString("utf8"))),
          usageMissing,
        });
      };
      const tapUpstream = (chunk: Buffer) => {
        firstByteAt ??= Date.now();
        tailBytes += chunk.length;
        tailChunks.push(Buffer.from(chunk));
        while (tailChunks.length > 1 && tailBytes - tailChunks[0]!.length >= USAGE_TAIL_BYTES) {
          tailBytes -= tailChunks[0]!.length;
          tailChunks.shift();
        }
      };
      try {
        for (let attempt = 0; ; attempt += 1) {
          // Every attempt measures its own timing and response tail; only the
          // final attempt is forwarded to the client and recorded.
          firstByteAt = null;
          providerRequestId = null;
          tailChunks.length = 0;
          tailBytes = 0;
          upstream = await new Promise<IncomingMessage>((resolve, reject) => {
            const outgoing = (upstreamUrl.protocol === "https:" ? requestHttps : requestHttp)(upstreamUrl, {
              method: "POST",
              agent,
              headers: { ...(isOpenRouterUrl(baseUrl) ? OPENROUTER_ATTRIBUTION_HEADERS : {}), "Content-Type": "application/json", "Content-Length": attemptBody.length, ...(key ? { Authorization: `Bearer ${key}` } : {}) },
              signal: AbortSignal.any([controller.signal, AbortSignal.timeout(600_000)]),
            }, resolve);
            outgoing.once("error", reject);
            outgoing.end(attemptBody);
          });
          // Never forward authentication to a redirect destination.
          const status = upstream.statusCode ?? 502;
          const upstreamId = upstream.headers["x-request-id"];
          providerRequestId = typeof upstreamId === "string" && upstreamId.length <= 400 ? upstreamId : null;
          if (injectIncludeUsage && attempt === 0 && status >= 400 && status < 500) {
            // The upstream refused the injected field: retry once without it.
            usageMissing = true;
            attemptBody = body;
            upstream.destroy();
            continue;
          }
          if (status >= 300 && status < 400) {
            upstream.destroy();
            record(status);
            throw new Error("Provider redirects are not supported");
          }
          const headers: Record<string, string> = {};
          for (const name of ["content-type", "content-encoding", "cache-control", "retry-after"]) {
            const value = upstream.headers[name];
            if (typeof value === "string") headers[name] = value;
          }
          response.writeHead(status, headers);
          if (capture) upstream.on("data", tapUpstream);
          await pipeline(upstream, response);
          record(status);
          break;
        }
      } catch (error) {
        record(upstream?.statusCode ?? null);
        throw error;
      }
    })().catch(() => {
      if (!response.headersSent) response.writeHead(502).end("Provider request failed");
      else response.destroy();
    }).finally(() => controllers.delete(controller));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
  } catch (error) { agent.destroy(); throw error; }
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    agent.destroy();
    throw new Error("Could not bind OpenCode provider proxy");
  }
  return {
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    token,
    close: async () => {
      for (const controller of controllers) controller.abort();
      agent.destroy();
      await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
    },
  };
}
