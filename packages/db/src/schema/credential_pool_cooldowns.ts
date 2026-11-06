import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import type { CredentialPoolSlotState } from "@paperclipai/shared";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { toolConnections } from "./tool_access.js";

/**
 * Cooldown state machine at (key slot × model) granularity (plan §10): NIM
 * quota is counted per key × model, so a 429 on one model must not freeze the
 * other models of the same key. One row per (slot, model); the slot-level
 * state/cooldown columns on credential_pool are retained but no longer read or
 * written by production code (kept only to avoid a destructive migration).
 *
 * `state` follows the ticket-03 state machine: `daily_cooldown` stays cooling
 * until the probe worker proves recovery (200) or defers (+2h per failed
 * probe); `rpm_cooldown` becomes assignable again the moment its deadline
 * passes (assignment eligibility reads the deadline, no probe needed).
 * `lastRunId` records the run whose 429 last classified this pair, so the
 * probe's honest usage record (it consumes real quota) can attach to a real
 * run row instead of widening usage_request_logs' run contract.
 */
export const credentialPoolCooldowns = pgTable(
  "credential_pool_cooldowns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id").notNull().references(() => toolConnections.id, { onDelete: "cascade" }),
    slot: integer("slot").notNull(),
    model: text("model").notNull(),
    state: text("state").$type<CredentialPoolSlotState>().notNull().default("healthy"),
    cooldownUntil: timestamp("cooldown_until", { withTimezone: true }),
    cooldownReason: text("cooldown_reason"),
    lastRunId: uuid("last_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    lastProbeAt: timestamp("last_probe_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("credential_pool_cooldowns_slot_model_uq").on(table.companyId, table.connectionId, table.slot, table.model),
    index("credential_pool_cooldowns_company_connection_idx").on(table.companyId, table.connectionId),
    // Probe worker deadline scan: due daily cooldowns, most urgent first.
    index("credential_pool_cooldowns_probe_due_idx")
      .on(table.cooldownUntil)
      .where(sql`${table.state} = 'daily_cooldown'`),
    check("credential_pool_cooldowns_slot_positive_check", sql`${table.slot} > 0`),
    check(
      "credential_pool_cooldowns_state_check",
      sql`${table.state} in ('healthy', 'rpm_cooldown', 'daily_cooldown')`,
    ),
  ],
);
