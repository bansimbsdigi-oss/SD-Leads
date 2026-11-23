// POST /api/lookup/{token}: the global lead lookup webhook. Body (JSON or form): name, email, phone
// (common alternative names accepted). Answers straight away with the result, and sends the same result
// to the outbound webhook set on the Lead lookup page.
import { NextResponse, type NextRequest } from "next/server";
import { rateLimit } from "@/lib/ingest/guards";
import { MAX_BODY_BYTES } from "@/lib/ingest/schema";
import { readBody } from "@/lib/ingest/webhook";
import { logger } from "@/lib/logger";
import { lookupAndLog, lookupInput, LookupInputError, lookupTokenMatches } from "@/lib/lookup";

type Params = { params: Promise<{ token: string }> };

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };
const reply = (status: number, body: unknown) => NextResponse.json(body, { status, headers: CORS });

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

/** Some tools ping the URL before saving it. */
export async function GET(_: NextRequest, { params }: Params) {
  return (await lookupTokenMatches((await params).token)) ? reply(200, { ok: true }) : reply(401, { error: "unauthorised" });
}

export async function POST(req: NextRequest, { params }: Params) {
  if (!(await lookupTokenMatches((await params).token))) return reply(401, { error: "unauthorised", message: "Wrong or old lookup webhook URL." });
  if (!rateLimit("lookup", 1200, 60_000)) return reply(429, { error: "rate_limited" });
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return reply(400, { error: "payload_too_large" });

  const body = await readBody(req);
  if (!body) return reply(400, { error: "malformed_body" });
  try {
    const { payload, lookupId } = await lookupAndLog(lookupInput(body as Record<string, unknown>), "webhook", true);
    return reply(200, { ...payload, lookup_id: lookupId });
  } catch (err) {
    if (err instanceof LookupInputError) return reply(422, { error: "missing_contact", message: err.message });
    logger.error({ err }, "lead lookup webhook failed");
    return reply(503, { error: "lookup_unavailable", message: err instanceof Error ? err.message : "Lookup failed" });
  }
}
