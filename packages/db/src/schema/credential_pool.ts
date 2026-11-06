import { sql } from "drizzle-orm";
import {
  boolean,
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
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { companySecrets } from "./company_secrets.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { toolConnections } from "./tool_access.js";

/**
 * A key pool attaches several rotating per-account keys (slots) to one AI
 * connection. Runtime credential resolution prefers an assignable pool slot
 * over the connection's single grant credential; assignment, leases and
 * cooldowns evolve in later tickets. The referenced secret holds the encrypted
 * key value, so this table itself never stores key material.
 */
export const credentialPool = pgTable(
  "credential_pool",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id").notNull().references(() => toolConnections.id, { onDelete: "cascade" }),
    slot: integer("slot").notNull(),
    label: text("label"),
    secretRef: uuid("secret_ref").notNull().references(() => companySecrets.id),
    state: text("state").$type<CredentialPoolSlotState>().notNull().default("healthy"),
    // Operator pause switch, orthogonal to the cooldown state machine: a
    // disabled slot is skipped by assignment but keeps its row and history.
    enabled: boolean("enabled").notNull().default(true),
    cooldownUntil: timestamp("cooldown_until", { withTimezone: true }),
    cooldownReason: text("cooldown_reason"),
    activeRunId: uuid("active_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    leaseAgentId: uuid("lease_agent_id").references(() => agents.id, { onDelete: "set null" }),
    lastAssignedAgentId: uuid("last_assigned_agent_id").references(() => agents.id, { onDelete: "set null" }),
    // Sticky-anchor recency: assignment prefers the slot least recently handed
    // out, so an idle pool rotates instead of hammering slot 1.
    lastAssignedAt: timestamp("last_assigned_at", { withTimezone: true }),
    lastFailedSlotProbeAt: timestamp("last_failed_slot_probe_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("credential_pool_company_connection_slot_uq").on(table.companyId, table.connectionId, table.slot),
    index("credential_pool_company_connection_idx").on(table.companyId, table.connectionId),
    check("credential_pool_slot_positive_check", sql`${table.slot} > 0`),
    check(
      "credential_pool_state_check",
      sql`${table.state} in ('healthy', 'rpm_cooldown', 'daily_cooldown')`,
    ),
  ],
);
