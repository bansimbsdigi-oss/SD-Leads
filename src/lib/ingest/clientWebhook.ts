// One webhook per client: finds (or creates) the LP a submission came from, then saves it like any lead.
import { randomBytes } from "node:crypto";
import { Prisma, type Client } from "@prisma/client";
import { prisma } from "@/lib/db";
import { slugify } from "@/lib/data";
import { ingestPayloadSchema, type IngestPayload } from "./schema";
import { ingestLead } from "./service";
import { fallbackSubmissionId, normaliseWebhookBody, sourceKeyFromUrl } from "./webhook";

type WebhookClient = Pick<Client, "id" | "slug">;

/**
 * LP lookup order: explicit lp key (?lp= or body) → page URL → form name → one catch-all LP.
 * Unknown pages create a new LP automatically, so the same URL can be pasted into every form.
 */
export async function resolveWebhookLp(
  client: WebhookClient,
  hint: { lpKey: string | null; pageUrl: string | null; formName: string | null },
) {
  if (hint.lpKey) {
    const lp = await prisma.landingPage.findFirst({ where: { clientId: client.id, lpKey: hint.lpKey } });
    if (lp) return lp;
  }

  const fromUrl = hint.pageUrl ? sourceKeyFromUrl(hint.pageUrl) : null;
  const sourceKey = fromUrl ?? (hint.formName ? `form:${hint.formName.toLowerCase().slice(0, 200)}` : "webhook:unknown");
  const existing = await prisma.landingPage.findUnique({ where: { clientId_sourceKey: { clientId: client.id, sourceKey } } });
  if (existing) return existing;

  const path = fromUrl ? fromUrl.slice(fromUrl.indexOf("/") + 1) : "";
  const name = hint.formName || (fromUrl ? (path ? `/${path}` : fromUrl) : "Webhook (page unknown)");
  const keyBase = slugify(hint.lpKey || `${client.slug}-${path.split("/").pop() || hint.formName || "webhook"}`).slice(0, 40);
  const host = fromUrl ? fromUrl.split("/")[0] : null;

  // lp_key is unique across all clients, so a random suffix could collide; two first leads from a
  // new page can also race. Retry with a new key, or pick up the LP the other request created.
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.landingPage.upsert({
        where: { clientId_sourceKey: { clientId: client.id, sourceKey } },
        update: {},
        create: {
          clientId: client.id,
          name: name.slice(0, 120),
          lpKey: `${keyBase}-${randomBytes(attempt < 2 ? 2 : 4).toString("hex")}`,
          sourceKey,
          sourceUrl: hint.pageUrl?.split("?")[0].slice(0, 500) ?? null,
          autoCreated: true,
          allowedDomains: host ? [host] : [],
        },
      });
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") || attempt >= 4) throw err;
      const winner = await prisma.landingPage.findUnique({ where: { clientId_sourceKey: { clientId: client.id, sourceKey } } });
      if (winner) return winner;
    }
  }
}

export type WebhookOutcome =
  | { ok: true; leadId: string; lpId: string; created: boolean; duplicate: boolean }
  | { ok: false; status: 403 | 422; error: string; issues?: unknown };

export async function ingestClientWebhook(
  client: WebhookClient,
  body: Record<string, unknown>,
  query: { lp?: string | null } = {},
): Promise<WebhookOutcome> {
  const n = normaliseWebhookBody(body as never);
  if (!n.fields.length) return { ok: false, status: 422, error: "no_fields" };

  const payload: IngestPayload | null = (() => {
    const parsed = ingestPayloadSchema.safeParse({
      submission_id: n.submissionId ?? fallbackSubmissionId(client.id, body as never),
      fields: n.fields,
      tracking: n.tracking,
      consent: n.consent,
    });
    return parsed.success ? parsed.data : null;
  })();
  if (!payload) {
    const issues = ingestPayloadSchema.safeParse({ submission_id: "x".repeat(8), fields: n.fields }).error?.flatten();
    return { ok: false, status: 422, error: "validation_failed", issues };
  }

  const lp = await resolveWebhookLp(client, { lpKey: query.lp ?? n.lpKey, pageUrl: n.pageUrl, formName: n.formName });
  if (lp.status !== "active") return { ok: false, status: 403, error: "lp_paused" };

  const result = await ingestLead(lp, payload, "webhook");
  return { ok: true, leadId: result.leadId, lpId: lp.id, created: result.created, duplicate: Boolean(result.duplicateOfId) };
}
