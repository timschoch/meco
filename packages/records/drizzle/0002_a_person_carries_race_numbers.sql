CREATE TABLE "person_numbers" (
	"person_id" text NOT NULL,
	"brand" text NOT NULL,
	"number" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "person_numbers_brand_number_pk" PRIMARY KEY("brand","number")
);
--> statement-breakpoint
ALTER TABLE "person_numbers" ADD CONSTRAINT "person_numbers_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_numbers" ADD CONSTRAINT "person_numbers_brand_brands_id_fk" FOREIGN KEY ("brand") REFERENCES "public"."brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "person_numbers_person_id_index" ON "person_numbers" USING btree ("person_id");