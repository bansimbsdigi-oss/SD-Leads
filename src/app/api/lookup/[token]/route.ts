// POST /api/lookup/{token}: lead lookup for Pabbly. Body (JSON or form): name, email, phone (common
// alternative names accepted). Answers straight away with the result, and queues the same result to the
// client's lookup webhook (event = lead_lookup). The secret token is per client.
import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { rateLimit } from "@/lib/ingest/guards";
import { MAX_BODY_BYTES } from "@/lib/ingest/schema";
import { readBody } from "@/lib/ingest/webhook";
import { logger } from "@/lib/logger";
import { lookupAndLog, lookupInput, LookupInputError } from "@/lib/lookup";

type Params = { params: Promise<{ token: string }> };

async function findConfig(token: string) {
  if (!/^[a-f0-9]{32,64}$/.test(token)) return null;
  return prisma.lookupConfig.findUnique({ where: { apiToken: token }, select: { clientId: true, enabled: true, client: { select: { status: true } } } });
}

/** Some tools ping the URL before saving it. */
export async function GET(_: NextRequest, { params }: Params) {
  const cfg = await findConfig((await params).token);
  return cfg ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "unauthorised" }, { status: 401 });
}

export async function POST(req: NextRequest, { params }: Params) {
  const cfg = await findConfig((await params).token);
  if (!cfg) return NextResponse.json({ error: "unauthorised", message: "Wrong or old lookup URL." }, { status: 401 });
  if (!cfg.enabled || cfg.client.status !== "active") return NextResponse.json({ error: "lookup_off" }, { status: 403 });
  if (!rateLimit(`lookup:${cfg.clientId}`, 600, 60_000)) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return NextResponse.json({ error: "payload_too_large" }, { status: 400 });

  const body = await readBody(req);
  if (!body) return NextResponse.json({ error: "malformed_body" }, { status: 400 });
  try {
    const input = lookupInput(body as Record<string, unknown>);
    const { payload, lookupId } = await lookupAndLog(cfg.clientId, input, "api", true);
    return NextResponse.json({ ...payload, lookup_id: lookupId });
  } catch (err) {
    if (err instanceof LookupInputError) return NextResponse.json({ error: "missing_contact", message: err.message }, { status: 422 });
    logger.error({ err, clientId: cfg.clientId }, "lookup api failed");
    return NextResponse.json({ error: "server_error", message: err instanceof Error ? err.message : "Lookup failed" }, { status: 500 });
  }
}
