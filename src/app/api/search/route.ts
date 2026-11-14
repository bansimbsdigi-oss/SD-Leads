import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { queryLeads } from "@/lib/leadQuery";
import { getCtx } from "@/lib/session";
import { clientWhere, isSabhiStaff, lpWhere } from "@/lib/tenant";

/** GET /api/search?q= → quick search (Ctrl/⌘ K): leads, clients and landing pages this user can see. */
export async function GET(req: NextRequest) {
  const ctx = await getCtx();
  if (!ctx) return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  const q = (req.nextUrl.searchParams.get("q") ?? "").trim().slice(0, 100);
  if (q.length < 2) return NextResponse.json({ leads: [], clients: [], lps: [] });

  const [leads, clients, lps] = await Promise.all([
    queryLeads(ctx, { q, conditions: [], dir: "desc", page: 1, pageSize: 8 }),
    isSabhiStaff(ctx)
      ? prisma.client.findMany({ where: { AND: [clientWhere(ctx), { name: { contains: q, mode: "insensitive" } }] }, take: 5, orderBy: { name: "asc" }, select: { id: true, name: true } })
      : Promise.resolve([]),
    prisma.landingPage.findMany({
      where: { AND: [lpWhere(ctx), { name: { contains: q, mode: "insensitive" } }] },
      take: 5,
      orderBy: { name: "asc" },
      select: { id: true, name: true, client: { select: { name: true } } },
    }),
  ]);
  return NextResponse.json(
    {
      leads: leads.rows.map((l) => ({ id: l.id, name: l.name || "(no name)", sub: [l.phoneNormalised, l.emailNormalised, isSabhiStaff(ctx) ? l.client.name : null].filter(Boolean).join(" · ") })),
      clients: clients.map((c) => ({ id: c.id, name: c.name })),
      lps: lps.map((p) => ({ id: p.id, name: p.name, sub: p.client.name })),
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
