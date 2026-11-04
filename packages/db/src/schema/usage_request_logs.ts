import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { issues } from "./issues.js";
import { projects } from "./projects.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

/**
 * One row per provider HTTP call observed by the runner's provider proxy.
 * This is the Usage request log (docs/specs/usage-request-logs.md), not a
 * financial ledger: `cost_events` stays authoritative for money (ADR-0001)
 * and the two tables only join through run/request identifiers.
 *
 * Agent, issue and project are resolved server-side from the run at insert
 * time; the runner never sends them. Token columns stay null when the
 * upstream usage block could not be observed, so unobserved requests are
 * excluded from token sums rather than counted as zero.
 */
export const usageRequestLogs = pgTable(
  "usage_request_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull().references(() => heartbeatRuns.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    app: text("app").notNull(),
    provider: text("provider").notNull(),
    biller: text("biller").notNull().default("unknown"),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens"),
    cachedInputTokens: integer("cached_input_tokens"),
    cacheWriteTokens: integer("cache_write_tokens"),
    outputTokens: integer("output_tokens"),
    costCents: numeric("cost_cents", { precision: 24, scale: 7 }),
    costStatus: text("cost_status").notNull().default("unpriced"),
    durationMs: integer("duration_ms"),
    ttftMs: integer("ttft_ms"),
    httpStatus: integer("http_status"),
    providerRequestId: text("provider_request_id"),
    requestId: text("request_id").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  table => ({
    requestUnique: uniqueIndex("usage_request_logs_request_unique_idx").on(table.companyId, table.runId, table.requestId),
    companyOccurredIdx: index("usage_request_logs_company_occurred_idx").on(table.companyId, table.occurredAt.desc(), table.id),
    companyAppOccurredIdx: index("usage_request_logs_company_app_occurred_idx").on(table.companyId, table.app, table.occurredAt),
    companyProviderModelOccurredIdx: index("usage_request_logs_company_provider_model_occurred_idx").on(table.companyId, table.provider, table.model, table.occurredAt),
    runIdx: index("usage_request_logs_run_idx").on(table.runId),
    nonnegativeTokens: check(
      "usage_request_logs_nonnegative_tokens",
      sql`coalesce(${table.inputTokens}, 0) >= 0 and coalesce(${table.cachedInputTokens}, 0) >= 0 and coalesce(${table.cacheWriteTokens}, 0) >= 0 and coalesce(${table.outputTokens}, 0) >= 0`,
    ),
    nonnegativeCost: check("usage_request_logs_nonnegative_cost", sql`${table.costCents} is null or ${table.costCents} >= 0`),
    costStatusCheck: check("usage_request_logs_cost_status_check", sql`${table.costStatus} in ('unpriced', 'priced', 'excluded')`),
  }),
);
