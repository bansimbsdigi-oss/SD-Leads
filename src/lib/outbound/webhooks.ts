// Outbound webhooks ("send leads to Pabbly"): per-client rules that forward matching new leads to a URL.
// The URL is stored encrypted; conditions use the same engine as the leads screen.
import { z } from "zod";
import { decryptJson, encryptJson } from "@/lib/crypto";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/data";
import type { Condition } from "@/lib/leadFilterSpec";
import { formatAnswer, formatDateTime } from "@/lib/leadColumns";
import { leadMatchesConditions } from "@/lib/leadQuery";
import { logger } from "@/lib/logger";
import { enqueue } from "@/lib/queue";
import { can, canSeeClient, ForbiddenError, NotFoundError, type Ctx } from "@/lib/tenant";
import { assertSafeWebhookUrl, webhookUrlProblem } from "./safeUrl";

export type WebhookRule = {
  id: string;
  clientId: string;
  name: string;
  url: string;
  conditions: Condition[];
  status: "active" | "paused";
  createdAt: Date;
};

const conditionsSchema = z
  .array(z.object({ field: z.string().max(200), op: z.string().max(20), value: z.string().max(500).optional(), values: z.array(z.string().max(500)).max(500).optional() }))
  .max(20);

const toRule = (i: { id: string; clientId: string; name: string; config: string; conditions: unknown; status: string; createdAt: Date }): WebhookRule => ({
  id: i.id,
  clientId: i.clientId,
  name: i.name,
  url: decryptJson<{ url: string }>(i.config).url,
  conditions: conditionsSchema.catch([]).parse(i.conditions) as Condition[],
  status: i.status === "paused" ? "paused" : "active",
  createdAt: i.createdAt,
});

/** "connect.pabbly.com/…/ab12" — enough to recognise the URL without showing the secret part. */
export function maskUrl(url: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop() ?? "";
    return `${u.host}/…${last.length > 6 ? last.slice(-6) : last}`;
  } catch {
    return "invalid URL";
  }
}

// ---------- Rules (tenant-checked) ----------

function assertManage(ctx: Ctx, clientId: string) {
  if (!canSeeClient(ctx, clientId)) throw new NotFoundError("Client not found");
  if (!can.manageLps(ctx, clientId)) throw new ForbiddenError();
}

export async function listWebhookRules(ctx: Ctx, clientId: string) {
  if (!canSeeClient(ctx, clientId)) throw new NotFoundError("Client not found");
  const rows = await prisma.integration.findMany({ where: { clientId, type: "webhook" }, orderBy: { createdAt: "asc" } });
  const rules = rows.map(toRule);
  const recent = rules.length
    ? await prisma.outboundDelivery.findMany({
        where: { integrationId: { in: rules.map((r) => r.id) } },
        orderBy: { createdAt: "desc" },
        take: 20 * rules.length,
        include: { lead: { select: { id: true, name: true } } },
      })
    : [];
  return rules.map((r) => ({ ...r, deliveries: recent.filter((d) => d.integrationId === r.id).slice(0, 20) }));
}

async function getRule(ctx: Ctx, id: string) {
  const row = await prisma.integration.findFirst({ where: { id, type: "webhook" } });
  if (!row || !canSeeClient(ctx, row.clientId)) throw new NotFoundError("Webhook not found");
  return toRule(row);
}

export type RuleInput = { name: string; url: string; conditions: Condition[] };

function validate(input: RuleInput) {
  const name = input.name.trim().slice(0, 100);
  if (name.length < 2) throw new Error("Give the webhook a name, e.g. “Pabbly – hot leads”.");
  const problem = webhookUrlProblem(input.url);
  if (problem) throw new Error(problem);
  return { name, url: input.url.trim(), conditions: conditionsSchema.parse(input.conditions) as Condition[] };
}

export async function createWebhookRule(ctx: Ctx, clientId: string, input: RuleInput) {
  assertManage(ctx, clientId);
  const v = validate(input);
  const row = await prisma.integration.create({
    data: { clientId, type: "webhook", name: v.name, config: encryptJson({ url: v.url }), conditions: v.conditions },
  });
  await audit(ctx, "webhook.create", row.id, clientId);
  return row.id;
}

export async function updateWebhookRule(ctx: Ctx, id: string, input: RuleInput) {
  const rule = await getRule(ctx, id);
  assertManage(ctx, rule.clientId);
  const v = validate(input);
  await prisma.integration.update({ where: { id }, data: { name: v.name, config: encryptJson({ url: v.url }), conditions: v.conditions } });
  await audit(ctx, "webhook.update", id, rule.clientId);
}

export async function setWebhookStatus(ctx: Ctx, id: string, status: "active" | "paused") {
  const rule = await getRule(ctx, id);
  assertManage(ctx, rule.clientId);
  await prisma.integration.update({ where: { id }, data: { status } });
  await audit(ctx, `webhook.${status}`, id, rule.clientId);
}

export async function deleteWebhookRule(ctx: Ctx, id: string) {
  const rule = await getRule(ctx, id);
  assertManage(ctx, rule.clientId);
  await prisma.integration.delete({ where: { id } }); // its delivery log goes with it (cascade)
  await audit(ctx, "webhook.delete", id, rule.clientId);
}

// ---------- Payload ----------

/** One flat JSON per lead, easy to map field by field in Pabbly. */
export async function buildLeadPayload(leadId: string, event = "lead.created") {
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    include: {
      client: { select: { name: true, slug: true } },
      lp: { select: { name: true, lpKey: true, sourceUrl: true } },
      status: { select: { name: true } },
      owner: { select: { name: true } },
    },
  });
  if (!lead) return null;
  const answers = lead.answers as Record<string, unknown>;
  const fields = lead.lpId
    ? await prisma.formField.findMany({ where: { lpId: lead.lpId }, orderBy: [{ position: "asc" }, { firstSeenAt: "asc" }] })
    : [];
  const labelOf = new Map(fields.map((f) => [f.fieldKey, f.displayLabel || f.label]));
  const flat: Record<string, string> = {};
  for (const [k, v] of Object.entries(answers)) flat[k] = formatAnswer(v);

  return {
    event,
    sent_at: new Date().toISOString(),
    lead_id: lead.id,
    created_at: lead.createdAt.toISOString(),
    created_at_ist: formatDateTime(lead.createdAt),
    client: lead.client.name,
    client_slug: lead.client.slug,
    landing_page: lead.lp?.name ?? "",
    landing_page_key: lead.lp?.lpKey ?? "",
    landing_page_url: lead.lp?.sourceUrl ?? "",
    source: lead.source,
    status: lead.status?.name ?? "",
    owner: lead.owner?.name ?? "",
    name: lead.name ?? "",
    phone: lead.phoneNormalised ?? "",
    email: lead.emailNormalised ?? "",
    is_duplicate: lead.isDuplicate,
    quiz_score: lead.totalScore,
    answers: flat,
    fields: Object.keys(answers).map((k) => ({ key: k, label: labelOf.get(k) ?? k, value: flat[k] })),
    tracking: lead.tracking as Record<string, string>,
    consent: lead.consent,
  };
}

// ---------- Sending ----------

const TIMEOUT_MS = 10_000;

export type SendResult = { ok: boolean; status: number | null; error: string | null; durationMs: number };

/** POSTs JSON to a checked public URL. Redirects are not followed (they could point anywhere). */
export async function postJson(rawUrl: string, body: unknown): Promise<SendResult> {
  const started = Date.now();
  try {
    const url = await assertSafeWebhookUrl(rawUrl);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "SabhiLeads-Webhook/1" },
      body: JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    await res.body?.cancel().catch(() => {});
    const ok = res.status >= 200 && res.status < 300;
    return { ok, status: res.status, error: ok ? null : `HTTP ${res.status}`, durationMs: Date.now() - started };
  } catch (err) {
    const msg = err instanceof Error ? (err.name === "TimeoutError" ? `No response within ${TIMEOUT_MS / 1000}s` : err.message) : "Send failed";
    return { ok: false, status: null, error: msg.slice(0, 300), durationMs: Date.now() - started };
  }
}

/** Sends one lead to one rule and logs the attempt. Throws when it failed, so the queue retries it. */
export async function deliverLead(integrationId: string, leadId: string, attempt = 1): Promise<SendResult> {
  const row = await prisma.integration.findUnique({ where: { id: integrationId } });
  if (!row || row.type !== "webhook") return { ok: false, status: null, error: "Webhook was deleted", durationMs: 0 };
  const payload = await buildLeadPayload(leadId);
  if (!payload) return { ok: false, status: null, error: "Lead was deleted", durationMs: 0 };
  const result = await postJson(toRule(row).url, payload);
  await prisma.outboundDelivery.create({
    data: {
      leadId,
      integrationId,
      attempt,
      status: result.ok ? "sent" : "failed",
      responseCode: result.status,
      error: result.error,
      durationMs: result.durationMs,
    },
  });
  if (!result.ok) throw new DeliveryError(result.error ?? "failed");
  return result;
}

export class DeliveryError extends Error {}

export const DELIVERY_ATTEMPTS = 5;

/** New lead: queue a delivery for every active rule of its client whose conditions it matches. */
export async function fanOutLead(leadId: string): Promise<string[]> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { clientId: true } });
  if (!lead) return [];
  const rows = await prisma.integration.findMany({ where: { clientId: lead.clientId, type: "webhook", status: "active" } });
  const matched: string[] = [];
  for (const row of rows) {
    const rule = toRule(row);
    if (await leadMatchesConditions(lead.clientId, leadId, rule.conditions)) {
      matched.push(rule.id);
      // Fixed job id: if this fan-out job is retried, already-queued deliveries aren't sent twice.
      await enqueue("webhook.deliver", { integrationId: rule.id, leadId }, { attempts: DELIVERY_ATTEMPTS, backoffMs: 30_000, jobId: `wh-${rule.id}-${leadId}` });
    }
  }
  if (matched.length) logger.info({ leadId, rules: matched.length }, "lead queued for webhooks");
  return matched;
}

/** Retry button: queue one more delivery of a logged lead. */
export async function retryDelivery(ctx: Ctx, deliveryId: string) {
  const d = await prisma.outboundDelivery.findUnique({ where: { id: deliveryId }, include: { integration: true } });
  if (!d || !canSeeClient(ctx, d.integration.clientId)) throw new NotFoundError("Delivery not found");
  assertManage(ctx, d.integration.clientId);
  await enqueue("webhook.deliver", { integrationId: d.integrationId, leadId: d.leadId }, { attempts: 1 });
}

/** Test button: sends the newest matching lead (or a sample) and reports the result. Not logged. */
export async function sendTestWebhook(ctx: Ctx, id: string): Promise<SendResult & { usedLead: string | null }> {
  const rule = await getRule(ctx, id);
  assertManage(ctx, rule.clientId);
  const recent = await prisma.lead.findMany({ where: { clientId: rule.clientId }, orderBy: { createdAt: "desc" }, take: 50, select: { id: true, name: true } });
  let chosen: { id: string; name: string | null } | null = null;
  for (const l of recent) {
    if (await leadMatchesConditions(rule.clientId, l.id, rule.conditions)) {
      chosen = l;
      break;
    }
  }
  const payload = chosen
    ? await buildLeadPayload(chosen.id, "test")
    : {
        event: "test",
        sent_at: new Date().toISOString(),
        lead_id: "test",
        name: "Test Lead",
        phone: "+919876543210",
        email: "test@example.com",
        note: "Sample data: no recent lead matched this webhook's conditions.",
      };
  const result = await postJson(rule.url, payload);
  return { ...result, usedLead: chosen ? chosen.name || "(no name)" : null };
}
