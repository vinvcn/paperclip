CREATE TABLE "usage_request_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"agent_id" uuid,
	"issue_id" uuid,
	"project_id" uuid,
	"app" text NOT NULL,
	"provider" text NOT NULL,
	"biller" text DEFAULT 'unknown' NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer,
	"cached_input_tokens" integer,
	"cache_write_tokens" integer,
	"output_tokens" integer,
	"cost_cents" numeric(24, 7),
	"cost_status" text DEFAULT 'unpriced' NOT NULL,
	"duration_ms" integer,
	"ttft_ms" integer,
	"http_status" integer,
	"provider_request_id" text,
	"request_id" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_request_logs_nonnegative_tokens" CHECK (coalesce("usage_request_logs"."input_tokens", 0) >= 0 and coalesce("usage_request_logs"."cached_input_tokens", 0) >= 0 and coalesce("usage_request_logs"."cache_write_tokens", 0) >= 0 and coalesce("usage_request_logs"."output_tokens", 0) >= 0),
	CONSTRAINT "usage_request_logs_nonnegative_cost" CHECK ("usage_request_logs"."cost_cents" is null or "usage_request_logs"."cost_cents" >= 0),
	CONSTRAINT "usage_request_logs_cost_status_check" CHECK ("usage_request_logs"."cost_status" in ('unpriced', 'priced', 'excluded'))
);
--> statement-breakpoint
ALTER TABLE "usage_request_logs" ADD CONSTRAINT "usage_request_logs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_request_logs" ADD CONSTRAINT "usage_request_logs_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_request_logs" ADD CONSTRAINT "usage_request_logs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_request_logs" ADD CONSTRAINT "usage_request_logs_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_request_logs" ADD CONSTRAINT "usage_request_logs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "usage_request_logs_request_unique_idx" ON "usage_request_logs" USING btree ("company_id","run_id","request_id");--> statement-breakpoint
CREATE INDEX "usage_request_logs_company_occurred_idx" ON "usage_request_logs" USING btree ("company_id","occurred_at" DESC NULLS LAST,"id");--> statement-breakpoint
CREATE INDEX "usage_request_logs_company_app_occurred_idx" ON "usage_request_logs" USING btree ("company_id","app","occurred_at");--> statement-breakpoint
CREATE INDEX "usage_request_logs_company_provider_model_occurred_idx" ON "usage_request_logs" USING btree ("company_id","provider","model","occurred_at");--> statement-breakpoint
CREATE INDEX "usage_request_logs_run_idx" ON "usage_request_logs" USING btree ("run_id");