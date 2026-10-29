import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { dashboardCounts, dashboardTrend } from "@/lib/dashboard";
import { NotFoundError } from "@/lib/tenant";
import { deleteLeads } from "@/lib/data";
import { rebuildDailyCounts } from "@/lib/dailyCounts";
import { ingestPayloadSchema } from "@/lib/ingest/schema";
import { ingestLead } from "@/lib/ingest/service";
import { makeClient, makeUser, payload, resetDb } from "./helpers";

async function lead(lp: { id: string; clientId: string; currentFormVersion: string | null }, daysAgo = 0, phone = String(9000000000 + Math.floor(Math.random() * 1e9))) {
  const p = payload();
  p.fields[1] = { ...p.fields[1], value: phone };
  const r = await ingestLead(lp, ingestPayloadSchema.parse(p));
  if (daysAgo) await prisma.lead.update({ where: { id: r.leadId }, data: { createdAt: new Date(Date.now() - daysAgo * 86_400_000) } });
  return r.leadId;
}

describe("dashboard counts", () => {
  beforeEach(resetDb);

  it("counts leads per client for each window, sorted, including clients with none", async () => {
    const a = await makeClient("alpha");
    const b = await makeClient("beta");
    await makeClient("gamma");
    await lead(a.lp);
    await lead(a.lp, 3);
    await lead(a.lp, 20);
    await lead(b.lp, 100);
    await rebuildDailyCounts(); // dates were moved by hand above

    const admin = await makeUser("SUPER_ADMIN", null);
    const all = await dashboardCounts(admin);
    expect(all.groupBy).toBe("client");
    expect(all.rows.map((r) => [r.name, r.inRange, r.today, r.last7, r.last30, r.allTime])).toEqual([
      ["alpha", 3, 1, 2, 3, 3],
      ["beta", 1, 0, 0, 0, 1],
      ["gamma", 0, 0, 0, 0, 0],
    ]);
    expect(all.totals.allTime).toBe(4);

    const week = await dashboardCounts(admin, "7d");
    expect(week.rows.map((r) => [r.name, r.inRange])).toEqual([["alpha", 2], ["beta", 0], ["gamma", 0]]);
  });

  it("account managers see only their clients; client users see their own landing pages", async () => {
    const a = await makeClient("alpha");
    const b = await makeClient("beta");
    await lead(a.lp);
    await lead(b.lp);

    const am = await makeUser("ACCOUNT_MANAGER", null, { managedClientIds: [a.client.id] });
    expect((await dashboardCounts(am)).rows.map((r) => r.name)).toEqual(["alpha"]);

    const clientAdmin = await makeUser("CLIENT_ADMIN", b.client.id);
    const own = await dashboardCounts(clientAdmin);
    expect(own.groupBy).toBe("lp");
    expect(own.rows.map((r) => [r.name, r.allTime])).toEqual([["beta LP", 1]]);
    expect(own.totals.allTime).toBe(1);
  });

  it("keeps the daily totals exact through ingest and delete, without a rebuild", async () => {
    const a = await makeClient("alpha");
    const ids = [await lead(a.lp), await lead(a.lp), await lead(a.lp, 0, "9876543210"), await lead(a.lp, 0, "9876543210")];
    const admin = await makeUser("SUPER_ADMIN", null);
    let d = await dashboardCounts(admin);
    expect([d.totals.allTime, d.totals.today, d.totals.duplicates]).toEqual([4, 4, 1]);

    // Deleting the same leads twice at once only subtracts them once.
    await Promise.all([deleteLeads(admin, ids.slice(0, 2)), deleteLeads(admin, ids.slice(0, 2)).catch(() => null)]);
    d = await dashboardCounts(admin);
    expect(d.totals.allTime).toBe(2);
    expect(await prisma.lead.count()).toBe(2);

    // Rebuilding from the leads table gives the same numbers.
    await rebuildDailyCounts();
    expect((await dashboardCounts(admin)).totals.allTime).toBe(2);
  });

  it("client members are counted from the leads they can see", async () => {
    const a = await makeClient("alpha");
    await lead(a.lp);
    const member = await makeUser("CLIENT_MEMBER", a.client.id, { lpIds: [a.lp.id] });
    const none = await makeUser("CLIENT_MEMBER", a.client.id);
    expect((await dashboardCounts(member)).totals.allTime).toBe(1);
    expect((await dashboardCounts(none)).totals.allTime).toBe(0);
  });

  it("staff can narrow the dashboard to one client, by landing page", async () => {
    const a = await makeClient("alpha");
    const b = await makeClient("beta");
    await lead(a.lp);
    await lead(a.lp);
    await lead(b.lp);
    const admin = await makeUser("SUPER_ADMIN", null);
    const one = await dashboardCounts(admin, undefined, a.client.id);
    expect(one.groupBy).toBe("lp");
    expect(one.clientId).toBe(a.client.id);
    expect(one.rows.map((r) => [r.name, r.allTime])).toEqual([["alpha LP", 2]]);

    // An account manager can't open a client they don't manage.
    const am = await makeUser("ACCOUNT_MANAGER", null, { managedClientIds: [a.client.id] });
    await expect(dashboardCounts(am, undefined, b.client.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(dashboardTrend(am, undefined, b.client.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("builds a zero-filled trend: daily for short ranges, monthly otherwise", async () => {
    const a = await makeClient("alpha");
    const b = await makeClient("beta");
    await lead(a.lp);
    await lead(a.lp, 2);
    await lead(b.lp);
    await rebuildDailyCounts();
    const admin = await makeUser("SUPER_ADMIN", null);

    const week = await dashboardTrend(admin, "7d", a.client.id);
    expect(week.unit).toBe("day");
    expect(week.points).toHaveLength(7);
    expect(week.points.at(-1)?.value).toBe(1); // today
    expect(week.points.reduce((n, p) => n + p.value, 0)).toBe(2);

    const all = await dashboardTrend(admin);
    expect(all.unit).toBe("month");
    expect(all.points).toHaveLength(12); // this month and the 11 before it
    expect(all.points.reduce((n, p) => n + p.value, 0)).toBe(3);
  });
});
