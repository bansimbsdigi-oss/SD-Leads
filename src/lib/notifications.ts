// The notification bell: stored notifications (failed webhooks, quiet landing pages, errors) plus a live
// "new leads since you last looked" count.
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { leadScopeSql, type Ctx } from "@/lib/tenant";

export type NewNotification = { type: string; title: string; body?: string; href?: string };

/** Who hears about a client: super admins, its account managers and its client admins. */
async function recipients(clientId: string | null) {
  const users = await prisma.user.findMany({
    where: {
      status: "active",
      OR: [
        { role: "SUPER_ADMIN" },
        ...(clientId ? [{ role: "ACCOUNT_MANAGER" as const, managedClients: { some: { clientId } } }, { role: "CLIENT_ADMIN" as const, clientId }] : []),
      ],
    },
    select: { id: true },
  });
  return users.map((u) => u.id);
}

/** Sends one notification to everyone responsible for the client (or super admins only, for null). */
export async function notifyClient(clientId: string | null, n: NewNotification) {
  try {
    const ids = await recipients(clientId);
    if (!ids.length) return;
    await prisma.notification.createMany({
      data: ids.map((userId) => ({ userId, clientId, type: n.type, title: n.title.slice(0, 200), body: n.body?.slice(0, 1000), href: n.href })),
    });
  } catch (err) {
    logger.error({ err, type: n.type }, "could not store notification"); // never break the caller
  }
}

export async function unreadCount(userId: string) {
  return prisma.notification.count({ where: { userId, readAt: null } });
}

export async function listNotifications(userId: string) {
  return prisma.notification.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: 30 });
}

export async function markAllRead(userId: string) {
  await prisma.notification.updateMany({ where: { userId, readAt: null }, data: { readAt: new Date() } });
}

const NEW_LEADS_CAP = 999;

/** Leads this user can see that arrived since they last opened the leads list (capped at 999). */
export async function newLeadsCount(ctx: Ctx, seenAt: Date | null) {
  const since = seenAt ?? new Date(Date.now() - 86_400_000); // first time: the last day
  const rows = await prisma.$queryRaw<{ n: number }[]>(Prisma.sql`
    SELECT count(*)::int AS n FROM (
      SELECT 1 FROM leads l WHERE ${leadScopeSql(ctx)} AND l.deleted_at IS NULL AND l.created_at > ${since.toISOString().replace("Z", "")}::timestamp
      LIMIT ${NEW_LEADS_CAP + 1}
    ) t`);
  return rows[0]?.n ?? 0;
}

export async function markLeadsSeen(userId: string) {
  await prisma.user.update({ where: { id: userId }, data: { leadsSeenAt: new Date() } });
}

// ---------- Quiet landing pages ----------

const QUIET_HOURS = 24;
const MIN_WEEKLY_LEADS = 3;

/**
 * Landing pages that usually get leads but have had none for a day: often a broken form, a paused ad or
 * an expired page. Alerts once per quiet spell (until a new lead arrives). Run hourly by the worker.
 */
export async function checkQuietLandingPages(now = new Date()) {
  const quietSince = new Date(now.getTime() - QUIET_HOURS * 3_600_000);
  const weekBefore = new Date(quietSince.getTime() - 7 * 86_400_000);
  const ts = (d: Date) => Prisma.sql`${d.toISOString().replace("Z", "")}::timestamp`;
  const quiet = await prisma.$queryRaw<{ id: string; name: string; clientId: string; clientName: string; week: number; lastLead: Date }[]>(Prisma.sql`
    SELECT p.id, p.name, p.client_id AS "clientId", c.name AS "clientName", w.week, w.last_lead AS "lastLead"
    FROM landing_pages p
    JOIN clients c ON c.id = p.client_id AND c.status = 'active'
    JOIN LATERAL (
      SELECT count(*) FILTER (WHERE l.created_at >= ${ts(weekBefore)} AND l.created_at < ${ts(quietSince)})::int AS week,
             max(l.created_at) AS last_lead
      FROM leads l WHERE l.lp_id = p.id AND l.deleted_at IS NULL AND l.created_at >= ${ts(weekBefore)}
    ) w ON TRUE
    WHERE p.status = 'active'
      AND w.week >= ${MIN_WEEKLY_LEADS}
      AND w.last_lead < ${ts(quietSince)}
      AND (p.quiet_alerted_at IS NULL OR p.quiet_alerted_at < w.last_lead)`);
  for (const lp of quiet) {
    await notifyClient(lp.clientId, {
      type: "lp_quiet",
      title: `No leads from ${lp.name} for ${QUIET_HOURS} hours`,
      body: `${lp.clientName}: it had ${lp.week} lead${lp.week === 1 ? "" : "s"} in the week before. Check the form, the page and the ads.`,
      href: `/lps/${lp.id}`,
    });
    await prisma.landingPage.update({ where: { id: lp.id }, data: { quietAlertedAt: now } });
  }
  return quiet.length;
}
