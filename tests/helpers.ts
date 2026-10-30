import { prisma } from "@/lib/db";
import { DEFAULT_STAGES } from "@/lib/data";
import { newWebhookToken } from "@/lib/crypto";
import type { Ctx } from "@/lib/tenant";
import type { Role } from "@prisma/client";

export async function resetDb() {
  await prisma.$executeRawUnsafe(
    `TRUNCATE outbound_deliveries, integrations, lead_daily_counts, clients, users, landing_pages, leads, form_fields, form_versions, lead_events, pipeline_stages, audit_log, client_managers, user_lp_access CASCADE`,
  );
}

export async function makeClient(slug: string) {
  const client = await prisma.client.create({ data: { name: slug, slug, webhookToken: newWebhookToken(), pipelineStages: { create: DEFAULT_STAGES } } });
  const lp = await prisma.landingPage.create({
    data: { clientId: client.id, name: `${slug} LP`, lpKey: `${slug}-lp`, allowedDomains: [`${slug}.com`] },
  });
  return { client, lp };
}

export async function makeUser(role: Role, clientId: string | null, extra: Partial<Ctx> = {}): Promise<Ctx> {
  const u = await prisma.user.create({
    data: { email: `${role}-${Math.random().toString(36).slice(2)}@t.test`, name: role, role, clientId, passwordHash: "x" },
  });
  return { userId: u.id, role, clientId, managedClientIds: [], lpIds: [], ...extra };
}

export function payload(overrides: Record<string, unknown> = {}) {
  return {
    submission_id: `sub-${Math.random().toString(36).slice(2)}`,
    fields: [
      { key: "name", type: "text", label: "Your name", role: "name" as const, value: "Asha" },
      { key: "phone", type: "tel", label: "Mobile", role: "phone" as const, value: "98765 43210" },
      { key: "q1", type: "radio", label: "How often do you post?", options: ["Never", "Weekly", "Daily"], value: "Weekly", score: 2 },
      { key: "budget", type: "select", label: "Budget", options: ["<1L", "1-5L", "5L+"], value: "5L+" },
    ],
    tracking: { utm_source: "meta" },
    ...overrides,
  };
}
