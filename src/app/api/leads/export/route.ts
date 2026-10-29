import { NextResponse, type NextRequest } from "next/server";
import { audit } from "@/lib/data";
import { leadColumns, toCsv } from "@/lib/leadColumns";
import { leadFieldDefs, parseLeadQuery, queryLeads } from "@/lib/leadQuery";
import { getCtx } from "@/lib/session";

const MAX_EXPORT_ROWS = 5000;

/** Same search, filters, sort and columns as the leads screen. */
export async function GET(req: NextRequest) {
  const ctx = await getCtx();
  if (!ctx) return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  const query = { ...parseLeadQuery(req.nextUrl.searchParams), page: 1, pageSize: MAX_EXPORT_ROWS };
  const scope = { clientId: query.clientId };
  const [defs, columns] = await Promise.all([leadFieldDefs(ctx, scope), leadColumns(ctx, scope)]);
  const { rows } = await queryLeads(ctx, query, defs);
  await audit(ctx, "leads.export", req.nextUrl.search.slice(0, 500), query.clientId ?? ctx.clientId);
  return new NextResponse(toCsv(columns, rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="leads-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
}
