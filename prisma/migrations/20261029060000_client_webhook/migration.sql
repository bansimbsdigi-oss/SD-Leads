-- One webhook URL per client. Existing clients get a random token.
ALTER TABLE "clients" ADD COLUMN "webhook_token" TEXT;
UPDATE "clients" SET "webhook_token" = replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
ALTER TABLE "clients" ALTER COLUMN "webhook_token" SET NOT NULL;
CREATE UNIQUE INDEX "clients_webhook_token_key" ON "clients"("webhook_token");

-- LPs found automatically by the client webhook (by page URL or form name).
ALTER TABLE "landing_pages" ADD COLUMN "source_key" TEXT,
ADD COLUMN "source_url" TEXT,
ADD COLUMN "auto_created" BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX "landing_pages_client_id_source_key_key" ON "landing_pages"("client_id", "source_key");
