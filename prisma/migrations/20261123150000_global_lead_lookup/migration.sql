-- Lead lookup becomes one global setup (inbound webhook, two sheets, outbound webhook) instead of per client.
-- The per-client settings table was never used, so it is recreated.
DROP TABLE "lookup_configs";

CREATE TABLE "lookup_configs" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "mentor_sheet_url" TEXT,
    "sub_mentor_sheet_url" TEXT,
    "refresh_minutes" INTEGER NOT NULL DEFAULT 2,
    "api_token" TEXT NOT NULL,
    "outbound_config" TEXT,
    "mentor_rows" JSONB,
    "sub_mentor_rows" JSONB,
    "mentor_read_at" TIMESTAMP(3),
    "sub_mentor_read_at" TIMESTAMP(3),
    "mentor_error" TEXT,
    "sub_mentor_error" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "lookup_configs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "lookup_configs_api_token_key" ON "lookup_configs"("api_token");

ALTER TABLE "lead_lookups" ALTER COLUMN "client_id" DROP NOT NULL;
DROP INDEX "lead_lookups_client_id_created_at_idx";
CREATE INDEX "lead_lookups_created_at_idx" ON "lead_lookups"("created_at");
