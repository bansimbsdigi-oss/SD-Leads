import { NextResponse, type NextRequest } from "next/server";
import { columnValues, leadFieldDefs, parseLeadQuery } from "@/lib/leadQuery";
import { getCtx } from "@/lib/session";

/** GET /api/leads/values?field=a:city&…current filters → values for that column's filter list. */
export async function GET(req: NextRequest) {
  const ctx = await getCtx();
  if (!ctx) return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  const field = req.nextUrl.searchParams.get("field") ?? "";
  const query = parseLeadQuery(req.nextUrl.searchParams);
  const defs = await leadFieldDefs(ctx, { clientId: query.clientId });
  const result = await columnValues(ctx, query, defs, field);
  if (!result) return NextResponse.json({ error: "unknown_field" }, { status: 404 });
  return NextResponse.json(result, { headers: { "Cache-Control": "private, no-store" } });
}
