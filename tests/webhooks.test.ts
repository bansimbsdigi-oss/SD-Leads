import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { ingestPayloadSchema } from "@/lib/ingest/schema";
import { ingestLead } from "@/lib/ingest/service";
import { assertSafeWebhookUrl, webhookUrlProblem } from "@/lib/outbound/safeUrl";
import { createWebhookRule, deliverLead, DeliveryError, fanOutLead, listWebhookRules, setWebhookStatus } from "@/lib/outbound/webhooks";
import { ForbiddenError, NotFoundError } from "@/lib/tenant";
import { makeClient, makeUser, payload, resetDb } from "./helpers";

describe("webhook URL safety", () => {
  it("only accepts public https URLs without credentials", () => {
    delete process.env.ALLOW_PRIVATE_WEBHOOKS;
    expect(webhookUrlProblem("https://connect.pabbly.com/workflow/sendwebhookdata/abc")).toBeNull();
    expect(webhookUrlProblem("http://connect.pabbly.com/x")).toMatch(/https/);
    expect(webhookUrlProblem("https://user:pw@example.com/x")).toMatch(/username/);
    expect(webhookUrlProblem("https://localhost/x")).toMatch(/public/);
    expect(webhookUrlProblem("https://10.0.0.5/x")).toMatch(/public/);
    expect(webhookUrlProblem("https://169.254.169.254/latest/meta-data")).toMatch(/public/);
    expect(webhookUrlProblem("not a url")).toMatch(/full URL/);
  });

  it("rejects private addresses at send time", async () => {
    delete process.env.ALLOW_PRIVATE_WEBHOOKS;
    await expect(assertSafeWebhookUrl("https://127.0.0.1/x")).rejects.toThrow();
    await expect(assertSafeWebhookUrl("https://[::1]/x")).rejects.toThrow();
  });
});

describe("outbound webhooks", () => {
  let server: Server;
  let base = "";
  const received: { path: string; body: Record<string, unknown> }[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        received.push({ path: req.url ?? "", body: raw ? JSON.parse(raw) : {} });
        if (req.url?.startsWith("/fail")) res.writeHead(500).end("boom");
        else if (req.url?.startsWith("/redirect")) res.writeHead(302, { Location: "http://127.0.0.1:1/" }).end();
        else res.writeHead(200).end("ok");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  beforeEach(async () => {
    await resetDb();
    received.length = 0;
    process.env.ALLOW_PRIVATE_WEBHOOKS = "1"; // the test receiver runs on localhost
  });

  async function lead(lp: { id: string; clientId: string; currentFormVersion: string | null }, budget: string, phone: string) {
    const p = payload();
    p.fields[1] = { ...p.fields[1], value: phone };
    p.fields[3] = { ...p.fields[3], value: budget };
    return (await ingestLead(lp, ingestPayloadSchema.parse(p))).leadId;
  }

  it("keeps rules per client and stores the URL encrypted", async () => {
    const a = await makeClient("alpha");
    const b = await makeClient("beta");
    const adminA = await makeUser("CLIENT_ADMIN", a.client.id);
    const id = await createWebhookRule(adminA, a.client.id, { name: "Pabbly", url: `${base}/hook`, conditions: [] });
    const row = await prisma.integration.findUniqueOrThrow({ where: { id } });
    expect(row.config).not.toContain("127.0.0.1");
    expect((await listWebhookRules(adminA, a.client.id))[0].url).toBe(`${base}/hook`);

    await expect(createWebhookRule(adminA, b.client.id, { name: "x", url: `${base}/x`, conditions: [] })).rejects.toBeInstanceOf(NotFoundError);
    await expect(listWebhookRules(adminA, b.client.id)).rejects.toBeInstanceOf(NotFoundError);
    const member = await makeUser("CLIENT_MEMBER", a.client.id);
    await expect(createWebhookRule(member, a.client.id, { name: "x", url: `${base}/x`, conditions: [] })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("sends only leads matching the conditions, with a mappable payload", async () => {
    const { client, lp } = await makeClient("alpha");
    const admin = await makeUser("SUPER_ADMIN", null);
    const hot = await createWebhookRule(admin, client.id, {
      name: "Hot leads",
      url: `${base}/hot`,
      conditions: [{ field: "a:budget", op: "is", value: "5L+" }],
    });
    const all = await createWebhookRule(admin, client.id, { name: "Everything", url: `${base}/all`, conditions: [] });
    const paused = await createWebhookRule(admin, client.id, { name: "Paused", url: `${base}/paused`, conditions: [] });
    await setWebhookStatus(admin, paused, "paused");

    const rich = await lead(lp, "5L+", "9000000001");
    const small = await lead(lp, "<1L", "9000000002");
    expect((await fanOutLead(rich)).sort()).toEqual([hot, all].sort());
    expect(await fanOutLead(small)).toEqual([all]);

    await deliverLead(hot, rich);
    expect(received).toHaveLength(1);
    const body = received[0].body;
    expect(received[0].path).toBe("/hot");
    expect(body).toMatchObject({ event: "lead.created", lead_id: rich, name: "Asha", phone: "+919000000001", client: "alpha", landing_page: "alpha LP" });
    expect((body.answers as Record<string, string>).budget).toBe("5L+");
    expect(body.fields).toContainEqual({ key: "q1", label: "How often do you post?", value: "Weekly" });
    const log = await prisma.outboundDelivery.findFirstOrThrow({ where: { integrationId: hot } });
    expect(log).toMatchObject({ status: "sent", responseCode: 200, attempt: 1 });
  });

  it("logs failures and redirects as failed, so the queue retries them", async () => {
    const { client, lp } = await makeClient("alpha");
    const admin = await makeUser("SUPER_ADMIN", null);
    const leadId = await lead(lp, "5L+", "9000000003");
    const fail = await createWebhookRule(admin, client.id, { name: "Down", url: `${base}/fail`, conditions: [] });
    const redirect = await createWebhookRule(admin, client.id, { name: "Moved", url: `${base}/redirect`, conditions: [] });

    await expect(deliverLead(fail, leadId, 2)).rejects.toBeInstanceOf(DeliveryError);
    await expect(deliverLead(redirect, leadId)).rejects.toBeInstanceOf(DeliveryError);
    expect(received.map((r) => r.path)).toEqual(["/fail", "/redirect"]); // the redirect target was never called
    const logs = await prisma.outboundDelivery.findMany({ orderBy: { createdAt: "asc" } });
    expect(logs.map((l) => [l.status, l.responseCode, l.attempt])).toEqual([["failed", 500, 2], ["failed", 302, 1]]);
  });
});
