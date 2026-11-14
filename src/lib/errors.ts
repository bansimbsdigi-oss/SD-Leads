// Built-in error tracking: errors from the server, background jobs and browsers, grouped by fingerprint
// (where + message + top of the stack) with a count. Super admins get a bell alert for a new error, or
// one that comes back after being marked fixed. Recording never throws.
import { createHash } from "node:crypto";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { notifyClient } from "@/lib/notifications";

export type ErrorSource = "server" | "job" | "browser";

const clip = (s: string | undefined | null, n: number) => (s ? s.slice(0, n) : null);

/** Numbers and ids vary per occurrence; strip them so repeats group together. */
const normalise = (s: string) => s.replace(/\b(?=[a-z0-9]*\d)[a-z0-9_-]{16,}\b/gi, "<id>").replace(/\d+/g, "<n>");

export async function recordError(err: unknown, where: { source: ErrorSource; path?: string; context?: Record<string, unknown> }) {
  try {
    const e = err instanceof Error ? err : new Error(typeof err === "string" ? err : JSON.stringify(err));
    const message = clip(e.message || e.name || "Unknown error", 1000)!;
    const top = (e.stack ?? "").split("\n").slice(1, 3).join("\n");
    const path = clip(where.path?.split("?")[0], 300);
    const fingerprint = createHash("sha256").update([where.source, path ?? "", normalise(message), normalise(top)].join("|")).digest("hex");

    const existing = await prisma.errorLog.findUnique({ where: { fingerprint }, select: { id: true, resolvedAt: true } });
    if (existing) {
      await prisma.errorLog.update({ where: { fingerprint }, data: { count: { increment: 1 }, lastSeenAt: new Date(), resolvedAt: null } });
      if (!existing.resolvedAt) return; // already open and alerted
    } else {
      await prisma.errorLog.create({
        data: { fingerprint, source: where.source, message, stack: clip(e.stack, 8000), path, context: (where.context ?? {}) as object },
      });
    }
    await notifyClient(null, {
      type: "error",
      title: existing ? "An error came back" : "New error in Sabhi Leads",
      body: `${message.slice(0, 160)}${path ? ` (${path})` : ""}`,
      href: "/errors",
    });
  } catch (inner) {
    logger.error({ err: inner, original: String(err) }, "could not record error");
  }
}

export async function listErrors(show: "open" | "fixed") {
  return prisma.errorLog.findMany({
    where: show === "open" ? { resolvedAt: null } : { resolvedAt: { not: null } },
    orderBy: { lastSeenAt: "desc" },
    take: 200,
  });
}

export async function openErrorCount() {
  return prisma.errorLog.count({ where: { resolvedAt: null } });
}

export async function setErrorResolved(id: string, resolved: boolean) {
  await prisma.errorLog.update({ where: { id }, data: { resolvedAt: resolved ? new Date() : null } });
}
