CREATE TABLE "job_areas" (
	"id" serial PRIMARY KEY NOT NULL,
	"job_id" integer NOT NULL,
	"area_id" text NOT NULL,
	"state" text NOT NULL,
	"label" text NOT NULL,
	"position" integer NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"run_id" integer,
	"attempts" integer DEFAULT 0 NOT NULL,
	"worker_id" text,
	"heartbeat_at" timestamp with time zone,
	"not_before" timestamp with time zone,
	"message" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "job_areas_job_area_key" UNIQUE("job_id","area_id"),
	CONSTRAINT "job_areas_status_check" CHECK ("status" IN ('queued', 'running', 'waiting', 'done', 'reused', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "job_exports" (
	"job_id" integer PRIMARY KEY NOT NULL,
	"built_at" timestamp with time zone DEFAULT now() NOT NULL,
	"xlsx" "bytea" NOT NULL,
	"csv" "bytea" NOT NULL,
	"rows" jsonb NOT NULL,
	"summary" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_by" integer,
	"status" text DEFAULT 'queued' NOT NULL,
	"states" text[] NOT NULL,
	"settings" jsonb NOT NULL,
	"error" text,
	"export_status" text DEFAULT 'none' NOT NULL,
	"export_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "jobs_status_check" CHECK ("status" IN ('queued', 'running', 'done', 'failed', 'cancelled')),
	CONSTRAINT "jobs_export_status_check" CHECK ("export_status" IN ('none', 'building', 'ready', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" text NOT NULL,
	"disabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_role_check" CHECK ("role" IN ('admin', 'operator', 'viewer'))
);
--> statement-breakpoint
CREATE TABLE "workers" (
	"id" text PRIMARY KEY NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"job_area_id" integer,
	"note" text
);
--> statement-breakpoint
ALTER TABLE "job_areas" ADD CONSTRAINT "job_areas_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_areas" ADD CONSTRAINT "job_areas_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_exports" ADD CONSTRAINT "job_exports_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_areas_status_idx" ON "job_areas" USING btree ("status");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");