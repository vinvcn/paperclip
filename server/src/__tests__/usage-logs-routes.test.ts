import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { usageRoutes } from "../routes/usage.js";
import { errorHandler } from "../middleware/error-handler.js";

const mocks = vi.hoisted(() => ({ latest: vi.fn(), summary: vi.fn(), decide: vi.fn() }));
vi.mock("../services/usage-request-logs.js", () => ({ usageRequestLogService: () => ({ latest: mocks.latest, summary: mocks.summary }) }));
vi.mock("../services/index.js", () => ({ accessService: () => ({ decide: mocks.decide }) }));

const companyId = "11111111-1111-4111-8111-111111111111";
const logsPath = `/api/companies/${companyId}/usage/logs`;
const summaryPath = `/api/companies/${companyId}/usage/summary`;

const summaryFixture = {
  companyId,
  totalRequests: 12,
  totalCostCents: "0",
  freshInputTokens: 1500,
  cachedInputTokens: 500,
  cacheWriteTokens: 200,
  outputTokens: 800,
  tokensProcessed: 3000,
  cacheHitRate: 0.25,
  unpricedCount: 12,
  series: [],
  facets: { apps: [], providers: [], models: [], keys: [], modelsTruncated: false },
};

function app(type: "board" | "agent" = "board", role = "member") {
  const instance = express();
  instance.use(express.json());
  instance.use((req, _res, next) => {
    req.actor = type === "board"
      ? { type: "board", source: "session", userId: "alice", companyIds: [companyId], memberships: [{ companyId, status: "active", membershipRole: role }] } as typeof req.actor
      : { type: "agent", agentId: "agent", companyId } as typeof req.actor;
    next();
  });
  instance.use("/api", usageRoutes({} as Db));
  instance.use(errorHandler);
  return instance;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.decide.mockResolvedValue({ allowed: true });
  mocks.latest.mockResolvedValue([]);
  mocks.summary.mockResolvedValue(summaryFixture);
});

describe("usage request log route authorization", () => {
  it("returns the latest rows page for board readers with the cost-scope read decision", async () => {
    const page = { rows: [{ requestId: "r1" }], total: 1, nextCursor: null };
    mocks.latest.mockResolvedValue(page);
    const response = await request(app()).get(`${logsPath}?limit=5`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual(page);
    expect(mocks.latest).toHaveBeenCalledExactlyOnceWith(companyId, 5, {});
    expect(mocks.decide).toHaveBeenCalledWith(expect.objectContaining({
      action: "company_scope:read",
      resource: { type: "company", companyId },
    }));
  });

  it("defaults the limit to 20 and rejects invalid limits before reading rows", async () => {
    expect((await request(app()).get(logsPath)).status).toBe(200);
    expect(mocks.latest).toHaveBeenLastCalledWith(companyId, 20, {});
    for (const limit of ["0", "-1", "501", "abc", "2.5"]) {
      expect((await request(app()).get(`${logsPath}?limit=${limit}`)).status).toBe(400);
    }
    expect(mocks.latest).toHaveBeenCalledTimes(1);
  });

  it("rejects agents, foreign companies and denied cost-scope readers without reading rows", async () => {
    expect((await request(app("agent")).get(logsPath)).status).toBe(403);
    expect((await request(app()).get("/api/companies/other/usage/logs")).status).toBe(403);
    mocks.decide.mockResolvedValue({ allowed: false });
    expect((await request(app()).get(logsPath)).status).toBe(403);
    expect(mocks.latest).not.toHaveBeenCalled();
  });
});

describe("usage summary route", () => {
  it("returns the DB-aggregated summary for board readers with the cost-scope read decision", async () => {
    const response = await request(app()).get(summaryPath);
    expect(response.status).toBe(200);
    expect(response.body).toEqual(summaryFixture);
    expect(mocks.summary).toHaveBeenCalledExactlyOnceWith(companyId, undefined, "UTC", {});
    expect(mocks.decide).toHaveBeenCalledWith(expect.objectContaining({
      action: "company_scope:read",
      resource: { type: "company", companyId },
    }));
  });

  it("parses optional from/to bounds into dates and rejects invalid ones before reading", async () => {
    const from = "2026-01-01T00:00:00.000Z";
    const to = "2026-01-02";
    const response = await request(app()).get(`${summaryPath}?from=${from}&to=${to}`);
    expect(response.status).toBe(200);
    expect(mocks.summary).toHaveBeenCalledExactlyOnceWith(companyId, { from: new Date(from), to: new Date(to) }, "UTC", {});
    for (const query of ["from=nope", "to=nope", "from=2026-02-02T00:00:00.000Z&to=2026-01-01T00:00:00.000Z"]) {
      expect((await request(app()).get(`${summaryPath}?${query}`)).status).toBe(400);
    }
    expect(mocks.summary).toHaveBeenCalledTimes(1);
  });

  it("forwards the viewer timezone and canonicalizes it for the SQL bucketing", async () => {
    const response = await request(app()).get(`${summaryPath}?tz=asia%2Fshanghai`);
    expect(response.status).toBe(200);
    expect(mocks.summary).toHaveBeenCalledExactlyOnceWith(companyId, undefined, "Asia/Shanghai", {});
  });

  it("rejects invalid timezones with 400 before touching the service", async () => {
    for (const tz of ["Not/AZone", "../../etc/passwd", "UTC; drop table x"]) {
      const response = await request(app()).get(`${summaryPath}?tz=${encodeURIComponent(tz)}`);
      expect(response.status).toBe(400);
    }
    expect(mocks.summary).not.toHaveBeenCalled();
  });

  it("rejects agents, foreign companies and denied cost-scope readers without aggregating", async () => {
    expect((await request(app("agent")).get(summaryPath)).status).toBe(403);
    expect((await request(app()).get("/api/companies/other/usage/summary")).status).toBe(403);
    mocks.decide.mockResolvedValue({ allowed: false });
    expect((await request(app()).get(summaryPath)).status).toBe(403);
    expect(mocks.summary).not.toHaveBeenCalled();
  });
});

describe("usage filter params", () => {
  it("forwards app, provider, model, key and status filters to the summary", async () => {
    // The model id contains slashes; the URL-encoded form must survive.
    const response = await request(app()).get(
      `${summaryPath}?app=opencode&provider=openrouter&model=openai%2Fgpt-5.2&key=key-3&status=client_error`,
    );
    expect(response.status).toBe(200);
    expect(mocks.summary).toHaveBeenCalledExactlyOnceWith(companyId, undefined, "UTC", {
      app: "opencode",
      provider: "openrouter",
      model: "openai/gpt-5.2",
      key: "key-3",
      status: "client_error",
    });
  });

  it("treats empty filter values as absent, not as a filter", async () => {
    const response = await request(app()).get(`${summaryPath}?app=&provider=&model=&key=&status=`);
    expect(response.status).toBe(200);
    expect(mocks.summary).toHaveBeenCalledExactlyOnceWith(companyId, undefined, "UTC", {});
  });

  it("rejects an unknown status class with 400 before reading anything", async () => {
    for (const status of ["2xx", "SUCCESS", "client-error", "500", "drop table x"]) {
      const response = await request(app()).get(`${summaryPath}?status=${encodeURIComponent(status)}`);
      expect(response.status).toBe(400);
    }
    expect(mocks.summary).not.toHaveBeenCalled();
  });

  it("rejects repeated (array) filter values with 400", async () => {
    expect((await request(app()).get(`${summaryPath}?app=a&app=b`)).status).toBe(400);
    expect((await request(app()).get(`${summaryPath}?status=success&status=client_error`)).status).toBe(400);
    expect(mocks.summary).not.toHaveBeenCalled();
  });

  it("forwards the filters plus a from/to window to the log list", async () => {
    const from = "2026-01-01T00:00:00.000Z";
    const to = "2026-01-02T00:00:00.000Z";
    const response = await request(app()).get(`${logsPath}?app=opencode&status=server_error&from=${from}&to=${to}`);
    expect(response.status).toBe(200);
    expect(mocks.latest).toHaveBeenCalledExactlyOnceWith(companyId, 20, {
      app: "opencode",
      status: "server_error",
      range: { from: new Date(from), to: new Date(to) },
    });
  });

  it("rejects invalid filter values on the log list before reading rows", async () => {
    expect((await request(app()).get(`${logsPath}?status=nope`)).status).toBe(400);
    expect((await request(app()).get(`${logsPath}?from=nope`)).status).toBe(400);
    expect((await request(app()).get(`${logsPath}?provider=a&provider=b`)).status).toBe(400);
    expect(mocks.latest).not.toHaveBeenCalled();
  });
});

describe("usage logs keyset cursor", () => {
  it("parses the after cursor into an occurred-at instant and row id for the service", async () => {
    const occurredAt = "2026-11-04T12:00:00.000Z";
    const id = "22222222-2222-4222-8222-222222222222";
    await request(app()).get(`${logsPath}?after=${encodeURIComponent(`${occurredAt},${id}`)}`);
    expect(mocks.latest).toHaveBeenCalledExactlyOnceWith(companyId, 20, {
      after: { occurredAt: new Date(occurredAt), id },
    });
  });

  it("treats an absent or empty after cursor as page one", async () => {
    await request(app()).get(logsPath);
    await request(app()).get(`${logsPath}?after=`);
    expect(mocks.latest).toHaveBeenNthCalledWith(1, companyId, 20, {});
    expect(mocks.latest).toHaveBeenNthCalledWith(2, companyId, 20, {});
  });

  it("rejects malformed cursors with 400 before reading rows", async () => {
    for (const after of [
      "nope",
      "nope,nope",
      "2026-11-04T12:00:00Z",
      ",22222222-2222-4222-8222-222222222222",
      // A valid instant whose row id is not a uuid would otherwise reach the
      // service's `::uuid` cast and surface as a 500.
      "2026-11-04T12:00:00Z,not-a-uuid",
    ]) {
      const response = await request(app()).get(`${logsPath}?after=${encodeURIComponent(after)}`);
      expect(response.status).toBe(400);
    }
    expect((await request(app()).get(`${logsPath}?after=a&after=b`)).status).toBe(400);
    expect(mocks.latest).not.toHaveBeenCalled();
  });
});
