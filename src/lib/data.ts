// Tenant-scoped data layer. UI and API code call these, never prisma directly for tenant data.
import { randomBytes } from "node:crypto";
import { newWebhookToken } from "@/lib/crypto";
import { Prisma, type LpStatus, type Role } from "@prisma/client";
import { prisma } from "@/lib/db";
import { adjustDailyCounts } from "@/lib/dailyCounts";
import { queryLeads } from "@/lib/leadQuery";
import { hashPassword } from "@/lib/password";
import { can, canSeeClient, clientWhere, ForbiddenError, leadWhere, lpWhere, NotFoundError, type Ctx } from "@/lib/tenant";

export const DEFAULT_STAGES = [
  { name: "New", position: 0 },
  { name: "Contacted", position: 1 },
  { name: "Qualified", position: 2 },
  { name: "Won", position: 3, isWon: true },
  { name: "Lost", position: 4, isLost: true },
];

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export async function audit(ctx: Ctx | null, action: string, target?: string, clientId?: string | null) {
  await prisma.auditLog.create({ data: { actorId: ctx?.userId, clientId: clientId ?? null, action, target } });
}

// ---------- Clients ----------

export function listClients(ctx: Ctx) {
  return prisma.client.findMany({
    where: clientWhere(ctx),
    orderBy: { name: "asc" },
    include: { _count: { select: { landingPages: true, leads: true, users: true } } },
  });
}

/** Id + name only, for dropdowns. Avoids counting every client's leads on each page view. */
export function listClientOptions(ctx: Ctx) {
  return prisma.client.findMany({ where: clientWhere(ctx), orderBy: { name: "asc" }, select: { id: true, name: true } });
}

export async function getClient(ctx: Ctx, id: string) {
  const client = await prisma.client.findFirst({ where: { AND: [clientWhere(ctx), { id }] } });
  if (!client) throw new NotFoundError("Client not found");
  return client;
}

export async function createClient(ctx: Ctx, input: { name: string; slug?: string }) {
  if (!can.manageClients(ctx)) throw new ForbiddenError();
  const slug = slugify(input.slug || input.name);
  if (!slug) throw new Error("Slug is required");
  const client = await prisma.client.create({
    data: { name: input.name.trim(), slug, webhookToken: newWebhookToken(), pipelineStages: { create: DEFAULT_STAGES } },
  });
  await audit(ctx, "client.create", client.id, client.id);
  return client;
}

const DELETE_BATCH = 5000;

/**
 * Permanently deletes a client and everything under it (landing pages, leads, users, webhooks, totals).
 * Super admin only; the caller must type the client's name. The client is disabled first so no new
 * leads arrive, then leads go in batches (a single huge delete could hit the statement timeout).
 */
export async function deleteClient(ctx: Ctx, id: string, typedName: string) {
  if (!can.manageClients(ctx)) throw new ForbiddenError();
  const client = await getClient(ctx, id);
  if (typedName.trim().toLowerCase() !== client.name.trim().toLowerCase()) {
    throw new Error(`Type the client's name exactly (“${client.name}”) to confirm.`);
  }
  const leadCount = await prisma.lead.count({ where: { clientId: id } });
  await prisma.client.update({ where: { id }, data: { status: "disabled" } });
  for (;;) {
    const n = await prisma.$executeRaw`DELETE FROM leads WHERE id IN (SELECT id FROM leads WHERE client_id = ${id} LIMIT ${DELETE_BATCH})`;
    if (n < DELETE_BATCH) break;
  }
  await prisma.client.delete({ where: { id } }); // cascades to LPs, users, stages, webhooks, daily totals
  await audit(ctx, "client.delete", `${client.name} (${client.slug}) · ${leadCount} leads`, id);
  return { name: client.name, leadCount };
}

/** Issues a new webhook URL; the old one stops working immediately. */
export async function rotateWebhookToken(ctx: Ctx, clientId: string) {
  await getClient(ctx, clientId);
  if (!can.manageLps(ctx, clientId)) throw new ForbiddenError();
  await prisma.client.update({ where: { id: clientId }, data: { webhookToken: newWebhookToken() } });
  await audit(ctx, "client.webhook_rotated", clientId, clientId);
}

// ---------- Landing pages ----------

export function listLps(ctx: Ctx, clientId?: string) {
  return prisma.landingPage.findMany({
    where: { AND: [lpWhere(ctx), clientId ? { clientId } : {}] },
    orderBy: { createdAt: "desc" },
    include: { client: { select: { name: true, slug: true } }, _count: { select: { leads: true, fields: true } } },
  });
}

export async function getLp(ctx: Ctx, id: string) {
  const lp = await prisma.landingPage.findFirst({
    where: { AND: [lpWhere(ctx), { id }] },
    include: { client: { select: { id: true, name: true, slug: true } } },
  });
  if (!lp) throw new NotFoundError("Landing page not found");
  return lp;
}

export function parseDomains(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(/[\s,]+/)
        .map((d) => d.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
        .filter(Boolean),
    ),
  ];
}

export async function createLp(ctx: Ctx, input: { clientId: string; name: string; lpKey?: string; allowedDomains: string[] }) {
  await getClient(ctx, input.clientId);
  if (!can.manageLps(ctx, input.clientId)) throw new ForbiddenError();
  const lpKey = slugify(input.lpKey || `${input.name}-${randomBytes(3).toString("hex")}`);
  const lp = await prisma.landingPage.create({
    data: { clientId: input.clientId, name: input.name.trim(), lpKey, allowedDomains: input.allowedDomains },
  });
  await audit(ctx, "lp.create", lp.id, lp.clientId);
  return lp;
}

export async function updateLp(ctx: Ctx, id: string, input: { name?: string; allowedDomains?: string[]; status?: LpStatus }) {
  const lp = await getLp(ctx, id);
  if (!can.manageLps(ctx, lp.clientId)) throw new ForbiddenError();
  const updated = await prisma.landingPage.update({ where: { id }, data: input });
  await audit(ctx, input.status ? `lp.${input.status}` : "lp.update", id, lp.clientId);
  return updated;
}

// ---------- Users ----------

export function listUsers(ctx: Ctx, clientId: string | null) {
  if (clientId === null ? ctx.role !== "SUPER_ADMIN" : !canSeeClient(ctx, clientId)) throw new ForbiddenError();
  return prisma.user.findMany({
    where: { clientId },
    orderBy: { name: "asc" },
    select: { id: true, name: true, email: true, role: true, status: true, lastLoginAt: true },
  });
}

const CLIENT_ROLES: Role[] = ["CLIENT_ADMIN", "CLIENT_MEMBER"];
const STAFF_ROLES: Role[] = ["SUPER_ADMIN", "ACCOUNT_MANAGER"];

export async function createUser(
  ctx: Ctx,
  input: { clientId: string | null; name: string; email: string; role: Role; password: string },
) {
  if (!can.manageUsers(ctx, input.clientId)) throw new ForbiddenError();
  const allowedRoles = input.clientId ? CLIENT_ROLES : STAFF_ROLES;
  if (!allowedRoles.includes(input.role)) throw new Error("Role not allowed for this user type");
  if (input.password.length < 10) throw new Error("Password must be at least 10 characters");
  const user = await prisma.user.create({
    data: {
      clientId: input.clientId,
      name: input.name.trim(),
      email: input.email.trim().toLowerCase(),
      role: input.role,
      passwordHash: await hashPassword(input.password),
    },
    select: { id: true, email: true },
  });
  await audit(ctx, "user.create", user.id, input.clientId);
  return user;
}

// ---------- Fields and leads ----------

export async function listFields(ctx: Ctx, lpId: string) {
  const lp = await getLp(ctx, lpId);
  const [fields, currentVersion] = await Promise.all([
    prisma.formField.findMany({ where: { lpId }, orderBy: [{ position: "asc" }, { firstSeenAt: "asc" }] }),
    lp.currentFormVersion ? prisma.formVersion.findUnique({ where: { id: lp.currentFormVersion } }) : null,
  ]);
  const current = new Set(currentVersion?.fieldKeys ?? []);
  const newSince = Date.now() - 7 * 86_400_000;
  return fields.map((f) => ({
    ...f,
    displayName: f.displayLabel || f.label,
    inCurrentForm: current.has(f.fieldKey),
    isNew: f.firstSeenAt.getTime() > newSince,
  }));
}

export type LeadFilters = { lpId?: string; clientId?: string; take?: number };

/** Newest leads in scope. The leads screen uses queryLeads (lib/leadQuery) for search, filters and sorting. */
export async function listLeads(ctx: Ctx, filters: LeadFilters = {}) {
  const { rows } = await queryLeads(ctx, {
    clientId: filters.clientId,
    lpId: filters.lpId,
    conditions: [],
    dir: "desc",
    page: 1,
    pageSize: Math.min(filters.take ?? 200, 5000),
  });
  return rows;
}

export async function getLead(ctx: Ctx, id: string) {
  const lead = await prisma.lead.findFirst({
    where: { AND: [leadWhere(ctx), { id }] },
    include: {
      lp: { select: { id: true, name: true } },
      status: true,
      owner: { select: { id: true, name: true } },
      events: { orderBy: { createdAt: "desc" }, include: { actor: { select: { name: true } } } },
      client: { select: { id: true, name: true } },
    },
  });
  if (!lead) throw new NotFoundError("Lead not found");
  return lead;
}

/**
 * Hard-deletes leads (plan §12: deletion on request, with an audit entry). Leads outside the user's
 * scope or permission are skipped. Returns the client ids touched and how many were deleted.
 */
export async function deleteLeads(ctx: Ctx, ids: string[]) {
  const unique = [...new Set(ids)].slice(0, 1000);
  if (!unique.length) return { deleted: 0, clientIds: [] as string[] };
  const leads = await prisma.lead.findMany({
    where: { AND: [leadWhere(ctx), { id: { in: unique } }] },
    select: { id: true, clientId: true, lpId: true, createdAt: true, isDuplicate: true },
  });
  const allowed = leads.filter((l) => can.deleteLeads(ctx, l.clientId));
  if (!allowed.length) {
    if (leads.length) throw new ForbiddenError();
    throw new NotFoundError("Lead not found");
  }
  const allowedIds = allowed.map((l) => l.id);
  const removedCount = await prisma.$transaction(async (tx) => {
    // Leads flagged as duplicates of a deleted lead no longer point at it.
    await tx.lead.updateMany({ where: { duplicateOfId: { in: allowedIds } }, data: { duplicateOfId: null } });
    // RETURNING gives exactly the rows this transaction removed, so a concurrent delete of the
    // same lead can't make the daily counts drop twice or log it twice.
    const removed = await tx.$queryRaw<{ id: string; clientId: string; lpId: string | null; createdAt: Date; isDuplicate: boolean }[]>`
      DELETE FROM leads WHERE id IN (${Prisma.join(allowedIds)})
      RETURNING id, client_id AS "clientId", lp_id AS "lpId", created_at AS "createdAt", is_duplicate AS "isDuplicate"`;
    await adjustDailyCounts(tx, removed, -1);
    await tx.auditLog.createMany({
      data: removed.map((l) => ({ actorId: ctx.userId, clientId: l.clientId, action: "lead.delete", target: l.id })),
    });
    return removed.length;
  });
  return { deleted: removedCount, clientIds: [...new Set(allowed.map((l) => l.clientId))] };
}

export function listStages(ctx: Ctx, clientId: string) {
  if (!canSeeClient(ctx, clientId)) throw new NotFoundError();
  return prisma.pipelineStage.findMany({ where: { clientId }, orderBy: { position: "asc" } });
}
