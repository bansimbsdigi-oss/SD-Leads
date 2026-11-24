-- Lead lookup: history of webhooks received and results sent (or failed), kept 30 days.
-- CreateTable
CREATE TABLE "lookup_webhook_logs" (
    "id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "test" BOOLEAN NOT NULL DEFAULT false,
    "lookup_id" TEXT,
    "http_status" INTEGER,
    "body" JSONB,
    "response" TEXT,
    "error" TEXT,
    "attempt" INTEGER,
    "duration_ms" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lookup_webhook_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "lookup_webhook_logs_created_at_idx" ON "lookup_webhook_logs"("created_at");

-- CreateIndex
CREATE INDEX "lookup_webhook_logs_status_created_at_idx" ON "lookup_webhook_logs"("status", "created_at");

