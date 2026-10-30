"use server";

import { AuthError } from "next-auth";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { Prisma, type Role } from "@prisma/client";
import { signIn, signOut } from "@/auth";
import { prisma } from "@/lib/db";
import { audit, createClient, createLp, createUser, deleteLeads, getLp, parseDomains, rotateWebhookToken, updateLp } from "@/lib/data";
import { requireCtx } from "@/lib/session";
import type { Condition } from "@/lib/leadFilterSpec";
import {
  createWebhookRule,
  deleteWebhookRule,
  retryDelivery,
  sendTestWebhook,
  setWebhookStatus,
  updateWebhookRule,
} from "@/lib/outbound/webhooks";
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

export async function loginAction(_: ActionState, fd: FormData): Promise<ActionState> {
  try {
    await signIn("credentials", { email: str(fd, "email"), password: String(fd.get("password") ?? ""), redirectTo: "/" });
  } catch (err) {
    if (err instanceof AuthError) return { error: "Wrong email or password." };
    throw err; // NEXT_REDIRECT on success
  }
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
  const { clientIds } = await deleteLeads(ctx, [str(fd, "id")]);
  revalidatePath("/leads");
  redirect(clientIds[0] && ctx.role === "SUPER_ADMIN" ? `/leads?client=${clientIds[0]}` : "/leads");
}

/** Bulk delete from the leads table (checkboxes named "ids"). */
export async function deleteLeadsAction(fd: FormData) {
  const ctx = await requireCtx();
  await deleteLeads(ctx, fd.getAll("ids").map(String).filter(Boolean));
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
