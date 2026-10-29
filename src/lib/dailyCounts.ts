// Maintains lead_daily_counts (see schema). Every lead insert/delete adjusts its (client, LP, IST day) row
// inside the same transaction, so the dashboard's totals are always exact.
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

const IST_OFFSET_MS = 330 * 60_000;

/** Calendar day in India for a timestamp, as YYYY-MM-DD. */
export const istDay = (d: Date) => new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);

type Db = Prisma.TransactionClient | typeof prisma;
type LeadKey = { clientId: string; lpId: string | null; createdAt: Date; isDuplicate: boolean };

/** Adds (or with a negative delta, removes) leads from their daily rows. Groups the input first. */
export async function adjustDailyCounts(db: Db, leads: LeadKey[], sign: 1 | -1) {
  const groups = new Map<string, { clientId: string; lpId: string; day: string; leads: number; duplicates: number }>();
  for (const l of leads) {
    const lpId = l.lpId ?? "";
    const day = istDay(l.createdAt);
    const k = `${l.clientId}|${lpId}|${day}`;
    const g = groups.get(k) ?? { clientId: l.clientId, lpId, day, leads: 0, duplicates: 0 };
    g.leads += 1;
    g.duplicates += l.isDuplicate ? 1 : 0;
    groups.set(k, g);
  }
  // Fixed order, so two transactions touching the same rows never lock them in opposite orders.
  for (const g of [...groups.values()].sort((a, b) => (a.clientId + a.lpId + a.day).localeCompare(b.clientId + b.lpId + b.day))) {
    const n = sign * g.leads;
    const d = sign * g.duplicates;
    await db.$executeRaw`
      INSERT INTO lead_daily_counts (client_id, lp_id, day, leads, duplicates)
      VALUES (${g.clientId}, ${g.lpId}, ${g.day}::date, ${Math.max(n, 0)}, ${Math.max(d, 0)})
      ON CONFLICT (client_id, lp_id, day) DO UPDATE
        SET leads = GREATEST(lead_daily_counts.leads + ${n}, 0),
            duplicates = GREATEST(lead_daily_counts.duplicates + ${d}, 0)`;
  }
}

/** Recomputes the daily rows from `leads` (all clients, or one). For repairs and tests. */
export async function rebuildDailyCounts(clientId?: string) {
  const only = clientId ? Prisma.sql`WHERE client_id = ${clientId}` : Prisma.empty;
  await prisma.$transaction([
    prisma.$executeRaw`DELETE FROM lead_daily_counts ${only}`,
    prisma.$executeRaw`
      INSERT INTO lead_daily_counts (client_id, lp_id, day, leads, duplicates)
      SELECT client_id, COALESCE(lp_id, ''), ((created_at AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata')::date,
             count(*)::int, (count(*) FILTER (WHERE is_duplicate))::int
      FROM leads ${only}
      GROUP BY 1, 2, 3`,
  ]);
}
