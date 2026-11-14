import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { ingestPayloadSchema } from "@/lib/ingest/schema";
import { ingestLead } from "@/lib/ingest/service";
import { makeClient, makeUser, payload, resetDb } from "./helpers";

const withContact = (name: string, phone: string, email?: string) =>
  payload({ fields: [{ key: "name", role: "name", value: name }, { key: "phone", type: "tel", value: phone }, ...(email ? [{ key: "email", type: "email", value: email }] : [])] });

describe("junk leads", () => {
  beforeEach(resetDb);

  it("flags test names, made-up numbers and throwaway emails; real leads pass", async () => {
    const { junkReasons } = await import("@/lib/junk");
    expect(junkReasons({ name: "Priya Sharma", phone: "+919811122233", email: "priya@gmail.com" })).toEqual([]);
    expect(junkReasons({ name: "Test", phone: "+919999999999" })).toEqual(["Test name", "Phone looks made up"]);
    expect(junkReasons({ name: "sdfghjk" })).toEqual(["Name looks like random typing"]);
    expect(junkReasons({ name: "12345" })).toEqual(["Name is a number"]);
    expect(junkReasons({ phone: "+911234567890" })).toEqual(["Phone looks made up"]);
    expect(junkReasons({ phone: "+919898989898" })).toEqual(["Phone looks made up"]);
    expect(junkReasons({ email: "a@mailinator.com" })).toEqual(["Throwaway or test email"]);
    expect(junkReasons({ email: "test@company.in" })).toEqual(["Test email"]);
  });

  it("new leads get flagged; Hide junk filters them; Not junk clears the flag", async () => {
    const { clearJunk } = await import("@/lib/leadEdit");
    const { queryLeads } = await import("@/lib/leadQuery");
    const { lp } = await makeClient("alpha");
    const real = (await ingestLead(lp, ingestPayloadSchema.parse(withContact("Priya Sharma", "9811122233")))).leadId;
    const junk = (await ingestLead(lp, ingestPayloadSchema.parse(withContact("asdf", "9999999999")))).leadId;
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: junk } })).junkReasons).toEqual(["Test name", "Phone looks made up"]);
    const admin = await makeUser("SUPER_ADMIN", null);
    const base = { conditions: [], dir: "desc" as const, page: 1, pageSize: 25 };
    expect((await queryLeads(admin, { ...base, hideJunk: true })).rows.map((r) => r.id)).toEqual([real]);
    await clearJunk(admin, junk);
    expect((await queryLeads(admin, { ...base, hideJunk: true })).total).toBe(2);
  });
});

describe("notification bell", () => {
  beforeEach(resetDb);

  it("goes to super admins, the client's account managers and client admins only", async () => {
    const { notifyClient, unreadCount, listNotifications, markAllRead } = await import("@/lib/notifications");
    const a = await makeClient("alpha");
    const b = await makeClient("beta");
    const sa = await makeUser("SUPER_ADMIN", null);
    const amA = await makeUser("ACCOUNT_MANAGER", null);
    await prisma.clientManager.create({ data: { userId: amA.userId, clientId: a.client.id } });
    const amB = await makeUser("ACCOUNT_MANAGER", null);
    await prisma.clientManager.create({ data: { userId: amB.userId, clientId: b.client.id } });
    const adminA = await makeUser("CLIENT_ADMIN", a.client.id);
    const memberA = await makeUser("CLIENT_MEMBER", a.client.id);

    await notifyClient(a.client.id, { type: "lp_quiet", title: "Quiet" });
    const counts = await Promise.all([sa, amA, amB, adminA, memberA].map((u) => unreadCount(u.userId)));
    expect(counts).toEqual([1, 1, 0, 1, 0]);
    expect((await listNotifications(adminA.userId))[0].title).toBe("Quiet");
    await markAllRead(adminA.userId);
    expect(await unreadCount(adminA.userId)).toBe(0);
  });

  it("counts new leads since the user last opened Leads", async () => {
    const { markLeadsSeen, newLeadsCount } = await import("@/lib/notifications");
    const { lp } = await makeClient("alpha");
    const admin = await makeUser("SUPER_ADMIN", null);
    await ingestLead(lp, ingestPayloadSchema.parse(withContact("A", "9811100001")));
    expect(await newLeadsCount(admin, null)).toBe(1);
    await markLeadsSeen(admin.userId);
    const seen = (await prisma.user.findUniqueOrThrow({ where: { id: admin.userId } })).leadsSeenAt;
    expect(await newLeadsCount(admin, seen)).toBe(0);
    await ingestLead(lp, ingestPayloadSchema.parse(withContact("B", "9811100002")));
    expect(await newLeadsCount(admin, seen)).toBe(1);
  });

  it("alerts once when a busy landing page goes quiet for a day, again only after it got leads", async () => {
    const { checkQuietLandingPages, unreadCount } = await import("@/lib/notifications");
    const { lp } = await makeClient("alpha");
    const sa = await makeUser("SUPER_ADMIN", null);
    const now = new Date();
    for (let i = 0; i < 3; i++) {
      const id = (await ingestLead(lp, ingestPayloadSchema.parse(withContact(`L${i}`, `98111000${10 + i}`)))).leadId;
      await prisma.lead.update({ where: { id }, data: { createdAt: new Date(now.getTime() - (2 + i) * 86_400_000) } });
    }
    expect(await checkQuietLandingPages(now)).toBe(1);
    expect(await unreadCount(sa.userId)).toBe(1);
    expect(await checkQuietLandingPages(new Date(now.getTime() + 3_600_000))).toBe(0); // already alerted
    // A page with too few leads to judge isn't alerted.
    const other = await makeClient("beta");
    const one = (await ingestLead(other.lp, ingestPayloadSchema.parse(withContact("Solo", "9811100099")))).leadId;
    await prisma.lead.update({ where: { id: one }, data: { createdAt: new Date(now.getTime() - 2 * 86_400_000) } });
    expect(await checkQuietLandingPages(now)).toBe(0);
  });

  it("a webhook that fails its last try notifies the client's people", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    try {
      const { createWebhookRule, deliverLead, DELIVERY_ATTEMPTS } = await import("@/lib/outbound/webhooks");
      const { unreadCount } = await import("@/lib/notifications");
      const { client, lp } = await makeClient("alpha");
      const admin = await makeUser("CLIENT_ADMIN", client.id);
      const ruleId = await createWebhookRule(admin, client.id, { name: "Pabbly", url: "https://93.184.216.34/hook", conditions: [] });
      const leadId = (await ingestLead(lp, ingestPayloadSchema.parse(withContact("A", "9811100001")))).leadId;
      await expect(deliverLead(ruleId, leadId, 1)).rejects.toThrow();
      expect(await unreadCount(admin.userId)).toBe(0); // retries left: no alert yet
      await expect(deliverLead(ruleId, leadId, DELIVERY_ATTEMPTS)).rejects.toThrow();
      expect(await unreadCount(admin.userId)).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("error tracking", () => {
  beforeEach(resetDb);

  it("groups repeats, alerts super admins once, and again only if a fixed error comes back", async () => {
    const { listErrors, openErrorCount, recordError, setErrorResolved } = await import("@/lib/errors");
    const { unreadCount, markAllRead } = await import("@/lib/notifications");
    await prisma.errorLog.deleteMany();
    const sa = await makeUser("SUPER_ADMIN", null);
    const { client } = await makeClient("alpha");
    const clientAdmin = await makeUser("CLIENT_ADMIN", client.id);

    // Same error with different ids in the message: one group.
    await recordError(new Error("Lead cmabc12345678901234567890 not found"), { source: "server", path: "/leads/x?y=1" });
    await recordError(new Error("Lead cmzzz98765432109876543210 not found"), { source: "server", path: "/leads/x" });
    const [e] = await listErrors("open");
    expect([e.count, e.path, await openErrorCount()]).toEqual([2, "/leads/x", 1]);
    expect(await unreadCount(sa.userId)).toBe(1);
    expect(await unreadCount(clientAdmin.userId)).toBe(0); // app errors are for super admins

    await markAllRead(sa.userId);
    await setErrorResolved(e.id, true);
    expect(await openErrorCount()).toBe(0);
    await recordError(new Error("Lead cm00000000000000000000000 not found"), { source: "server", path: "/leads/x" });
    expect(await openErrorCount()).toBe(1); // came back
    expect(await unreadCount(sa.userId)).toBe(1);

    await recordError("something odd", { source: "browser", path: "/dashboard" }); // non-Error values are fine too
    expect(await openErrorCount()).toBe(2);
  });
});
