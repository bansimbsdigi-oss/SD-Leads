// POST /api/ingest/{clientSlug}/{lpKey}: public LP form ingest (plan section 6).
import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { isOriginAllowed, rateLimit, RATE_LIMITS, verifyTurnstile } from "@/lib/ingest/guards";
import { ingestPayloadSchema, MAX_BODY_BYTES } from "@/lib/ingest/schema";
import { ingestLead } from "@/lib/ingest/service";

type Params = { params: Promise<{ clientSlug: string; lpKey: string }> };

function corsHeaders(origin: string | null): HeadersInit {
  return origin
    ? {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400",
        Vary: "Origin",
      }
    : { Vary: "Origin" };
}

async function resolveLp(clientSlug: string, lpKey: string) {
  return prisma.landingPage.findFirst({
    where: { lpKey, client: { slug: clientSlug } },
    select: { id: true, clientId: true, currentFormVersion: true, status: true, allowedDomains: true, client: { select: { status: true } } },
  });
}

function clientIp(req: NextRequest): string | null {
  return req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? null;
}

export async function OPTIONS(req: NextRequest, { params }: Params) {
  const { clientSlug, lpKey } = await params;
  const origin = req.headers.get("origin");
  const lp = await resolveLp(clientSlug, lpKey);
  if (!lp || !isOriginAllowed(origin, lp.allowedDomains)) return new NextResponse(null, { status: 403 });
  return new NextResponse(null, { status: 204, headers: corsHeaders(origin) });
}

export async function POST(req: NextRequest, { params }: Params) {
  const { clientSlug, lpKey } = await params;
  const origin = req.headers.get("origin");
  const reply = (status: number, body: unknown, allowOrigin = false) =>
    NextResponse.json(body, { status, headers: corsHeaders(allowOrigin ? origin : null) });

  // 1. Resolve client and LP.
  const lp = await resolveLp(clientSlug, lpKey);
  if (!lp) return reply(404, { error: "unknown_lp" });

  // 2. Origin allow-list. CORS headers are only ever sent for an allowed origin.
  if (!isOriginAllowed(origin, lp.allowedDomains)) return reply(403, { error: "origin_not_allowed" });
  if (lp.status !== "active" || lp.client.status !== "active") return reply(403, { error: "lp_paused" }, true);

  // 4. Rate limit per IP and per LP (cheap, so before Turnstile's network call).
  const ip = clientIp(req);
  const ipOk = rateLimit(`ip:${ip ?? "unknown"}`, RATE_LIMITS.perIp.limit, RATE_LIMITS.perIp.windowMs);
  const lpOk = rateLimit(`lp:${lp.id}`, RATE_LIMITS.perLp.limit, RATE_LIMITS.perLp.windowMs);
  if (!ipOk || !lpOk) return reply(429, { error: "rate_limited" }, true);

  // 5. Parse and validate.
  const raw = await req.text();
  if (Buffer.byteLength(raw) > MAX_BODY_BYTES) return reply(400, { error: "payload_too_large" }, true);
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return reply(400, { error: "malformed_json" }, true);
  }
  const parsed = ingestPayloadSchema.safeParse(json);
  if (!parsed.success) {
    return reply(422, { error: "validation_failed", issues: parsed.error.flatten() }, true);
  }

  // 3. Turnstile.
  if (!(await verifyTurnstile(parsed.data.turnstile_token, ip))) {
    return reply(403, { error: "turnstile_failed" }, true);
  }

  // 6–11. Normalise, idempotency, dedupe, registry, save, enqueue.
  try {
    const result = await ingestLead(lp, parsed.data);
    return reply(202, { lead_id: result.leadId, status: "received", duplicate: Boolean(result.duplicateOfId) }, true);
  } catch (err) {
    logger.error({ err, lpId: lp.id }, "ingest failed");
    return reply(500, { error: "server_error" }, true);
  }
}
