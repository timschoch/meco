CREATE TABLE "annotations" (
	"hash" text PRIMARY KEY NOT NULL,
	"schema" integer NOT NULL,
	"produced_by" jsonb NOT NULL,
	"annotation" jsonb NOT NULL,
	"annotated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "brands" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "callers" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"brands" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "callers_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "calls" (
	"id" text PRIMARY KEY NOT NULL,
	"caller_id" text NOT NULL,
	"brand" text NOT NULL,
	"kind" text NOT NULL,
	"source_hash" text,
	"request" jsonb,
	"framing" jsonb,
	"matches" jsonb,
	"redactions" jsonb,
	"steps" jsonb,
	"cost" jsonb,
	"error" jsonb,
	"status" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"duration_ms" integer
);
--> statement-breakpoint
CREATE TABLE "files" (
	"hash" text PRIMARY KEY NOT NULL,
	"mime" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"bytes" integer NOT NULL,
	"store_key" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outputs" (
	"brand" text NOT NULL,
	"store_key" text NOT NULL,
	"call_id" text NOT NULL,
	"kind" text NOT NULL,
	"placement" text,
	"request_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outputs_brand_store_key_pk" PRIMARY KEY("brand","store_key")
);
--> statement-breakpoint
CREATE TABLE "people" (
	"id" text PRIMARY KEY NOT NULL,
	"brand" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reference_photos" (
	"id" text PRIMARY KEY NOT NULL,
	"person_id" text NOT NULL,
	"brand" text NOT NULL,
	"hash" text NOT NULL,
	"store_key" text NOT NULL,
	"region_id" text NOT NULL,
	"face_print" jsonb NOT NULL,
	"consent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"brand" text NOT NULL,
	"hash" text NOT NULL,
	"first_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sources_brand_hash_pk" PRIMARY KEY("brand","hash")
);
--> statement-breakpoint
ALTER TABLE "annotations" ADD CONSTRAINT "annotations_hash_files_hash_fk" FOREIGN KEY ("hash") REFERENCES "public"."files"("hash") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_caller_id_callers_id_fk" FOREIGN KEY ("caller_id") REFERENCES "public"."callers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_brand_brands_id_fk" FOREIGN KEY ("brand") REFERENCES "public"."brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outputs" ADD CONSTRAINT "outputs_brand_brands_id_fk" FOREIGN KEY ("brand") REFERENCES "public"."brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outputs" ADD CONSTRAINT "outputs_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_brand_brands_id_fk" FOREIGN KEY ("brand") REFERENCES "public"."brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reference_photos" ADD CONSTRAINT "reference_photos_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reference_photos" ADD CONSTRAINT "reference_photos_brand_brands_id_fk" FOREIGN KEY ("brand") REFERENCES "public"."brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reference_photos" ADD CONSTRAINT "reference_photos_hash_files_hash_fk" FOREIGN KEY ("hash") REFERENCES "public"."files"("hash") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_brand_brands_id_fk" FOREIGN KEY ("brand") REFERENCES "public"."brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_hash_files_hash_fk" FOREIGN KEY ("hash") REFERENCES "public"."files"("hash") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "calls_brand_started_at_index" ON "calls" USING btree ("brand","started_at");--> statement-breakpoint
CREATE INDEX "calls_source_hash_index" ON "calls" USING btree ("source_hash");--> statement-breakpoint
CREATE INDEX "outputs_brand_request_hash_index" ON "outputs" USING btree ("brand","request_hash");--> statement-breakpoint
CREATE INDEX "outputs_store_key_index" ON "outputs" USING btree ("store_key");--> statement-breakpoint
CREATE INDEX "outputs_created_at_store_key_index" ON "outputs" USING btree ("created_at","store_key");--> statement-breakpoint
CREATE INDEX "people_brand_index" ON "people" USING btree ("brand");--> statement-breakpoint
CREATE INDEX "reference_photos_person_id_index" ON "reference_photos" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "reference_photos_hash_index" ON "reference_photos" USING btree ("hash");--> statement-breakpoint
CREATE INDEX "sources_hash_index" ON "sources" USING btree ("hash");