import { Router, type Request, type Response } from "express";
import type { Db } from "@paperclipai/db";
import { USAGE_STATUS_FILTERS, type UsageStatusFilter } from "@paperclipai/shared";
import { accessService } from "../services/index.js";
import { usageRequestLogService, type UsageRequestFilters } from "../services/usage-request-logs.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { parseCostDateRange } from "./costs.js";
import { badRequest } from "../errors.js";

export function parseUsageLimit(query: Record<string, unknown>) {
  const raw = query.limit;
  if (raw == null || raw === "") return 20;
  const limit = typeof raw === "number" || typeof raw === "string" ? Number(raw) : Number.NaN;
  if (!Number.isInteger(limit) || limit <= 0 || limit > 500) {
    throw badRequest("invalid 'limit' value");
  }
  return limit;
}

/**
 * The summary's series is bucketed in the viewer's timezone (an IANA name the
 * browser reports via `Intl.DateTimeFormat().resolvedOptions().timeZone`).
 * The value is validated with Intl and replaced by its canonical IANA name
 * before it reaches the bucketing SQL — Intl accepts case-variant input that
 * PostgreSQL would reject, and canonicalization keeps what we pass to
 * `date_trunc(... AT TIME ZONE ...)` a zone PostgreSQL knows. The name itself
 * is always a bound parameter, never part of the SQL text. Defaults to UTC
 * when absent; anything unparseable is a 400, never a silent fallback.
 */
export function parseUsageTimezone(query: Record<string, unknown>): string {
  const raw = query.tz;
  if (raw == null || raw === "") return "UTC";
  if (typeof raw !== "string") throw badRequest("invalid 'tz' value");
  try {
    return new Intl.DateTimeFormat("en", { timeZone: raw }).resolvedOptions().timeZone;
  } catch {
    throw badRequest("invalid 'tz' value");
  }
}

/**
 * The usage filter dimensions shared by the summary and logs reads
 * (docs/specs/usage-request-logs.md, API). An absent or empty value means
 * "no filter" — the same rule as `limit` and `tz` — while anything else that
 * is not a single string (a repeated parameter arrives as an array) or not a
 * known status class is a 400, never a silently ignored filter.
 */
export function parseUsageFilters(query: Record<string, unknown>): UsageRequestFilters {
  const filters: UsageRequestFilters = {};
  for (const key of ["app", "provider", "model"] as const) {
    const raw = query[key];
    if (raw == null || raw === "") continue;
    if (typeof raw !== "string") throw badRequest(`invalid '${key}' value`);
    filters[key] = raw;
  }
  const rawStatus = query.status;
  if (rawStatus != null && rawStatus !== "") {
    if (typeof rawStatus !== "string" || !USAGE_STATUS_FILTERS.includes(rawStatus as UsageStatusFilter)) {
      throw badRequest("invalid 'status' value");
    }
    filters.status = rawStatus as UsageStatusFilter;
  }
  return filters;
}

/**
 * Usage request log reads (docs/specs/usage-request-logs.md). P1 exposes the
 * filtered newest rows plus the aggregated summary with facets; keyset
 * pagination follows with the persistence ticket. Authorization mirrors the
 * costs read endpoints: board actors with the company cost-scope read
 * decision.
 */
export function usageRoutes(db: Db) {
  const router = Router();
  const logs = usageRequestLogService(db);
  const access = accessService(db);

  /** Shared guard for every usage read: board actor, company access, cost-scope read decision. */
  async function requireUsageRead(req: Request, res: Response, companyId: string): Promise<boolean> {
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const decision = await access.decide({
      actor: req.actor,
      action: "company_scope:read",
      resource: { type: "company", companyId },
    });
    if (!decision.allowed) {
      res.status(403).json({ error: "Usage is outside this actor's authorization boundary" });
      return false;
    }
    return true;
  }

  router.get("/companies/:companyId/usage/logs", async (req, res) => {
    const companyId = req.params.companyId as string;
    if (!(await requireUsageRead(req, res, companyId))) return;
    const limit = parseUsageLimit(req.query);
    const range = parseCostDateRange(req.query);
    const filters = parseUsageFilters(req.query);
    res.json(await logs.latest(companyId, limit, { ...filters, range }));
  });

  router.get("/companies/:companyId/usage/summary", async (req, res) => {
    const companyId = req.params.companyId as string;
    if (!(await requireUsageRead(req, res, companyId))) return;
    const range = parseCostDateRange(req.query);
    const timeZone = parseUsageTimezone(req.query);
    const filters = parseUsageFilters(req.query);
    res.json(await logs.summary(companyId, range, timeZone, filters));
  });

  return router;
}
