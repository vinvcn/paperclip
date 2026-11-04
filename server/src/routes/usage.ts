import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { accessService } from "../services/index.js";
import { usageRequestLogService } from "../services/usage-request-logs.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
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
 * Usage request log reads (docs/specs/usage-request-logs.md). P1 exposes the
 * newest rows only; filters and keyset pagination follow with the UI ticket.
 * Authorization mirrors the costs read endpoints: board actors with the
 * company cost-scope read decision.
 */
export function usageRoutes(db: Db) {
  const router = Router();
  const logs = usageRequestLogService(db);
  const access = accessService(db);

  router.get("/companies/:companyId/usage/logs", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const decision = await access.decide({
      actor: req.actor,
      action: "company_scope:read",
      resource: { type: "company", companyId },
    });
    if (!decision.allowed) {
      res.status(403).json({ error: "Usage is outside this actor's authorization boundary" });
      return;
    }
    const limit = parseUsageLimit(req.query);
    res.json(await logs.latest(companyId, limit));
  });

  return router;
}
