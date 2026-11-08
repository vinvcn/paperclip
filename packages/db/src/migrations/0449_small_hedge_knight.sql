CREATE TABLE "credential_pool" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"slot" integer NOT NULL,
	"label" text,
	"secret_ref" uuid NOT NULL,
	"state" text DEFAULT 'healthy' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"cooldown_until" timestamp with time zone,
	"cooldown_reason" text,
	"active_run_id" uuid,
	"lease_expires_at" timestamp with time zone,
	"lease_agent_id" uuid,
	"last_assigned_agent_id" uuid,
	"last_failed_slot_probe_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credential_pool_company_connection_slot_uq" UNIQUE("company_id","connection_id","slot"),
	CONSTRAINT "credential_pool_slot_positive_check" CHECK ("credential_pool"."slot" > 0),
	CONSTRAINT "credential_pool_state_check" CHECK ("credential_pool"."state" in ('healthy', 'rpm_cooldown', 'daily_cooldown'))
);
--> statement-breakpoint
ALTER TABLE "credential_pool" ADD CONSTRAINT "credential_pool_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_pool" ADD CONSTRAINT "credential_pool_connection_id_tool_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."tool_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_pool" ADD CONSTRAINT "credential_pool_secret_ref_company_secrets_id_fk" FOREIGN KEY ("secret_ref") REFERENCES "public"."company_secrets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_pool" ADD CONSTRAINT "credential_pool_active_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("active_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_pool" ADD CONSTRAINT "credential_pool_lease_agent_id_agents_id_fk" FOREIGN KEY ("lease_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_pool" ADD CONSTRAINT "credential_pool_last_assigned_agent_id_agents_id_fk" FOREIGN KEY ("last_assigned_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credential_pool_company_connection_idx" ON "credential_pool" USING btree ("company_id","connection_id");