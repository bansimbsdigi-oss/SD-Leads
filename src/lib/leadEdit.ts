// Working leads: status, owner, tags, notes and correcting contact details. Every change is checked
// against the user's lead scope and recorded on the lead's timeline.
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { normaliseEmail, normalisePhone } from "@/lib/ingest/normalise";
import { buildSearchText } from "@/lib/ingest/searchText";
import { canSeeClient, ForbiddenError, isSabhiStaff, leadWhere, NotFoundError, type Ctx } from "@/lib/tenant";

const MAX_BULK = 1000;
const MAX_TAGS = 20;
const MAX_TAG_LENGTH = 40;
const MAX_NOTE = 5000;

/** Assigning an owner is for admins and Sabhi staff; members work the leads they're given. */
export const canAssign = (ctx: Ctx) => ctx.role !== "CLIENT_MEMBER";

/** Leads (by id) this user may work on. Throws when none of them are. */
async function editableLeads(ctx: Ctx, ids: string[]) {
  const unique = [...new Set(ids)].slice(0, MAX_BULK);
  const leads = unique.length
    ? await prisma.lead.findMany({ where: { AND: [leadWhere(ctx), { id: { in: unique } }] }, select: { id: true, clientId: true, statusId: true, ownerId: true, tags: true } })
    : [];
  if (!leads.length) throw new NotFoundError("Lead not found");
  return leads;
}

const touch = { lastActivityAt: new Date() };

/** Sets the status (a pipeline stage of each lead's own client; null clears it). */
export async function setLeadStatus(ctx: Ctx, ids: string[], statusId: string | null) {
  const leads = await editableLeads(ctx, ids);
  const stage = statusId ? await prisma.pipelineStage.findUnique({ where: { id: statusId } }) : null;
  if (statusId && !stage) throw new NotFoundError("Status not found");
  const target = leads.filter((l) => (!stage || l.clientId === stage.clientId) && l.statusId !== statusId);
  if (stage && !leads.some((l) => l.clientId === stage.clientId)) throw new Error("That status belongs to a different client.");
  if (!target.length) return 0;
  await prisma.$transaction([
    prisma.lead.updateMany({ where: { id: { in: target.map((l) => l.id) } }, data: { statusId, ...touch } }),
    prisma.leadEvent.createMany({
      data: target.map((l) => ({ leadId: l.id, type: "status_changed" as const, actorId: ctx.userId, payload: { to: stage?.name ?? null } })),
    }),
  ]);
  return target.length;
}

/** People a lead of this client can be assigned to: its own users plus Sabhi staff who look after it. */
export async function ownerOptions(clientId: string) {
  const users = await prisma.user.findMany({
    where: {
      status: "active",
      OR: [{ clientId }, { role: "SUPER_ADMIN" }, { role: "ACCOUNT_MANAGER", managedClients: { some: { clientId } } }],
    },
    orderBy: { name: "asc" },
    select: { id: true, name: true, clientId: true },
  });
  return users.map((u) => ({ id: u.id, name: u.clientId ? u.name : `${u.name} (Sabhi)` }));
}

export async function assignLeads(ctx: Ctx, ids: string[], ownerId: string | null) {
  if (!canAssign(ctx)) throw new ForbiddenError();
  const leads = await editableLeads(ctx, ids);
  let ownerName: string | null = null;
  let allowedClients: Set<string> | null = null;
  if (ownerId) {
    const owner = await prisma.user.findUnique({ where: { id: ownerId }, include: { managedClients: { select: { clientId: true } } } });
    if (!owner || owner.status !== "active") throw new NotFoundError("User not found");
    ownerName = owner.name;
    const clients = [...new Set(leads.map((l) => l.clientId))];
    allowedClients = new Set(
      clients.filter((c) =>
        owner.role === "SUPER_ADMIN" ||
        owner.clientId === c ||
        (owner.role === "ACCOUNT_MANAGER" && owner.managedClients.some((m) => m.clientId === c)),
      ),
    );
    if (!allowedClients.size) throw new Error(`${owner.name} can't be given these leads.`);
  }
  const target = leads.filter((l) => (!allowedClients || allowedClients.has(l.clientId)) && l.ownerId !== ownerId);
  if (!target.length) return 0;
  await prisma.$transaction([
    prisma.lead.updateMany({ where: { id: { in: target.map((l) => l.id) } }, data: { ownerId, ...touch } }),
    prisma.leadEvent.createMany({
      data: target.map((l) => ({ leadId: l.id, type: "assigned" as const, actorId: ctx.userId, payload: { to: ownerName } })),
    }),
  ]);
  return target.length;
}

/** "  vip " -> "VIP"-style cleanup: trimmed, single spaces, length-capped; empty tags dropped. */
export function cleanTags(tags: string[]): string[] {
  const out: string[] = [];
  for (const raw of tags) {
    const t = raw.replace(/\s+/g, " ").trim().slice(0, MAX_TAG_LENGTH);
    if (t && !out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
  }
  return out.slice(0, MAX_TAGS);
}

/** Replaces one lead's tags. */
export async function setLeadTags(ctx: Ctx, id: string, tags: string[]) {
  const [lead] = await editableLeads(ctx, [id]);
  const next = cleanTags(tags);
  if (next.join("\n") === lead.tags.join("\n")) return;
  await prisma.$transaction([
    prisma.lead.update({ where: { id }, data: { tags: next, ...touch } }),
    prisma.leadEvent.create({ data: { leadId: id, type: "tags_changed", actorId: ctx.userId, payload: { tags: next } } }),
  ]);
}

/** Adds (or removes) one tag on many leads. */
export async function bulkTag(ctx: Ctx, ids: string[], tag: string, remove = false) {
  const [clean] = cleanTags([tag]);
  if (!clean) throw new Error("Type a tag first.");
  const leads = await editableLeads(ctx, ids);
  const has = (l: { tags: string[] }) => l.tags.some((t) => t.toLowerCase() === clean.toLowerCase());
  const target = leads.filter((l) => (remove ? has(l) : !has(l) && l.tags.length < MAX_TAGS));
  if (!target.length) return 0;
  await prisma.$transaction(
    target.flatMap((l) => {
      const tags = remove ? l.tags.filter((t) => t.toLowerCase() !== clean.toLowerCase()) : [...l.tags, clean];
      return [
        prisma.lead.update({ where: { id: l.id }, data: { tags, ...touch } }),
        prisma.leadEvent.create({ data: { leadId: l.id, type: "tags_changed", actorId: ctx.userId, payload: { tags } } }),
      ];
    }),
  );
  return target.length;
}

/** Tags already used on this client's leads (most used first), for suggestions. */
export async function tagSuggestions(ctx: Ctx, clientId: string) {
  if (!canSeeClient(ctx, clientId)) return [];
  const rows = await prisma.$queryRaw<{ tag: string }[]>(Prisma.sql`
    SELECT t AS tag FROM leads l CROSS JOIN LATERAL unnest(l.tags) t
    WHERE l.client_id = ${clientId} AND cardinality(l.tags) > 0
    GROUP BY t ORDER BY count(*) DESC, t LIMIT 30`);
  return rows.map((r) => r.tag);
}

export async function addNote(ctx: Ctx, id: string, text: string) {
  const body = text.trim().slice(0, MAX_NOTE);
  if (!body) throw new Error("Write something first.");
  await editableLeads(ctx, [id]);
  await prisma.$transaction([
    prisma.leadEvent.create({ data: { leadId: id, type: "note", actorId: ctx.userId, payload: { text: body } } }),
    prisma.lead.update({ where: { id }, data: touch }),
  ]);
}

/** "Not junk": clears the fake-lead flags someone checked by hand. */
export async function clearJunk(ctx: Ctx, id: string) {
  await editableLeads(ctx, [id]);
  const lead = await prisma.lead.findUniqueOrThrow({ where: { id }, select: { junkReasons: true } });
  if (!lead.junkReasons.length) return;
  await prisma.$transaction([
    prisma.lead.update({ where: { id }, data: { junkReasons: [] } }),
    prisma.leadEvent.create({ data: { leadId: id, type: "edited", actorId: ctx.userId, payload: { changes: { junk: { from: lead.junkReasons.join(", "), to: "Marked as not junk" } } } } }),
  ]);
}

/** Corrects name / phone / email. Phone and email must be valid when given; blank clears them. */
export async function editLeadDetails(ctx: Ctx, id: string, input: { name: string; phone: string; email: string }) {
  await editableLeads(ctx, [id]);
  const lead = await prisma.lead.findUniqueOrThrow({ where: { id } });
  const name = input.name.replace(/\s+/g, " ").trim().slice(0, 200) || null;
  const phone = input.phone.trim() ? normalisePhone(input.phone) : null;
  if (input.phone.trim() && !phone) throw new Error("That phone number doesn't look right. Include the country code if it isn't Indian.");
  const email = input.email.trim() ? normaliseEmail(input.email) : null;
  if (input.email.trim() && !email) throw new Error("That email doesn't look right.");

  const changes: Record<string, { from: string | null; to: string | null }> = {};
  if (name !== lead.name) changes.name = { from: lead.name, to: name };
  if (phone !== lead.phoneNormalised) changes.phone = { from: lead.phoneNormalised, to: phone };
  if (email !== lead.emailNormalised) changes.email = { from: lead.emailNormalised, to: email };
  if (!Object.keys(changes).length) return;

  await prisma.$transaction([
    prisma.lead.update({
      where: { id },
      data: {
        name,
        phoneNormalised: phone,
        emailNormalised: email,
        searchText: buildSearchText({ name, phone, email, answers: lead.answers as Record<string, unknown> }),
        ...touch,
      },
    }),
    prisma.leadEvent.create({ data: { leadId: id, type: "edited", actorId: ctx.userId, payload: { changes } } }),
  ]);
}

/** Statuses and owners per client, for the dropdowns in the leads table (only clients in view). */
export async function editOptions(ctx: Ctx, clientIds: string[]) {
  const ids = [...new Set(clientIds)].filter((c) => canSeeClient(ctx, c));
  const [stages, owners] = await Promise.all([
    prisma.pipelineStage.findMany({ where: { clientId: { in: ids } }, orderBy: { position: "asc" }, select: { id: true, name: true, clientId: true } }),
    canAssign(ctx) ? Promise.all(ids.map(async (c) => [c, await ownerOptions(c)] as const)) : Promise.resolve([]),
  ]);
  const stagesBy: Record<string, { id: string; name: string }[]> = {};
  for (const s of stages) (stagesBy[s.clientId] ??= []).push({ id: s.id, name: s.name });
  return { stages: stagesBy, owners: Object.fromEntries(owners) as Record<string, { id: string; name: string }[]>, canAssign: canAssign(ctx), staff: isSabhiStaff(ctx) };
}
