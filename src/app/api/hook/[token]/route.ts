// POST /api/hook/{token}: the client's single webhook. Paste the same URL into every LP form.
// Auth is the secret token; works server-to-server (Elementor, Pabbly) and from the browser.
import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { ingestClientWebhook } from "@/lib/ingest/clientWebhook";
import { rateLimit, RATE_LIMITS } from "@/lib/ingest/guards";
import { MAX_BODY_BYTES } from "@/lib/ingest/schema";
import { readBody } from "@/lib/ingest/webhook";

type Params = { params: Promise<{ token: string }> };

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const reply = (status: number, body: unknown) => NextResponse.json(body, { status, headers: CORS });

async function findClient(token: string) {
  if (!/^[a-f0-9]{32,64}$/.test(token)) return null;
  return prisma.client.findUnique({ where: { webhookToken: token }, select: { id: true, slug: true, status: true } });
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

/** Some tools ping the URL before saving it. */
export async function GET(_: NextRequest, { params }: Params) {
  const client = await findClient((await params).token);
  return client ? reply(200, { ok: true }) : reply(404, { error: "unknown_webhook" });
}

export async function POST(req: NextRequest, { params }: Params) {
  const client = await findClient((await params).token);
  if (!client) return reply(404, { error: "unknown_webhook" });
  if (client.status !== "active") return reply(403, { error: "client_disabled" });

  const ip = req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
  if (!rateLimit(`hook:${client.id}`, RATE_LIMITS.perLp.limit, RATE_LIMITS.perLp.windowMs) ||
      !rateLimit(`hook-ip:${client.id}:${ip}`, 120, 60_000)) {
    return reply(429, { error: "rate_limited" });
  }
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return reply(400, { error: "payload_too_large" });

  const body = await readBody(req);
  if (!body) return reply(400, { error: "malformed_body" });

  try {
    const out = await ingestClientWebhook(client, body, { lp: req.nextUrl.searchParams.get("lp") });
    if (!out.ok) return reply(out.status, { error: out.error, issues: out.issues });
    return reply(202, { lead_id: out.leadId, status: "received", duplicate: out.duplicate });
  } catch (err) {
    logger.error({ err, clientId: client.id }, "client webhook failed");
    return reply(500, { error: "server_error" });
  }
}
