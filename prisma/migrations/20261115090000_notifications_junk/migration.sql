-- Notification bell, quiet landing page alerts and junk lead flags.
ALTER TABLE "users" ADD COLUMN "leads_seen_at" TIMESTAMP(3);
ALTER TABLE "landing_pages" ADD COLUMN "quiet_alerted_at" TIMESTAMP(3);
ALTER TABLE "leads" ADD COLUMN "junk_reasons" TEXT[] DEFAULT ARRAY[]::TEXT[];

CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "client_id" TEXT,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "href" TEXT,
    "read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "notifications_user_id_created_at_idx" ON "notifications"("user_id", "created_at");
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
