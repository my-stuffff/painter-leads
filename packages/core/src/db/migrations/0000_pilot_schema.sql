CREATE TABLE "accuracy_samples" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" integer NOT NULL,
	"state" text NOT NULL,
	"sample_id" text NOT NULL,
	"company_id" integer NOT NULL,
	"stratum" text NOT NULL,
	"seed" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accuracy_samples_run_sample_key" UNIQUE("run_id","sample_id"),
	CONSTRAINT "accuracy_samples_stratum_check" CHECK ("stratum" IN ('qualified', 'non_qualified', 'non_painter'))
);
--> statement-breakpoint
CREATE TABLE "companies" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" integer,
	"area_id" text,
	"state" text,
	"display_name" text NOT NULL,
	"primary_listing_id" integer,
	"merge_rung" text,
	"franchise" boolean DEFAULT false NOT NULL,
	"franchise_brand" text,
	"possible_duplicate_of" integer,
	"painter_status" text DEFAULT 'unknown' NOT NULL,
	"painter_reason" text,
	"painter_category" text,
	"residential_status" text,
	"residential_reason" text,
	"in_area" boolean,
	"location_precision" text,
	"site_status" text,
	"registry_status" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"qualified" boolean,
	"exclusion_reasons" text[] DEFAULT '{}'::text[] NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "companies_painter_status_check" CHECK ("painter_status" IN ('painter', 'not_painter', 'unknown')),
	CONSTRAINT "companies_residential_status_check" CHECK ("residential_status" IS NULL OR "residential_status" IN ('residential_only', 'residential_and_commercial', 'commercial_only', 'unclear')),
	CONSTRAINT "companies_location_precision_check" CHECK ("location_precision" IS NULL OR "location_precision" IN ('exact', 'approximate', 'unknown'))
);
--> statement-breakpoint
CREATE TABLE "dns_checks" (
	"domain" text PRIMARY KEY NOT NULL,
	"result" text NOT NULL,
	"detail" jsonb,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dns_checks_result_check" CHECK ("result" IN ('mx', 'a_fallback', 'null_mx', 'no_records', 'error'))
);
--> statement-breakpoint
CREATE TABLE "evidence" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"company_id" integer,
	"listing_id" integer,
	"registry_record_id" integer,
	"field" text NOT NULL,
	"value" text NOT NULL,
	"value_norm" text NOT NULL,
	"source_type" text NOT NULL,
	"source_url" text NOT NULL,
	"page_sha256" text,
	"captured_at" timestamp with time zone NOT NULL,
	"snippet" text NOT NULL,
	"extractor" text NOT NULL,
	"extractor_version" text NOT NULL,
	"confidence" text NOT NULL,
	"status" text DEFAULT 'accepted' NOT NULL,
	"reject_reason" text,
	"corroborated_by" bigint[] DEFAULT '{}'::bigint[] NOT NULL,
	"attrs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evidence_field_check" CHECK ("field" IN ('company_name', 'owner_name', 'phone', 'email', 'website', 'rating', 'review_count', 'category', 'address', 'street', 'city', 'zip', 'state', 'lat', 'lng', 'place_id', 'cid', 'permanently_closed', 'licence_number', 'licence_status', 'licence_classifications', 'licence_expiry', 'nj_hic_number', 'tx_taxpayer_number', 'registry_legal_name', 'residential_signal')),
	CONSTRAINT "evidence_source_type_check" CHECK ("source_type" IN ('google_maps', 'website', 'cslb_master', 'cslb_personnel', 'cslb_lookup', 'nj_hic_roster', 'nj_hic_detail', 'nj_principal_search', 'tx_open_data', 'tx_comptroller', 'bbb')),
	CONSTRAINT "evidence_snippet_length_check" CHECK (char_length("snippet") BETWEEN 1 AND 1000),
	CONSTRAINT "evidence_confidence_check" CHECK ("confidence" IN ('high', 'medium', 'low')),
	CONSTRAINT "evidence_status_check" CHECK ("status" IN ('accepted', 'rejected', 'needs_review')),
	CONSTRAINT "evidence_owner_present_check" CHECK ("company_id" IS NOT NULL OR "listing_id" IS NOT NULL OR "registry_record_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "listings" (
	"id" serial PRIMARY KEY NOT NULL,
	"place_id" text,
	"cid" text,
	"profile_url" text NOT NULL,
	"name" text NOT NULL,
	"categories" text[] DEFAULT '{}'::text[] NOT NULL,
	"category_status" text DEFAULT 'pending' NOT NULL,
	"rating" numeric(2, 1),
	"rating_status" text DEFAULT 'pending' NOT NULL,
	"review_count" integer,
	"review_count_status" text DEFAULT 'pending' NOT NULL,
	"phone_e164" text,
	"phone_status" text DEFAULT 'pending' NOT NULL,
	"website_url" text,
	"website_status" text DEFAULT 'pending' NOT NULL,
	"address_full" text,
	"street" text,
	"city" text,
	"zip" text,
	"state" text,
	"address_status" text DEFAULT 'pending' NOT NULL,
	"lat" double precision,
	"lng" double precision,
	"coords_status" text DEFAULT 'pending' NOT NULL,
	"permanently_closed" boolean,
	"closed_status" text DEFAULT 'pending' NOT NULL,
	"card_raw" jsonb,
	"place_raw" jsonb,
	"detail_status" text DEFAULT 'pending' NOT NULL,
	"detail_attempts" integer DEFAULT 0 NOT NULL,
	"company_id" integer,
	"first_seen_run_id" integer,
	"last_seen_run_id" integer,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_checked_at" timestamp with time zone,
	CONSTRAINT "listings_place_id_unique" UNIQUE("place_id"),
	CONSTRAINT "listings_cid_unique" UNIQUE("cid"),
	CONSTRAINT "listings_id_present_check" CHECK ("place_id" IS NOT NULL OR "cid" IS NOT NULL),
	CONSTRAINT "listings_detail_status_check" CHECK ("detail_status" IN ('pending', 'done', 'limited_view', 'blocked', 'failed', 'not_found')),
	CONSTRAINT "listings_category_status_check" CHECK ("category_status" IN ('captured', 'not_on_card', 'not_shown', 'limited_view', 'blocked', 'parse_failed', 'pending')),
	CONSTRAINT "listings_rating_status_check" CHECK ("rating_status" IN ('captured', 'not_on_card', 'not_shown', 'limited_view', 'blocked', 'parse_failed', 'pending')),
	CONSTRAINT "listings_review_count_status_check" CHECK ("review_count_status" IN ('captured', 'not_on_card', 'not_shown', 'limited_view', 'blocked', 'parse_failed', 'pending')),
	CONSTRAINT "listings_phone_status_check" CHECK ("phone_status" IN ('captured', 'not_on_card', 'not_shown', 'limited_view', 'blocked', 'parse_failed', 'pending')),
	CONSTRAINT "listings_website_status_check" CHECK ("website_status" IN ('captured', 'not_on_card', 'not_shown', 'limited_view', 'blocked', 'parse_failed', 'pending')),
	CONSTRAINT "listings_address_status_check" CHECK ("address_status" IN ('captured', 'not_on_card', 'not_shown', 'limited_view', 'blocked', 'parse_failed', 'pending')),
	CONSTRAINT "listings_coords_status_check" CHECK ("coords_status" IN ('captured', 'not_on_card', 'not_shown', 'limited_view', 'blocked', 'parse_failed', 'pending')),
	CONSTRAINT "listings_closed_status_check" CHECK ("closed_status" IN ('captured', 'not_on_card', 'not_shown', 'limited_view', 'blocked', 'parse_failed', 'pending')),
	CONSTRAINT "listings_rating_null_iff_check" CHECK (("rating" IS NULL) = ("rating_status" <> 'captured')),
	CONSTRAINT "listings_review_count_null_iff_check" CHECK (("review_count" IS NULL) = ("review_count_status" <> 'captured')),
	CONSTRAINT "listings_phone_null_iff_check" CHECK (("phone_e164" IS NULL) = ("phone_status" <> 'captured')),
	CONSTRAINT "listings_website_null_iff_check" CHECK (("website_url" IS NULL) = ("website_status" <> 'captured')),
	CONSTRAINT "listings_address_null_iff_check" CHECK (("address_full" IS NULL) = ("address_status" <> 'captured')),
	CONSTRAINT "listings_lat_null_iff_check" CHECK (("lat" IS NULL) = ("coords_status" <> 'captured')),
	CONSTRAINT "listings_lng_null_iff_check" CHECK (("lng" IS NULL) = ("coords_status" <> 'captured')),
	CONSTRAINT "listings_closed_null_iff_check" CHECK (("permanently_closed" IS NULL) = ("closed_status" <> 'captured')),
	CONSTRAINT "listings_rating_range_check" CHECK ("rating" IS NULL OR ("rating" >= 1.0 AND "rating" <= 5.0)),
	CONSTRAINT "listings_review_count_range_check" CHECK ("review_count" IS NULL OR "review_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "pages" (
	"id" serial PRIMARY KEY NOT NULL,
	"url" text NOT NULL,
	"final_url" text,
	"host" text NOT NULL,
	"method" text DEFAULT 'GET' NOT NULL,
	"sha256" text NOT NULL,
	"status_code" integer,
	"content_type" text,
	"bytes" integer,
	"rendered" boolean DEFAULT false NOT NULL,
	"source" text,
	"cache_path" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pages_sha256_unique" UNIQUE("sha256")
);
--> statement-breakpoint
CREATE TABLE "registry_matches" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"registry_record_id" integer NOT NULL,
	"rung" text NOT NULL,
	"strength" text NOT NULL,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "registry_matches_company_record_key" UNIQUE("company_id","registry_record_id"),
	CONSTRAINT "registry_matches_strength_check" CHECK ("strength" IN ('strong', 'candidate'))
);
--> statement-breakpoint
CREATE TABLE "registry_people" (
	"id" serial PRIMARY KEY NOT NULL,
	"registry_record_id" integer NOT NULL,
	"source_type" text NOT NULL,
	"name_raw" text,
	"full_name" text,
	"first_name" text,
	"last_name" text,
	"title" text,
	"role_rank" integer,
	"associated_on" date,
	"dissociated_on" date,
	"source_url" text,
	"captured_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "registry_records" (
	"id" serial PRIMARY KEY NOT NULL,
	"source_type" text NOT NULL,
	"source_key" text NOT NULL,
	"state" text,
	"legal_name" text,
	"dba_name" text,
	"name_norm" text,
	"name_core" text,
	"aliases" text[] DEFAULT '{}'::text[] NOT NULL,
	"address" text,
	"city" text,
	"zip" text,
	"phone_e164" text,
	"phone_last10" text,
	"email" text,
	"status" text,
	"classifications" text,
	"business_type" text,
	"issued_on" date,
	"expires_on" date,
	"raw" jsonb,
	"source_url" text,
	"captured_at" timestamp with time zone,
	CONSTRAINT "registry_records_source_key" UNIQUE("source_type","source_key"),
	CONSTRAINT "registry_records_source_type_check" CHECK ("source_type" IN ('google_maps', 'website', 'cslb_master', 'cslb_personnel', 'cslb_lookup', 'nj_hic_roster', 'nj_hic_detail', 'nj_principal_search', 'tx_open_data', 'tx_comptroller', 'bbb'))
);
--> statement-breakpoint
CREATE TABLE "request_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" text NOT NULL,
	"host" text NOT NULL,
	"method" text NOT NULL,
	"url" text NOT NULL,
	"status" integer,
	"bytes" integer,
	"ms" integer,
	"outcome" text NOT NULL,
	"run_id" integer,
	"note" text,
	CONSTRAINT "request_log_outcome_check" CHECK ("outcome" IN ('ok', 'http_error', 'robots_disallowed', 'timeout', 'dns_error', 'ssrf_refused', 'cache_hit', 'blocked', 'captcha', 'sorry', 'limited_view', 'too_large', 'offline_miss'))
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"area_id" text NOT NULL,
	"state" text NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"stopped_reason" text,
	"config_snapshot" jsonb NOT NULL,
	"notes" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runs_status_check" CHECK ("status" IN ('planned', 'running', 'stopped', 'blocked', 'done', 'failed')),
	CONSTRAINT "runs_state_check" CHECK ("state" IN ('NJ', 'TX', 'CA'))
);
--> statement-breakpoint
CREATE TABLE "search_hits" (
	"id" serial PRIMARY KEY NOT NULL,
	"search_id" integer NOT NULL,
	"listing_id" integer NOT NULL,
	"position" integer NOT NULL,
	"is_new" boolean DEFAULT false NOT NULL,
	CONSTRAINT "search_hits_search_listing_key" UNIQUE("search_id","listing_id")
);
--> statement-breakpoint
CREATE TABLE "searches" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" integer NOT NULL,
	"area_id" text NOT NULL,
	"zip" text NOT NULL,
	"term" text NOT NULL,
	"phase" text DEFAULT 'pilot' NOT NULL,
	"position" integer NOT NULL,
	"query" text NOT NULL,
	"url" text,
	"landed_url" text,
	"center_lat" double precision,
	"center_lng" double precision,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"cards_found" integer,
	"new_place_ids" integer,
	"end_reached" boolean,
	"block_signal" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "searches_run_zip_term_key" UNIQUE("run_id","zip","term"),
	CONSTRAINT "searches_status_check" CHECK ("status" IN ('pending', 'running', 'done', 'blocked', 'failed')),
	CONSTRAINT "searches_phase_check" CHECK ("phase" IN ('pilot', 'expansion'))
);
--> statement-breakpoint
ALTER TABLE "accuracy_samples" ADD CONSTRAINT "accuracy_samples_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accuracy_samples" ADD CONSTRAINT "accuracy_samples_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_registry_record_id_registry_records_id_fk" FOREIGN KEY ("registry_record_id") REFERENCES "public"."registry_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registry_matches" ADD CONSTRAINT "registry_matches_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registry_matches" ADD CONSTRAINT "registry_matches_registry_record_id_registry_records_id_fk" FOREIGN KEY ("registry_record_id") REFERENCES "public"."registry_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registry_people" ADD CONSTRAINT "registry_people_registry_record_id_registry_records_id_fk" FOREIGN KEY ("registry_record_id") REFERENCES "public"."registry_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_hits" ADD CONSTRAINT "search_hits_search_id_searches_id_fk" FOREIGN KEY ("search_id") REFERENCES "public"."searches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_hits" ADD CONSTRAINT "search_hits_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "searches" ADD CONSTRAINT "searches_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "companies_run_idx" ON "companies" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "evidence_company_field_idx" ON "evidence" USING btree ("company_id","field");--> statement-breakpoint
CREATE INDEX "evidence_listing_field_idx" ON "evidence" USING btree ("listing_id","field");--> statement-breakpoint
CREATE INDEX "evidence_field_value_norm_idx" ON "evidence" USING btree ("field","value_norm");--> statement-breakpoint
CREATE INDEX "listings_company_idx" ON "listings" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "listings_zip_idx" ON "listings" USING btree ("zip");--> statement-breakpoint
CREATE INDEX "registry_records_state_zip_idx" ON "registry_records" USING btree ("state","zip");--> statement-breakpoint
CREATE INDEX "registry_records_name_core_idx" ON "registry_records" USING btree ("name_core");--> statement-breakpoint
CREATE INDEX "registry_records_phone_last10_idx" ON "registry_records" USING btree ("phone_last10");--> statement-breakpoint
CREATE INDEX "request_log_source_at_idx" ON "request_log" USING btree ("source","at");--> statement-breakpoint
CREATE INDEX "searches_run_status_idx" ON "searches" USING btree ("run_id","status");