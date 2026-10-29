// Resolves the signed-in user into a tenant Ctx. User status and role are re-read on every request.
import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { ForbiddenError, NotFoundError, type Ctx } from "@/lib/tenant";

export const getCtx = cache(async (): Promise<(Ctx & { name: string; email: string }) | null> => {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return null;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { managedClients: { select: { clientId: true } }, lpAccess: { select: { lpId: true } } },
  });
  if (!user || user.status !== "active") return null;
  return {
    userId: user.id,
    role: user.role,
    clientId: user.clientId,
    managedClientIds: user.managedClients.map((m) => m.clientId),
    lpIds: user.lpAccess.map((a) => a.lpId),
    name: user.name,
    email: user.email,
  };
});

export async function requireCtx() {
  const ctx = await getCtx();
  if (!ctx) redirect("/login");
  return ctx;
}

/** Runs a data-layer call, turning out-of-scope lookups into a 404 page. */
export async function orNotFound<T>(promise: Promise<T>): Promise<T> {
  try {
    return await promise;
  } catch (err) {
    if (err instanceof NotFoundError || err instanceof ForbiddenError) notFound();
    throw err;
  }
}
