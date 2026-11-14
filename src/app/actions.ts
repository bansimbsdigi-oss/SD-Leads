"use server";

import { AuthError } from "next-auth";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { Prisma, type Role } from "@prisma/client";
import { headers } from "next/headers";
import { signIn, signOut } from "@/auth";
import { changeOwnPassword, loginBlockedFor, normaliseEmail, recordLogin, requestPasswordReset, resetPassword } from "@/lib/authSecurity";
import { prisma } from "@/lib/db";
import { archiveLeads, audit, createClient, createLp, createUser, deleteClient, deleteLeads, deleteMatchingLeads, emptyTrash, getLp, purgeLeads, restoreLeads, updateUser, parseDomains, rotateWebhookToken, updateLp } from "@/lib/data";
import { getCtx, requireCtx } from "@/lib/session";
import type { Condition } from "@/lib/leadFilterSpec";
import {
  createWebhookRule,
  deleteWebhookRule,
  retryDelivery,
  sendTestWebhook,
  setWebhookStatus,
  updateWebhookRule,
} from "@/lib/outbound/webhooks";
import { removeLogo, saveLogo } from "@/lib/branding";
import { hideColumn, saveHiddenColumns } from "@/lib/columnPrefs";
import { mergeColumn, renameColumn, setColumnHidden, unmergeField } from "@/lib/fieldManager";
import { addNote, assignLeads, bulkTag, clearJunk, editLeadDetails, setLeadStatus, setLeadTags } from "@/lib/leadEdit";
import { recordError, setErrorResolved } from "@/lib/errors";
import { listNotifications, markAllRead } from "@/lib/notifications";
import { parseLeadQuery } from "@/lib/leadQuery";
import { can, ForbiddenError, NotFoundError } from "@/lib/tenant";

export type ActionState = { error?: string; ok?: string } | undefined;

function errorMessage(err: unknown): string {
  if (err instanceof ForbiddenError) return "You don't have permission to do that.";
  if (err instanceof NotFoundError) return err.message;
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return "That value is already taken.";
  if (err instanceof z.ZodError) return err.issues.map((i) => i.message).join(", ");
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}

const str = (fd: FormData, key: string) => String(fd.get(key) ?? "").trim();

/** The visitor's IP (the reverse proxy puts it first in x-forwarded-for). */
async function clientIp() {
  const h = await headers();
  return (h.get("x-forwarded-for")?.split(",")[0] || h.get("x-real-ip") || "unknown").trim().slice(0, 64);
}

export async function loginAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const email = normaliseEmail(str(fd, "email")).slice(0, 200);
  const ip = await clientIp();
  const wait = await loginBlockedFor(email, ip);
  if (wait) return { error: `Too many wrong attempts. Try again in ${wait} minute${wait === 1 ? "" : "s"}, or reset your password.` };
  try {
    await signIn("credentials", { email, password: String(fd.get("password") ?? ""), redirectTo: "/" });
  } catch (err) {
    if (err instanceof AuthError) {
      await recordLogin(email, ip, false);
      return { error: "Wrong email or password." };
    }
    await recordLogin(email, ip, true);
    throw err; // NEXT_REDIRECT on success
  }
}

export async function changePasswordAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireCtx();
  try {
    await changeOwnPassword(ctx.userId, String(fd.get("current") ?? ""), String(fd.get("password") ?? ""), String(fd.get("confirm") ?? ""));
  } catch (err) {
    return { error: errorMessage(err) };
  }
  // Every session (this one too) was signed out by the change.
  redirect("/login?changed=1");
}

export async function requestResetAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const email = str(fd, "email");
  if (!z.string().email().safeParse(email).success) return { error: "Enter the email you sign in with." };
  // Same per-IP limit as sign-in, so the form can't be used to spam inboxes.
  const ip = await clientIp();
  if (await loginBlockedFor(normaliseEmail(email), ip)) return { error: "Too many attempts. Try again in a few minutes." };
  await requestPasswordReset(email, process.env.APP_URL || "http://localhost:3000");
  return { ok: "If that email has a Sabhi Leads login, a reset link is on its way. It works for 1 hour." };
}

export async function resetPasswordAction(_: ActionState, fd: FormData): Promise<ActionState> {
  try {
    await resetPassword(str(fd, "token"), String(fd.get("password") ?? ""), String(fd.get("confirm") ?? ""));
  } catch (err) {
    return { error: errorMessage(err) };
  }
  redirect("/login?reset=1");
}

export async function logoutAction() {
  await signOut({ redirectTo: "/login" });
}

export async function createClientAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireCtx();
  let id: string;
  try {
    const name = z.string().min(2, "Name is required").max(120).parse(str(fd, "name"));
    id = (await createClient(ctx, { name, slug: str(fd, "slug") })).id;
  } catch (err) {
    return { error: errorMessage(err) };
  }
  redirect(`/clients/${id}`);
}

export async function createLpAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireCtx();
  let id: string;
  try {
    const name = z.string().min(2, "Name is required").max(120).parse(str(fd, "name"));
    const allowedDomains = parseDomains(str(fd, "domains"));
    if (!allowedDomains.length) return { error: "Add at least one allowed domain." };
    id = (await createLp(ctx, { clientId: str(fd, "clientId"), name, lpKey: str(fd, "lpKey"), allowedDomains })).id;
  } catch (err) {
    return { error: errorMessage(err) };
  }
  redirect(`/lps/${id}`);
}

export async function updateLpAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireCtx();
  try {
    const id = str(fd, "id");
    const name = str(fd, "name");
    if (fd.has("name") && name.length < 2) return { error: "Name is required." };
    // Domains only matter for the lead.js snippet; webhook-only LPs can leave them empty.
    const allowedDomains = parseDomains(str(fd, "domains"));
    const status = str(fd, "status");
    const lp = await updateLp(ctx, id, {
      name: name.slice(0, 120) || undefined,
      allowedDomains,
      ...(status === "active" || status === "paused" ? { status } : {}),
    });
    revalidatePath(`/lps/${id}`);
    revalidatePath(`/clients/${lp.clientId}`);
    return { ok: "Saved." };
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

export async function toggleLpStatusAction(fd: FormData) {
  const ctx = await requireCtx();
  const id = str(fd, "id");
  const lp = await getLp(ctx, id);
  await updateLp(ctx, id, { status: lp.status === "active" ? "paused" : "active" });
  revalidatePath(`/lps/${id}`);
}

export async function createUserAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireCtx();
  try {
    const clientId = str(fd, "clientId") || null;
    const input = z
      .object({
        name: z.string().min(2, "Name is required"),
        email: z.string().email("Enter a valid email"),
        role: z.enum(["SUPER_ADMIN", "ACCOUNT_MANAGER", "CLIENT_ADMIN", "CLIENT_MEMBER"]),
        password: z.string().min(10, "Temporary password must be at least 10 characters"),
      })
      .parse({ name: str(fd, "name"), email: str(fd, "email"), role: str(fd, "role"), password: String(fd.get("password") ?? "") });
    const user = await createUser(ctx, { ...input, role: input.role as Role, clientId });

    const lpIds = fd.getAll("lpIds").map(String).filter(Boolean);
    if (clientId && lpIds.length) {
      const lps = await prisma.landingPage.findMany({ where: { id: { in: lpIds }, clientId }, select: { id: true } });
      await prisma.userLpAccess.createMany({ data: lps.map((lp) => ({ userId: user.id, lpId: lp.id })) });
    }
    const managed = fd.getAll("managedClientIds").map(String).filter(Boolean);
    if (!clientId && input.role === "ACCOUNT_MANAGER" && managed.length) {
      await prisma.clientManager.createMany({ data: managed.map((c) => ({ userId: user.id, clientId: c })) });
    }
    revalidatePath(clientId ? `/clients/${clientId}` : "/users");
    return { ok: `Created ${user.email}. Share the temporary password with them securely.` };
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

// ---------- Working leads (status, owner, tags, notes, details) ----------

type Done = { error?: string; count?: number };

async function leadAction(run: (ctx: Awaited<ReturnType<typeof requireCtx>>) => Promise<number | void>, leadId?: string): Promise<Done> {
  const ctx = await requireCtx();
  try {
    const count = await run(ctx);
    revalidatePath("/leads");
    if (leadId) revalidatePath(`/leads/${leadId}`);
    return { count: typeof count === "number" ? count : undefined };
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

export async function setLeadStatusAction(ids: string[], statusId: string | null) {
  return leadAction((ctx) => setLeadStatus(ctx, ids, statusId), ids.length === 1 ? ids[0] : undefined);
}

export async function assignLeadsAction(ids: string[], ownerId: string | null) {
  return leadAction((ctx) => assignLeads(ctx, ids, ownerId), ids.length === 1 ? ids[0] : undefined);
}

export async function setLeadTagsAction(id: string, tags: string[]) {
  return leadAction((ctx) => setLeadTags(ctx, id, tags), id);
}

export async function bulkTagAction(ids: string[], tag: string, remove = false) {
  return leadAction((ctx) => bulkTag(ctx, ids, tag, remove));
}

export async function addNoteAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const id = str(fd, "id");
  const r = await leadAction((ctx) => addNote(ctx, id, String(fd.get("text") ?? "")), id);
  return r.error ? { error: r.error } : { ok: "Note added." };
}

export async function editLeadAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const id = str(fd, "id");
  const r = await leadAction((ctx) => editLeadDetails(ctx, id, { name: str(fd, "name"), phone: str(fd, "phone"), email: str(fd, "email") }), id);
  return r.error ? { error: r.error } : { ok: "Saved." };
}

export async function updateUserAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireCtx();
  try {
    const input = z
      .object({
        name: z.string().min(2, "Name is required").max(100),
        email: z.string().email("Enter a valid email"),
        role: z.enum(["SUPER_ADMIN", "ACCOUNT_MANAGER", "CLIENT_ADMIN", "CLIENT_MEMBER"]),
        status: z.enum(["active", "disabled"]),
        password: z.string().max(200),
      })
      .parse({ name: str(fd, "name"), email: str(fd, "email"), role: str(fd, "role"), status: str(fd, "status"), password: String(fd.get("password") ?? "") });
    const { clientId } = await updateUser(ctx, str(fd, "id"), {
      ...input,
      role: input.role as Role,
      password: input.password || undefined,
      managedClientIds: fd.getAll("managedClientIds").map(String).filter(Boolean),
      lpIds: fd.getAll("lpIds").map(String).filter(Boolean),
    });
    revalidatePath(clientId ? `/clients/${clientId}` : "/users");
    return { ok: input.password ? "Saved. Share the new password with them securely." : "Saved." };
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

export async function updateFieldAction(fd: FormData) {
  const ctx = await requireCtx();
  const field = await prisma.formField.findUnique({ where: { id: str(fd, "id") }, include: { lp: true } });
  if (!field) throw new NotFoundError();
  await getLp(ctx, field.lpId); // tenant check
  if (!can.editFields(ctx, field.lp.clientId)) throw new ForbiddenError();
  const role = str(fd, "role");
  await prisma.formField.update({
    where: { id: field.id },
    data: {
      displayLabel: str(fd, "displayLabel") || null,
      role: role === "name" || role === "phone" || role === "email" ? role : null,
      isHidden: fd.get("isHidden") === "on",
    },
  });
  await audit(ctx, "field.update", field.id, field.lp.clientId);
  revalidatePath(`/lps/${field.lpId}`);
}

export async function rotateWebhookAction(fd: FormData) {
  const ctx = await requireCtx();
  const clientId = str(fd, "clientId");
  await rotateWebhookToken(ctx, clientId);
  revalidatePath(`/clients/${clientId}`);
}

/** Single lead, from the lead page. Goes back to that client's leads. */
export async function deleteLeadAction(fd: FormData) {
  const ctx = await requireCtx();
  const id = str(fd, "id");
  await deleteLeads(ctx, [id]); // to Trash; the lead page then offers Restore
  revalidatePath("/leads");
  revalidatePath(`/leads/${id}`);
}

/** Bulk delete from the leads table (checkboxes named "ids"). */
export async function deleteLeadsAction(fd: FormData) {
  const ctx = await requireCtx();
  if (fd.get("all") === "1") {
    // Every lead matching the filters, on all pages (the query string the list was showing).
    const upto = new Date(str(fd, "upto"));
    if (Number.isNaN(upto.getTime())) throw new Error("The list is out of date. Reload the page and try again.");
    await deleteMatchingLeads(ctx, parseLeadQuery(Object.fromEntries(new URLSearchParams(str(fd, "query")))), upto);
  } else if (fd.get("mode") === "purge") {
    await purgeLeads(ctx, fd.getAll("ids").map(String).filter(Boolean)); // from Trash: gone for good
  } else {
    await deleteLeads(ctx, fd.getAll("ids").map(String).filter(Boolean)); // to Trash
  }
  revalidatePath("/leads");
}

export async function restoreLeadsAction(ids: string[]) {
  return leadAction((ctx) => restoreLeads(ctx, ids), ids.length === 1 ? ids[0] : undefined);
}

export async function archiveLeadsAction(ids: string[], archive: boolean) {
  return leadAction((ctx) => archiveLeads(ctx, ids, archive), ids.length === 1 ? ids[0] : undefined);
}

export async function purgeLeadAction(id: string) {
  const r = await leadAction((ctx) => purgeLeads(ctx, [id]));
  if (!r.error) redirect("/leads?view=trash");
  return r;
}

export async function emptyTrashAction(clientId: string | null) {
  return leadAction((ctx) => emptyTrash(ctx, clientId ?? undefined));
}

export async function clearJunkAction(id: string) {
  return leadAction((ctx) => clearJunk(ctx, id), id);
}

/** The bell's list; opening it marks everything read. */
export async function notificationsAction() {
  const ctx = await requireCtx();
  const items = await listNotifications(ctx.userId);
  await markAllRead(ctx.userId);
  return items.map((n) => ({ id: n.id, type: n.type, title: n.title, body: n.body, href: n.href, unread: !n.readAt, at: n.createdAt.toISOString() }));
}

// ---------- Errors ----------

/** From the error screen in the browser (signed-in users only, so it can't be used to spam the log). */
export async function reportBrowserErrorAction(message: string, path: string) {
  const ctx = await getCtx();
  if (!ctx) return;
  const err = new Error(String(message).slice(0, 1000));
  err.stack = undefined;
  await recordError(err, { source: "browser", path: String(path).slice(0, 300), context: { userId: ctx.userId } });
}

export async function resolveErrorAction(id: string, resolved: boolean) {
  const ctx = await requireCtx();
  if (ctx.role !== "SUPER_ADMIN") throw new ForbiddenError();
  await setErrorResolved(id, resolved);
  revalidatePath("/errors");
}

// ---------- Client branding ----------

export async function saveLogoAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireCtx();
  const clientId = str(fd, "clientId");
  try {
    const file = fd.get("logo");
    if (!(file instanceof File)) return { error: "Choose an image first." };
    await saveLogo(ctx, clientId, file);
  } catch (err) {
    return { error: errorMessage(err) };
  }
  revalidatePath("/", "layout");
  return { ok: "Logo saved." };
}

export async function removeLogoAction(fd: FormData) {
  const ctx = await requireCtx();
  await removeLogo(ctx, str(fd, "clientId"));
  revalidatePath("/", "layout");
}

// ---------- Field manager ----------

async function fieldAction(clientId: string, run: (ctx: Awaited<ReturnType<typeof requireCtx>>) => Promise<unknown>): Promise<ActionState> {
  const ctx = await requireCtx();
  try {
    await run(ctx);
  } catch (err) {
    return { error: errorMessage(err) };
  }
  revalidatePath(`/clients/${clientId}/fields`);
  revalidatePath("/leads");
  return { ok: "Saved." };
}

export async function renameColumnAction(clientId: string, key: string, label: string) {
  return fieldAction(clientId, (ctx) => renameColumn(ctx, clientId, key, label));
}

export async function hideColumnFieldsAction(clientId: string, key: string, hidden: boolean) {
  return fieldAction(clientId, (ctx) => setColumnHidden(ctx, clientId, key, hidden));
}

export async function mergeColumnAction(clientId: string, from: string, into: string) {
  return fieldAction(clientId, (ctx) => mergeColumn(ctx, clientId, from, into));
}

export async function unmergeFieldAction(clientId: string, fieldId: string) {
  return fieldAction(clientId, (ctx) => unmergeField(ctx, fieldId));
}

export async function saveColumnsAction(scope: string, hidden: string[]) {
  const ctx = await requireCtx();
  await saveHiddenColumns(ctx.userId, scope, hidden);
  revalidatePath("/leads");
}

export async function hideColumnAction(scope: string, columnId: string) {
  const ctx = await requireCtx();
  await hideColumn(ctx.userId, scope, columnId);
  revalidatePath("/leads");
}

// ---------- Outbound webhooks (send leads to Pabbly) ----------

export async function saveWebhookAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireCtx();
  try {
    let conditions: Condition[] = [];
    try {
      conditions = JSON.parse(str(fd, "conditions") || "[]");
    } catch {
      return { error: "The conditions couldn't be read. Please try again." };
    }
    const input = { name: str(fd, "name"), url: str(fd, "url"), conditions };
    const id = str(fd, "id");
    const clientId = str(fd, "clientId");
    if (id) await updateWebhookRule(ctx, id, input);
    else await createWebhookRule(ctx, clientId, input);
    revalidatePath(`/clients/${clientId}`);
    return { ok: id ? "Webhook saved." : "Webhook added. New leads that match will be sent to it." };
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

export async function toggleWebhookAction(fd: FormData) {
  const ctx = await requireCtx();
  await setWebhookStatus(ctx, str(fd, "id"), str(fd, "status") === "paused" ? "paused" : "active");
  revalidatePath(`/clients/${str(fd, "clientId")}`);
}

export async function deleteWebhookAction(fd: FormData) {
  const ctx = await requireCtx();
  await deleteWebhookRule(ctx, str(fd, "id"));
  revalidatePath(`/clients/${str(fd, "clientId")}`);
}

export async function testWebhookAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireCtx();
  try {
    const r = await sendTestWebhook(ctx, str(fd, "id"));
    const what = r.usedLead ? `the latest matching lead (${r.usedLead})` : "sample data (no recent lead matches the conditions)";
    return r.ok
      ? { ok: `Test sent with ${what}. The webhook answered ${r.status} in ${r.durationMs} ms.` }
      : { error: `Test failed: ${r.error}. Check the URL in Pabbly and try again.` };
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

export async function retryDeliveryAction(fd: FormData) {
  const ctx = await requireCtx();
  await retryDelivery(ctx, str(fd, "id"));
  revalidatePath(`/clients/${str(fd, "clientId")}`);
}

export async function deleteClientAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireCtx();
  try {
    await deleteClient(ctx, str(fd, "id"), str(fd, "confirmName"));
  } catch (err) {
    return { error: errorMessage(err) };
  }
  revalidatePath("/clients");
  revalidatePath("/dashboard");
  redirect("/clients");
}
