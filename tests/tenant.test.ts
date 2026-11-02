import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { createClient, createLp, createUser, deleteClient, deleteLeads, deleteMatchingLeads, getClient, updateUser, getLead, getLp, listClients, listLeads, listLps } from "@/lib/data";
import { ingestPayloadSchema } from "@/lib/ingest/schema";
import { ingestLead } from "@/lib/ingest/service";
import { ForbiddenError, NotFoundError } from "@/lib/tenant";
import { makeClient, makeUser, payload, resetDb } from "./helpers";

describe("tenant isolation", () => {
  beforeEach(resetDb);

  async function twoClients() {
    const a = await makeClient("alpha");
    const b = await makeClient("beta");
    const leadA = await ingestLead(a.lp, ingestPayloadSchema.parse(payload()));
    const leadB = await ingestLead(b.lp, ingestPayloadSchema.parse(payload()));
    return { a, b, leadA: leadA.leadId, leadB: leadB.leadId };
  }

  it("client A admin sees only client A clients, LPs and leads", async () => {
    const { a, b, leadA, leadB } = await twoClients();
    const ctx = await makeUser("CLIENT_ADMIN", a.client.id);
    expect((await listClients(ctx)).map((c) => c.id)).toEqual([a.client.id]);
    expect((await listLps(ctx)).map((l) => l.id)).toEqual([a.lp.id]);
    expect((await listLeads(ctx)).map((l) => l.id)).toEqual([leadA]);
    // Even when asking for client B explicitly.
    expect(await listLeads(ctx, { clientId: b.client.id })).toEqual([]);
    expect(await listLeads(ctx, { lpId: b.lp.id })).toEqual([]);
    await expect(getClient(ctx, b.client.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getLp(ctx, b.lp.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getLead(ctx, leadB)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("client admin cannot create LPs or users for another client", async () => {
    const { a, b } = await twoClients();
    const ctx = await makeUser("CLIENT_ADMIN", a.client.id);
    await expect(createLp(ctx, { clientId: b.client.id, name: "x", allowedDomains: ["x.com"] })).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      createUser(ctx, { clientId: b.client.id, name: "x", email: "x@x.test", role: "CLIENT_ADMIN", password: "longenough123" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      createUser(ctx, { clientId: a.client.id, name: "x", email: "y@x.test", role: "SUPER_ADMIN", password: "longenough123" }),
    ).rejects.toThrow();
    await expect(createClient(ctx, { name: "New co" })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("account manager sees only assigned clients", async () => {
    const { a, leadA } = await twoClients();
    const ctx = await makeUser("ACCOUNT_MANAGER", null, { managedClientIds: [a.client.id] });
    expect((await listClients(ctx)).map((c) => c.id)).toEqual([a.client.id]);
    expect((await listLeads(ctx)).map((l) => l.id)).toEqual([leadA]);
  });

  it("client member sees only owned leads or leads on assigned LPs", async () => {
    const { a, leadA } = await twoClients();
    const unassigned = await makeUser("CLIENT_MEMBER", a.client.id);
    expect(await listLeads(unassigned)).toEqual([]);
    const assigned = await makeUser("CLIENT_MEMBER", a.client.id, { lpIds: [a.lp.id] });
    expect((await listLeads(assigned)).map((l) => l.id)).toEqual([leadA]);
  });

  it("super admin sees everything", async () => {
    await twoClients();
    const ctx = await makeUser("SUPER_ADMIN", null);
    expect(await listClients(ctx)).toHaveLength(2);
    expect(await listLeads(ctx)).toHaveLength(2);
  });
});

describe("lead deletion", () => {
  beforeEach(resetDb);

  it("client admin deletes own leads only; members and account managers cannot delete", async () => {
    const a = await makeClient("alpha");
    const b = await makeClient("beta");
    const leadA = (await ingestLead(a.lp, ingestPayloadSchema.parse(payload()))).leadId;
    const leadB = (await ingestLead(b.lp, ingestPayloadSchema.parse(payload()))).leadId;

    const adminA = await makeUser("CLIENT_ADMIN", a.client.id);
    await expect(deleteLeads(adminA, [leadB])).rejects.toBeInstanceOf(NotFoundError);
    const member = await makeUser("CLIENT_MEMBER", a.client.id, { lpIds: [a.lp.id] });
    await expect(deleteLeads(member, [leadA])).rejects.toBeInstanceOf(ForbiddenError);
    const am = await makeUser("ACCOUNT_MANAGER", null, { managedClientIds: [a.client.id] });
    await expect(deleteLeads(am, [leadA])).rejects.toBeInstanceOf(ForbiddenError);

    // Mixed batch: only the in-scope lead goes.
    expect((await deleteLeads(adminA, [leadA, leadB])).deleted).toBe(1);
    expect(await prisma.lead.findUnique({ where: { id: leadA } })).toBeNull();
    expect(await prisma.lead.findUnique({ where: { id: leadB } })).not.toBeNull();
    expect(await prisma.auditLog.count({ where: { action: "lead.delete", target: leadA } })).toBe(1);
  });

  it("select all leads (every page) deletes only what matches, in scope, loaded before", async () => {
    const { parseLeadQuery } = await import("@/lib/leadQuery");
    const a = await makeClient("alpha");
    const b = await makeClient("beta");
    const named = (name: string, phone: string) =>
      payload({ fields: [{ key: "name", type: "text", label: "Name", role: "name", value: name }, { key: "phone", type: "tel", label: "Mobile", role: "phone", value: phone }] });
    for (const [n, p] of [["Ravi One", "9876500101"], ["Ravi Two", "9876500102"], ["Meena", "9876500103"]]) await ingestLead(a.lp, ingestPayloadSchema.parse(named(n, p)));
    await ingestLead(b.lp, ingestPayloadSchema.parse(named("Ravi Beta", "9876500104")));
    const upto = new Date();
    await new Promise((r) => setTimeout(r, 5));
    const late = (await ingestLead(a.lp, ingestPayloadSchema.parse(named("Ravi Late", "9876500105")))).leadId;

    // Client admin of alpha, search "ravi", all pages: both alpha Ravis go; beta's and the late one stay.
    const adminA = await makeUser("CLIENT_ADMIN", a.client.id);
    expect((await deleteMatchingLeads(adminA, parseLeadQuery({ q: "ravi" }), upto)).deleted).toBe(2);
    const left = await prisma.lead.findMany({ select: { name: true }, orderBy: { name: "asc" } });
    expect(left.map((l) => l.name)).toEqual(["Meena", "Ravi Beta", "Ravi Late"]);
    expect(await prisma.lead.findUnique({ where: { id: late } })).not.toBeNull();

    // A member can't delete at all.
    const member = await makeUser("CLIENT_MEMBER", a.client.id, { lpIds: [a.lp.id] });
    await expect(deleteMatchingLeads(member, parseLeadQuery({}), new Date())).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("clears duplicate links pointing at a deleted lead", async () => {
    const { client, lp } = await makeClient("alpha");
    const first = (await ingestLead(lp, ingestPayloadSchema.parse(payload()))).leadId;
    const dupe = (await ingestLead(lp, ingestPayloadSchema.parse(payload()))).leadId;
    await deleteLeads(await makeUser("SUPER_ADMIN", null), [first]);
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: dupe } })).duplicateOfId).toBeNull();
    expect(await prisma.lead.count({ where: { clientId: client.id } })).toBe(1);
  });
});

describe("client deletion", () => {
  beforeEach(resetDb);

  it("only super admins can delete, and only with the client's name typed", async () => {
    const a = await makeClient("alpha");
    const clientAdmin = await makeUser("CLIENT_ADMIN", a.client.id);
    const am = await makeUser("ACCOUNT_MANAGER", null, { managedClientIds: [a.client.id] });
    await expect(deleteClient(clientAdmin, a.client.id, "alpha")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(deleteClient(am, a.client.id, "alpha")).rejects.toBeInstanceOf(ForbiddenError);
    const admin = await makeUser("SUPER_ADMIN", null);
    await expect(deleteClient(admin, a.client.id, "alph")).rejects.toThrow(/Type the client's name/);
    expect(await prisma.client.count({ where: { id: a.client.id } })).toBe(1);
  });

  it("removes the client and everything under it, and nothing of other clients", async () => {
    const a = await makeClient("alpha");
    const b = await makeClient("beta");
    await ingestLead(a.lp, ingestPayloadSchema.parse(payload()));
    await ingestLead(a.lp, ingestPayloadSchema.parse(payload()));
    await ingestLead(b.lp, ingestPayloadSchema.parse(payload()));
    await makeUser("CLIENT_ADMIN", a.client.id);
    const admin = await makeUser("SUPER_ADMIN", null);

    const res = await deleteClient(admin, a.client.id, " ALPHA ");
    expect(res).toEqual({ name: "alpha", leadCount: 2 });
    expect(await prisma.client.count({ where: { id: a.client.id } })).toBe(0);
    expect(await prisma.lead.count({ where: { clientId: a.client.id } })).toBe(0);
    expect(await prisma.landingPage.count({ where: { clientId: a.client.id } })).toBe(0);
    expect(await prisma.user.count({ where: { clientId: a.client.id } })).toBe(0);
    expect(await prisma.leadDailyCount.count({ where: { clientId: a.client.id } })).toBe(0);
    expect(await prisma.lead.count({ where: { clientId: b.client.id } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: "client.delete" } })).toBe(1);
  });
});

describe("editing users", () => {
  beforeEach(resetDb);

  const base = { name: "Yuvraj", email: "yuvraj@sabhi.test", status: "active" as const };

  it("super admin edits a staff login: details, role, clients, password, disable", async () => {
    const { verifyPassword } = await import("@/lib/password");
    const a = await makeClient("alpha");
    const b = await makeClient("beta");
    const admin = await makeUser("SUPER_ADMIN", null);
    const am = await makeUser("ACCOUNT_MANAGER", null);
    await prisma.clientManager.create({ data: { userId: am.userId, clientId: a.client.id } });

    await updateUser(admin, am.userId, { ...base, role: "ACCOUNT_MANAGER", managedClientIds: [b.client.id], password: "new-password-123" });
    let u = await prisma.user.findUniqueOrThrow({ where: { id: am.userId }, include: { managedClients: true } });
    expect([u.name, u.email, u.managedClients.map((m) => m.clientId)]).toEqual(["Yuvraj", "yuvraj@sabhi.test", [b.client.id]]);
    expect(await verifyPassword(u.passwordHash, "new-password-123")).toBe(true);

    // Promoted to super admin: client assignments no longer apply. Blank password keeps it.
    await updateUser(admin, am.userId, { ...base, role: "SUPER_ADMIN", status: "disabled" });
    u = await prisma.user.findUniqueOrThrow({ where: { id: am.userId }, include: { managedClients: true } });
    expect([u.role, u.status, u.managedClients.length]).toEqual(["SUPER_ADMIN", "disabled", 0]);
    expect(await verifyPassword(u.passwordHash, "new-password-123")).toBe(true);
    expect(await prisma.auditLog.count({ where: { action: { startsWith: "user.update" }, target: am.userId } })).toBe(2);
  });

  it("guards: no self lock-out, always one super admin, unique email, staff roles only", async () => {
    const admin = await makeUser("SUPER_ADMIN", null);
    const self = await prisma.user.findUniqueOrThrow({ where: { id: admin.userId } });
    await expect(updateUser(admin, admin.userId, { name: "Me", email: self.email, role: "ACCOUNT_MANAGER", status: "active" })).rejects.toThrow(/own role/);
    await expect(updateUser(admin, admin.userId, { name: "Me", email: self.email, role: "SUPER_ADMIN", status: "disabled" })).rejects.toThrow(/own role/);
    await updateUser(admin, admin.userId, { name: "Me renamed", email: self.email, role: "SUPER_ADMIN", status: "active" }); // details are fine

    const other = await makeUser("SUPER_ADMIN", null);
    await prisma.user.update({ where: { id: other.userId }, data: { status: "disabled" } });
    const am = await makeUser("ACCOUNT_MANAGER", null);
    const amUser = await prisma.user.findUniqueOrThrow({ where: { id: am.userId } });
    await expect(updateUser(admin, am.userId, { name: "AM", email: self.email, role: "ACCOUNT_MANAGER", status: "active" })).rejects.toThrow(/already uses/);
    await expect(updateUser(admin, am.userId, { name: "AM", email: amUser.email, role: "CLIENT_ADMIN", status: "active" })).rejects.toThrow(/not allowed/);
    // A second super admin (the AM, promoted) can't demote the first when it'd leave none active... the first is still active, so this is fine:
    await updateUser(admin, am.userId, { name: "AM", email: amUser.email, role: "SUPER_ADMIN", status: "active" });
    const amNow = { ...am, role: "SUPER_ADMIN" as const }; // roles are re-read per request in the app
    await updateUser(amNow, admin.userId, { name: "Me", email: self.email, role: "ACCOUNT_MANAGER", status: "active" });
    // Now `am` is the only active super admin; nobody can remove that.
    const third = await makeUser("SUPER_ADMIN", null);
    await prisma.user.update({ where: { id: third.userId }, data: { status: "disabled" } });
    await expect(updateUser(third, am.userId, { name: "AM", email: amUser.email, role: "ACCOUNT_MANAGER", status: "active" })).rejects.toThrow(/only active super admin/);
  });

  it("client admin edits only their own client's users; members get LP access of that client only", async () => {
    const a = await makeClient("alpha");
    const b = await makeClient("beta");
    const adminA = await makeUser("CLIENT_ADMIN", a.client.id);
    const memberA = await makeUser("CLIENT_MEMBER", a.client.id);
    const memberB = await makeUser("CLIENT_MEMBER", b.client.id);
    await updateUser(adminA, memberA.userId, { name: "Asha", email: "asha@alpha.test", role: "CLIENT_MEMBER", status: "active", lpIds: [a.lp.id, b.lp.id] });
    expect((await prisma.userLpAccess.findMany({ where: { userId: memberA.userId } })).map((x) => x.lpId)).toEqual([a.lp.id]);
    await expect(updateUser(adminA, memberB.userId, { name: "X", email: "x@b.test", role: "CLIENT_MEMBER", status: "active" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(updateUser(adminA, memberA.userId, { name: "Asha", email: "asha@alpha.test", role: "SUPER_ADMIN", status: "active" })).rejects.toThrow(/not allowed/);
    await expect(updateUser(memberA, adminA.userId, { name: "A", email: "a@alpha.test", role: "CLIENT_ADMIN", status: "active" })).rejects.toBeInstanceOf(ForbiddenError);
  });
});
