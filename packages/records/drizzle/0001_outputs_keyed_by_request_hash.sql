-- Destructive, and sanctioned on #223: nothing is using meco. The new primary
-- key would refuse a table that already holds two rows of one Brand under one
-- Request Hash, and a migration that can fail at boot is a boot that can fail.
DELETE FROM "outputs";--> statement-breakpoint
DROP INDEX "outputs_brand_request_hash_index";--> statement-breakpoint
DROP INDEX "outputs_created_at_store_key_index";--> statement-breakpoint
ALTER TABLE "outputs" DROP CONSTRAINT "outputs_brand_store_key_pk";--> statement-breakpoint
ALTER TABLE "outputs" ADD CONSTRAINT "outputs_brand_request_hash_pk" PRIMARY KEY("brand","request_hash");--> statement-breakpoint
CREATE INDEX "outputs_brand_store_key_index" ON "outputs" USING btree ("brand","store_key");--> statement-breakpoint
CREATE INDEX "outputs_created_at_store_key_request_hash_index" ON "outputs" USING btree ("created_at","store_key","request_hash");