-- Lead lookup against each client's Mentor / Sub-mentor Google Sheets.
ALTER TABLE "leads" ADD COLUMN "lookup_type" TEXT;
ALTER TABLE "leads" ADD COLUMN "mentor_name" TEXT;
ALTER TABLE "leads" ADD COLUMN "sub_mentor_name" TEXT;
ALTER TABLE "leads" ADD COLUMN "lookup_matched_by" TEXT;
ALTER TABLE "leads" ADD COLUMN "lookup_at" TIMESTAMP(3);

CREATE TABLE "lookup_configs" (
    "client_id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "mentor_sheet_url" TEXT,
    "sub_mentor_sheet_url" TEXT,
    "refresh_minutes" INTEGER NOT NULL DEFAULT 2,
    "api_token" TEXT NOT NULL,
    "webhook_id" TEXT,
    "mentor_rows" JSONB,
    "sub_mentor_rows" JSONB,
    "mentor_read_at" TIMESTAMP(3),
    "sub_mentor_read_at" TIMESTAMP(3),
    "mentor_error" TEXT,
    "sub_mentor_error" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "lookup_configs_pkey" PRIMARY KEY ("client_id")
);
CREATE UNIQUE INDEX "lookup_configs_api_token_key" ON "lookup_configs"("api_token");
ALTER TABLE "lookup_configs" ADD CONSTRAINT "lookup_configs_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "lead_lookups" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "lead_id" TEXT,
    "name" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "lead_type" TEXT NOT NULL,
    "mentor_name" TEXT,
    "sub_mentor_name" TEXT,
    "matched_by" TEXT,
    "source" TEXT NOT NULL,
    "webhook_status" TEXT NOT NULL,
    "webhook_error" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "lead_lookups_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "lead_lookups_client_id_created_at_idx" ON "lead_lookups"("client_id", "created_at");
ALTER TABLE "lead_lookups" ADD CONSTRAINT "lead_lookups_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;
