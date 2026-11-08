CREATE TABLE "credential_pool_cooldowns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"slot" integer NOT NULL,
	"model" text NOT NULL,
	"state" text DEFAULT 'healthy' NOT NULL,
	"cooldown_until" timestamp with time zone,
	"cooldown_reason" text,
	"last_run_id" uuid,
	"last_probe_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credential_pool_cooldowns_slot_model_uq" UNIQUE("company_id","connection_id","slot","model"),
	CONSTRAINT "credential_pool_cooldowns_slot_positive_check" CHECK ("credential_pool_cooldowns"."slot" > 0),
	CONSTRAINT "credential_pool_cooldowns_state_check" CHECK ("credential_pool_cooldowns"."state" in ('healthy', 'rpm_cooldown', 'daily_cooldown'))
);
--> statement-breakpoint
ALTER TABLE "credential_pool_cooldowns" ADD CONSTRAINT "credential_pool_cooldowns_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_pool_cooldowns" ADD CONSTRAINT "credential_pool_cooldowns_connection_id_tool_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."tool_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_pool_cooldowns" ADD CONSTRAINT "credential_pool_cooldowns_last_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("last_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credential_pool_cooldowns_company_connection_idx" ON "credential_pool_cooldowns" USING btree ("company_id","connection_id");--> statement-breakpoint
CREATE INDEX "credential_pool_cooldowns_probe_due_idx" ON "credential_pool_cooldowns" USING btree ("cooldown_until") WHERE "credential_pool_cooldowns"."state" = 'daily_cooldown';