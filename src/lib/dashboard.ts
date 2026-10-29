// Dashboard numbers: leads per client (Sabhi staff, all clients), or per landing page (one client:
// a client user's own, or the client a staff member picked). Reads lead_daily_counts (a few rows per
// LP per day) instead of counting leads. Client members, who only see leads they own or are
// assigned, are counted live since that scope isn't per-LP.
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { istDay } from "@/lib/dailyCounts";
import type { RangeId } from "@/lib/leadFilterSpec";
import { naiveUtc, rangeBounds } from "@/lib/leadQuery";
import { canSeeClient, isSabhiStaff, leadScopeSql, NotFoundError, type Ctx } from "@/lib/tenant";

export type DashboardRow = {
  id: string;
  name: string;
  /** Leads in the selected range (all time when no range). */
  inRange: number;
  today: number;
  last7: number;
  last30: number;
  allTime: number;
  duplicates: number;
};

export type Dashboard = {
  groupBy: "client" | "lp";
  /** Set when the view is one client (picked by staff, or the user's own). */
  clientId: string | null;
  rows: DashboardRow[];
  totals: Omit<DashboardRow, "id" | "name">;
};

type View = { groupBy: "client" | "lp"; clientId: string | null; live: boolean; scope: Prisma.Sql };

/** What the dashboard covers for this user, optionally narrowed to one client by staff. */
function resolveView(ctx: Ctx, pickedClientId?: string): View {
  if (isSabhiStaff(ctx)) {
    if (pickedClientId) {
      if (!canSeeClient(ctx, pickedClientId)) throw new NotFoundError("Client not found");
      return { groupBy: "lp", clientId: pickedClientId, live: false, scope: Prisma.sql`client_id = ${pickedClientId}` };
    }
    const scope =
      ctx.role === "SUPER_ADMIN"
        ? Prisma.sql`TRUE`
        : ctx.managedClientIds.length
          ? Prisma.sql`client_id IN (${Prisma.join(ctx.managedClientIds)})`
          : Prisma.sql`FALSE`;
    return { groupBy: "client", clientId: null, live: false, scope };
  }
  return { groupBy: "lp", clientId: ctx.clientId, live: ctx.role === "CLIENT_MEMBER", scope: Prisma.sql`client_id = ${ctx.clientId ?? ""}` };
}

const dayParam = (d: Date) => Prisma.sql`${istDay(d)}::date`;
const istDateOf = Prisma.sql`((l.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata')::date`;

export async function dashboardCounts(ctx: Ctx, range?: RangeId, pickedClientId?: string): Promise<Dashboard> {
  const view = resolveView(ctx, pickedClientId);
  const today = rangeBounds("today").from;
  const d7 = rangeBounds("7d").from;
  const d30 = rangeBounds("30d").from;
  const bounds = range ? rangeBounds(range) : null;
  type CountRow = { id: string | null; in_range: number; today: number; last7: number; last30: number; all_time: number; duplicates: number };

  const counts = view.live
    ? await prisma.$queryRaw<CountRow[]>(Prisma.sql`
        SELECT l.lp_id AS id,
          (${bounds ? Prisma.sql`count(*) FILTER (WHERE l.created_at >= ${naiveUtc(bounds.from)}${bounds.to ? Prisma.sql` AND l.created_at < ${naiveUtc(bounds.to)}` : Prisma.empty})` : Prisma.sql`count(*)`})::int AS in_range,
          count(*) FILTER (WHERE l.created_at >= ${naiveUtc(today)})::int AS today,
          count(*) FILTER (WHERE l.created_at >= ${naiveUtc(d7)})::int AS last7,
          count(*) FILTER (WHERE l.created_at >= ${naiveUtc(d30)})::int AS last30,
          count(*)::int AS all_time,
          count(*) FILTER (WHERE l.is_duplicate)::int AS duplicates
        FROM leads l
        WHERE ${leadScopeSql(ctx)}
        GROUP BY 1`)
    : await prisma.$queryRaw<CountRow[]>(Prisma.sql`
        SELECT ${view.groupBy === "client" ? Prisma.sql`client_id` : Prisma.sql`lp_id`} AS id,
          COALESCE(${bounds ? Prisma.sql`sum(leads) FILTER (WHERE day >= ${dayParam(bounds.from)}${bounds.to ? Prisma.sql` AND day < ${dayParam(bounds.to)}` : Prisma.empty})` : Prisma.sql`sum(leads)`}, 0)::int AS in_range,
          COALESCE(sum(leads) FILTER (WHERE day >= ${dayParam(today)}), 0)::int AS today,
          COALESCE(sum(leads) FILTER (WHERE day >= ${dayParam(d7)}), 0)::int AS last7,
          COALESCE(sum(leads) FILTER (WHERE day >= ${dayParam(d30)}), 0)::int AS last30,
          COALESCE(sum(leads), 0)::int AS all_time,
          COALESCE(sum(duplicates), 0)::int AS duplicates
        FROM lead_daily_counts
        WHERE ${view.scope}
        GROUP BY 1`);
  const byId = new Map(counts.map((c) => [c.id ?? "", c]));

  // Every client / LP in scope is listed, including those with no leads yet.
  const groups =
    view.groupBy === "client"
      ? await prisma.client.findMany({
          where: ctx.role === "SUPER_ADMIN" ? {} : { id: { in: ctx.managedClientIds } },
          select: { id: true, name: true },
        })
      : await prisma.landingPage.findMany({
          where: { clientId: view.clientId ?? "", ...(ctx.role === "CLIENT_MEMBER" && ctx.lpIds.length ? { id: { in: ctx.lpIds } } : {}) },
          select: { id: true, name: true },
        });
  const toRow = (id: string, name: string): DashboardRow => {
    const c = byId.get(id);
    return {
      id,
      name,
      inRange: c?.in_range ?? 0,
      today: c?.today ?? 0,
      last7: c?.last7 ?? 0,
      last30: c?.last30 ?? 0,
      allTime: c?.all_time ?? 0,
      duplicates: c?.duplicates ?? 0,
    };
  };
  const rows = groups.map((g) => toRow(g.id, g.name));
  if (view.groupBy === "lp" && byId.has("")) rows.push(toRow("", "No landing page")); // leads whose LP was removed
  rows.sort((a, b) => b.inRange - a.inRange || b.allTime - a.allTime || a.name.localeCompare(b.name));

  const sum = (k: keyof Omit<DashboardRow, "id" | "name">) => rows.reduce((n, r) => n + r[k], 0);
  return {
    groupBy: view.groupBy,
    clientId: view.clientId,
    rows,
    totals: { inRange: sum("inRange"), today: sum("today"), last7: sum("last7"), last30: sum("last30"), allTime: sum("allTime"), duplicates: sum("duplicates") },
  };
}

// ---------- Leads over time ----------

export type TrendPoint = { key: string; label: string; value: number };
export type Trend = { unit: "day" | "month"; title: string; points: TrendPoint[] };

const DAY_LABEL = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
const MONTH_LABEL = new Intl.DateTimeFormat("en-IN", { month: "short", year: "2-digit", timeZone: "UTC" });

/** Daily bars for ranges up to 30 days (the last 7 days for Today/Yesterday); monthly otherwise. */
function trendBuckets(range?: RangeId): { unit: "day" | "month"; from: string; title: string } {
  const todayKey = istDay(new Date());
  const daysBack = (n: number) => istDay(new Date(Date.parse(`${todayKey}T00:00:00Z`) - n * 86_400_000));
  switch (range) {
    case "today":
    case "yesterday":
    case "7d": return { unit: "day", from: daysBack(6), title: "Leads per day · last 7 days" };
    case "15d": return { unit: "day", from: daysBack(14), title: "Leads per day · last 15 days" };
    case "30d": return { unit: "day", from: daysBack(29), title: "Leads per day · last 30 days" };
    case "6m": return { unit: "month", from: `${istDay(rangeBounds("6m").from).slice(0, 7)}-01`, title: "Leads per month · last 6 months" };
    default: {
      const [y, m] = todayKey.split("-").map(Number);
      const start = new Date(Date.UTC(y, m - 12, 1)).toISOString().slice(0, 10);
      return { unit: "month", from: start, title: "Leads per month · last 12 months" };
    }
  }
}

export async function dashboardTrend(ctx: Ctx, range?: RangeId, pickedClientId?: string): Promise<Trend> {
  const view = resolveView(ctx, pickedClientId);
  const { unit, from, title } = trendBuckets(range);
  const fmt = unit === "day" ? "YYYY-MM-DD" : "YYYY-MM";
  const rows = view.live
    ? await prisma.$queryRaw<{ k: string; n: number }[]>(Prisma.sql`
        SELECT to_char(${istDateOf}, ${fmt}) AS k, count(*)::int AS n
        FROM leads l WHERE ${leadScopeSql(ctx)} AND ${istDateOf} >= ${from}::date GROUP BY 1`)
    : await prisma.$queryRaw<{ k: string; n: number }[]>(Prisma.sql`
        SELECT to_char(day, ${fmt}) AS k, COALESCE(sum(leads), 0)::int AS n
        FROM lead_daily_counts WHERE ${view.scope} AND day >= ${from}::date GROUP BY 1`);
  const byKey = new Map(rows.map((r) => [r.k, r.n]));

  // Every bucket from `from` to today, zeros included, so gaps show as gaps.
  const points: TrendPoint[] = [];
  const end = istDay(new Date());
  const cursor = new Date(`${from}T00:00:00Z`);
  while (cursor.toISOString().slice(0, 10) <= end) {
    const key = cursor.toISOString().slice(0, unit === "day" ? 10 : 7);
    points.push({ key, label: (unit === "day" ? DAY_LABEL : MONTH_LABEL).format(cursor), value: byKey.get(key) ?? 0 });
    if (unit === "day") cursor.setUTCDate(cursor.getUTCDate() + 1);
    else cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return { unit, title, points };
}
