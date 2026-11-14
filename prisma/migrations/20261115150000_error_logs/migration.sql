-- Built-in error tracking.
CREATE TABLE "error_logs" (
    "id" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "stack" TEXT,
    "path" TEXT,
    "context" JSONB NOT NULL DEFAULT '{}',
    "count" INTEGER NOT NULL DEFAULT 1,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),
    CONSTRAINT "error_logs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "error_logs_fingerprint_key" ON "error_logs"("fingerprint");
CREATE INDEX "error_logs_last_seen_at_idx" ON "error_logs"("last_seen_at");
