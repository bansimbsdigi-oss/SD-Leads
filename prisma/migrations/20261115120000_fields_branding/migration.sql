-- Field manager merges and client logos.
ALTER TABLE "form_fields" ADD COLUMN "merge_into" TEXT;
ALTER TABLE "clients" ADD COLUMN "logo" BYTEA;
ALTER TABLE "clients" ADD COLUMN "logo_type" TEXT;
ALTER TABLE "clients" ADD COLUMN "logo_updated_at" TIMESTAMP(3);
