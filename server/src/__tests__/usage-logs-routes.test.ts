import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { usageRoutes } from "../routes/usage.js";
import { errorHandler } from "../middleware/error-handler.js";

const mocks = vi.hoisted(() => ({ latest: vi.fn(), decide: vi.fn() }));
vi.mock("../services/usage-request-logs.js", () => ({ usageRequestLogService: () => ({ latest: mocks.latest }) }));
vi.mock("../services/index.js", () => ({ accessService: () => ({ decide: mocks.decide }) }));

const companyId = "11111111-1111-4111-8111-111111111111";
const path = `/api/companies/${companyId}/usage/logs`;

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
});

describe("usage request log route authorization", () => {
  it("returns the latest rows for board readers with the cost-scope read decision", async () => {
    const rows = [{ requestId: "r1" }];
    mocks.latest.mockResolvedValue(rows);
    const response = await request(app()).get(`${path}?limit=5`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual(rows);
    expect(mocks.latest).toHaveBeenCalledExactlyOnceWith(companyId, 5);
    expect(mocks.decide).toHaveBeenCalledWith(expect.objectContaining({
      action: "company_scope:read",
      resource: { type: "company", companyId },
    }));
  });

  it("defaults the limit to 20 and rejects invalid limits before reading rows", async () => {
    expect((await request(app()).get(path)).status).toBe(200);
    expect(mocks.latest).toHaveBeenLastCalledWith(companyId, 20);
    for (const limit of ["0", "-1", "501", "abc", "2.5"]) {
      expect((await request(app()).get(`${path}?limit=${limit}`)).status).toBe(400);
    }
    expect(mocks.latest).toHaveBeenCalledTimes(1);
  });

  it("rejects agents, foreign companies and denied cost-scope readers without reading rows", async () => {
    expect((await request(app("agent")).get(path)).status).toBe(403);
    expect((await request(app()).get("/api/companies/other/usage/logs")).status).toBe(403);
    mocks.decide.mockResolvedValue({ allowed: false });
    expect((await request(app()).get(path)).status).toBe(403);
    expect(mocks.latest).not.toHaveBeenCalled();
  });
});
