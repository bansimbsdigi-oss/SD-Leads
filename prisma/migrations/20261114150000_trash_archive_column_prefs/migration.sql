-- Trash and archive for leads; per-client column choices.
ALTER TABLE "leads" ADD COLUMN "deleted_at" TIMESTAMP(3);
ALTER TABLE "leads" ADD COLUMN "archived_at" TIMESTAMP(3);
CREATE INDEX "leads_deleted_at_idx" ON "leads"("deleted_at");
CREATE INDEX "leads_archived_at_idx" ON "leads"("archived_at");

CREATE TABLE "column_prefs" (
    "user_id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "hidden" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "column_prefs_pkey" PRIMARY KEY ("user_id","scope")
);
ALTER TABLE "column_prefs" ADD CONSTRAINT "column_prefs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
