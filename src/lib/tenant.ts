// Tenant scoping. Every data access takes a Ctx and goes through these filters (plan section 2).
import { Prisma, type Role } from "@prisma/client";

export type Ctx = {
  userId: string;
  role: Role;
  clientId: string | null;
  /** Clients an ACCOUNT_MANAGER is assigned to. */
  managedClientIds: string[];
  /** LPs a CLIENT_MEMBER is assigned to. */
  lpIds: string[];
};

export class NotFoundError extends Error {
  constructor(what = "Not found") {
    super(what);
  }
}

export class ForbiddenError extends Error {
  constructor(what = "Forbidden") {
    super(what);
  }
}

export const isSabhiStaff = (ctx: Ctx) => ctx.role === "SUPER_ADMIN" || ctx.role === "ACCOUNT_MANAGER";

/** Client ids this user may see; null means all clients. */
export function visibleClientIds(ctx: Ctx): string[] | null {
  switch (ctx.role) {
    case "SUPER_ADMIN":
      return null;
    case "ACCOUNT_MANAGER":
      return ctx.managedClientIds;
    default:
      return ctx.clientId ? [ctx.clientId] : [];
  }
}

export function canSeeClient(ctx: Ctx, clientId: string): boolean {
  const ids = visibleClientIds(ctx);
  return ids === null || ids.includes(clientId);
}

export function clientWhere(ctx: Ctx): Prisma.ClientWhereInput {
  const ids = visibleClientIds(ctx);
  return ids === null ? {} : { id: { in: ids } };
}

export function lpWhere(ctx: Ctx): Prisma.LandingPageWhereInput {
  const ids = visibleClientIds(ctx);
  const base: Prisma.LandingPageWhereInput = ids === null ? {} : { clientId: { in: ids } };
  return ctx.role === "CLIENT_MEMBER" && ctx.lpIds.length ? { ...base, id: { in: ctx.lpIds } } : base;
}

export function leadWhere(ctx: Ctx): Prisma.LeadWhereInput {
  const ids = visibleClientIds(ctx);
  const base: Prisma.LeadWhereInput = ids === null ? {} : { clientId: { in: ids } };
  if (ctx.role !== "CLIENT_MEMBER") return base;
  // Members work assigned leads only: owned by them, or on an LP they are assigned to.
  return {
    ...base,
    OR: [{ ownerId: ctx.userId }, ...(ctx.lpIds.length ? [{ lpId: { in: ctx.lpIds } }] : [])],
  };
}

/** Same scope as leadWhere, as SQL on `leads l`, for raw queries (sorting/filtering inside answers). */
export function leadScopeSql(ctx: Ctx): Prisma.Sql {
  const parts: Prisma.Sql[] = [];
  const ids = visibleClientIds(ctx);
  if (ids !== null) parts.push(ids.length ? Prisma.sql`l.client_id IN (${Prisma.join(ids)})` : Prisma.sql`FALSE`);
  if (ctx.role === "CLIENT_MEMBER") {
    parts.push(
      ctx.lpIds.length
        ? Prisma.sql`(l.owner_id = ${ctx.userId} OR l.lp_id IN (${Prisma.join(ctx.lpIds)}))`
        : Prisma.sql`l.owner_id = ${ctx.userId}`,
    );
  }
  return parts.length ? Prisma.join(parts, " AND ") : Prisma.sql`TRUE`;
}

export const can = {
  manageClients: (ctx: Ctx) => ctx.role === "SUPER_ADMIN",
  manageLps: (ctx: Ctx, clientId: string) =>
    ctx.role === "SUPER_ADMIN" || (ctx.role === "CLIENT_ADMIN" && ctx.clientId === clientId),
  manageUsers: (ctx: Ctx, clientId: string | null) =>
    ctx.role === "SUPER_ADMIN" || (ctx.role === "CLIENT_ADMIN" && clientId !== null && ctx.clientId === clientId),
  editFields: (ctx: Ctx, clientId: string) =>
    canSeeClient(ctx, clientId) && ctx.role !== "CLIENT_MEMBER",
  viewAudit: (ctx: Ctx) => ctx.role === "SUPER_ADMIN",
  deleteLeads: (ctx: Ctx, clientId: string) =>
    ctx.role === "SUPER_ADMIN" || (ctx.role === "CLIENT_ADMIN" && ctx.clientId === clientId),
};
