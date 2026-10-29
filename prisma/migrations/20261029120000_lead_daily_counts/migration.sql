-- CreateTable
CREATE TABLE "lead_daily_counts" (
    "client_id" TEXT NOT NULL,
    "lp_id" TEXT NOT NULL DEFAULT '',
    "day" DATE NOT NULL,
    "leads" INTEGER NOT NULL DEFAULT 0,
    "duplicates" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "lead_daily_counts_pkey" PRIMARY KEY ("client_id","lp_id","day")
);

-- CreateIndex
CREATE INDEX "lead_daily_counts_day_idx" ON "lead_daily_counts"("day");

-- AddForeignKey
ALTER TABLE "lead_daily_counts" ADD CONSTRAINT "lead_daily_counts_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Backfill from existing leads (day = calendar day in India).
INSERT INTO "lead_daily_counts" ("client_id", "lp_id", "day", "leads", "duplicates")
SELECT "client_id", COALESCE("lp_id", ''), (("created_at" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata')::date,
       count(*)::int, (count(*) FILTER (WHERE "is_duplicate"))::int
FROM "leads"
GROUP BY 1, 2, 3;
