-- Scale: per-client indexes and a trigram-indexed search column (see src/lib/ingest/searchText.ts).
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- DropIndex
DROP INDEX "leads_email_normalised_idx";

-- DropIndex
DROP INDEX "leads_phone_normalised_idx";

-- AlterTable
ALTER TABLE "leads" ADD COLUMN     "search_text" TEXT;

-- CreateIndex
CREATE INDEX "leads_created_at_idx" ON "leads"("created_at");

-- CreateIndex
CREATE INDEX "leads_client_id_phone_normalised_idx" ON "leads"("client_id", "phone_normalised");

-- CreateIndex
CREATE INDEX "leads_client_id_email_normalised_idx" ON "leads"("client_id", "email_normalised");

-- CreateIndex
CREATE INDEX "leads_client_id_status_id_idx" ON "leads"("client_id", "status_id");

-- CreateIndex
CREATE INDEX "leads_client_id_owner_id_idx" ON "leads"("client_id", "owner_id");

-- CreateIndex
CREATE INDEX "leads_duplicate_of_id_idx" ON "leads"("duplicate_of_id");

-- Backfill: same content the app writes on ingest (lowercased name, email, phone digits, answer values).
UPDATE "leads" l SET "search_text" = left(lower(concat_ws(' ',
  l."name", l."email_normalised", ltrim(l."phone_normalised", '+'),
  (SELECT string_agg(CASE WHEN jsonb_typeof(a.value) = 'array'
            THEN (SELECT string_agg(x, ' ') FROM jsonb_array_elements_text(a.value) x)
            ELSE a.value #>> '{}' END, ' ')
     FROM jsonb_each(l."answers") a)
)), 4000);

-- CreateIndex
CREATE INDEX "leads_search_text_trgm_idx" ON "leads" USING GIN ("search_text" gin_trgm_ops);

