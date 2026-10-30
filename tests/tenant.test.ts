import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { createClient, createLp, createUser, deleteClient, deleteLeads, getClient, getLead, getLp, listClients, listLeads, listLps } from "@/lib/data";
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
