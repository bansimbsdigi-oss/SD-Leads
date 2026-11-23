import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { ingestPayloadSchema } from "@/lib/ingest/schema";
import { ingestLead } from "@/lib/ingest/service";
import { makeClient, makeUser, payload, resetDb } from "./helpers";

const MENTOR_CSV = `Mentor Name,Email ID,Mobile Number
Anil Kapoor,Asha.Verma@Example.com,+91 98765 43210
Neha Rao,"both@example.com",9000000003
Ignored Duplicate,asha.verma@example.com,
`;
const SUB_CSV = `"Sub Mentor Name",Email,WhatsApp,Mentor Name
Vikram Singh,sameer@example.com,+91-7000000002,Anil Kapoor
Priya Das,both@example.com,,Neha Rao
`;
const MENTOR_URL = "https://docs.google.com/spreadsheets/d/MENTOR123/edit#gid=0";
const SUB_URL = "https://docs.google.com/spreadsheets/d/SUB456/edit?gid=77";

type Sheets = { mentor: string | Error | "html"; sub: string | Error | "html" };
const pabbly: { body: unknown; status: number }[] = [];

/** Fake Google Sheets and a fake Pabbly. */
function fakeNet(sheets: Sheets, pabblyStatus = 200) {
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("docs.google.com")) {
      const which = u.includes("MENTOR123") ? sheets.mentor : sheets.sub;
      if (which instanceof Error) throw which;
      if (which === "html") return new Response("<html>Sign in</html>", { headers: { "content-type": "text/html" } });
      return new Response(which, { headers: { "content-type": "text/csv" } });
    }
    pabbly.push({ body: JSON.parse(String(init?.body ?? "{}")), status: pabblyStatus });
    return new Response("{}", { status: pabblyStatus });
  }));
}

describe("lead lookup: rules", () => {
  it("turns sheet links into CSV downloads, Google Sheets only", async () => {
    const { sheetCsvUrl } = await import("@/lib/lookup");
    expect(sheetCsvUrl(MENTOR_URL)).toBe("https://docs.google.com/spreadsheets/d/MENTOR123/export?format=csv&gid=0");
    expect(sheetCsvUrl(SUB_URL)).toBe("https://docs.google.com/spreadsheets/d/SUB456/export?format=csv&gid=77");
    expect(sheetCsvUrl("https://docs.google.com/spreadsheets/d/e/2PACX-abc/pubhtml")).toBe("https://docs.google.com/spreadsheets/d/e/2PACX-abc/pub?output=csv");
    expect(() => sheetCsvUrl("https://evil.example/spreadsheets/d/x")).toThrow(/Google Sheets/);
    expect(() => sheetCsvUrl("not a link")).toThrow(/isn't a link/);
  });

  it("reads headers by name in any order; first row wins; quoted fields", async () => {
    const { readSheetRows } = await import("@/lib/lookup");
    const rows = readSheetRows(MENTOR_CSV, "mentor");
    expect(rows[0]).toEqual({ email: "asha.verma@example.com", phone: "9876543210", name: "Anil Kapoor", mentor: null });
    expect(rows).toHaveLength(3);
    expect(readSheetRows(SUB_CSV, "subMentor")[0]).toEqual({ email: "sameer@example.com", phone: "7000000002", name: "Vikram Singh", mentor: "Anil Kapoor" });
    expect(() => readSheetRows("Name,City\nA,B\n", "mentor")).toThrow(/Email or Phone/);
    expect(() => readSheetRows("Email,Phone\na@b.c,1\n", "subMentor")).toThrow(/Sub Mentor Name/);
  });

  it("matches the plan's checklist", async () => {
    const { matchLead, readSheetRows } = await import("@/lib/lookup");
    const m = readSheetRows(MENTOR_CSV, "mentor");
    const s = readSheetRows(SUB_CSV, "subMentor");
    const r = (lead: { email?: string; phone?: string }) => matchLead(m, s, lead);
    expect(r({ email: "  ASHA.verma@example.com " })).toEqual({ leadType: "mentor", mentorName: "Anil Kapoor", subMentorName: null, matchedBy: "email" });
    expect(r({ phone: "098765-43210" })).toMatchObject({ leadType: "mentor", matchedBy: "phone" });
    expect(r({ phone: "+91 70000 00002" })).toEqual({ leadType: "sub_mentor", mentorName: "Anil Kapoor", subMentorName: "Vikram Singh", matchedBy: "phone" });
    expect(r({ email: "nobody@example.com", phone: "9111111111" })).toEqual({ leadType: "none", mentorName: null, subMentorName: null, matchedBy: null });
    expect(r({ email: "both@example.com" })).toEqual({ leadType: "mentor", mentorName: "Neha Rao", subMentorName: "Priya Das", matchedBy: "email" });
  });

  it("API input: alternative names; no email and no phone is refused", async () => {
    const { lookupInput } = await import("@/lib/lookup");
    expect(lookupInput({ full_name: "A", mobile: "+91 98765 43210" })).toEqual({ name: "A", email: null, phone: "+91 98765 43210" });
    expect(() => lookupInput({ name: "Only a name" })).toThrow(/email or a phone/);
  });
});

describe("lead lookup: in the app", () => {
  beforeEach(async () => {
    await resetDb();
    pabbly.length = 0;
  });
  afterEach(() => vi.unstubAllGlobals());

  async function setup(sheets: Sheets = { mentor: MENTOR_CSV, sub: SUB_CSV }) {
    fakeNet(sheets);
    const { client, lp } = await makeClient("alpha");
    const admin = await makeUser("CLIENT_ADMIN", client.id);
    const { createWebhookRule } = await import("@/lib/outbound/webhooks");
    const hook = await createWebhookRule(admin, client.id, { name: "Pabbly", url: "https://93.184.216.34/pabbly", conditions: [] });
    const { saveLookupConfig } = await import("@/lib/lookup");
    await saveLookupConfig(admin, client.id, { mentorSheetUrl: MENTOR_URL, subMentorSheetUrl: SUB_URL, webhookId: hook, refreshMinutes: 2, enabled: true });
    return { client, lp, admin, hook };
  }

  it("new leads are checked on arrival and the result goes out in their webhook", async () => {
    const { client, lp } = await setup();
    const { runJob } = await import("@/lib/jobs");
    const { buildLeadPayload } = await import("@/lib/outbound/webhooks");
    const p = payload({ fields: [{ key: "name", role: "name", value: "Sameer Khan" }, { key: "phone", type: "tel", value: "7000000002" }] });
    const leadId = (await ingestLead(lp, ingestPayloadSchema.parse(p))).leadId;
    await runJob("lead.created", { leadId }, 1);
    const lead = await prisma.lead.findUniqueOrThrow({ where: { id: leadId } });
    expect([lead.lookupType, lead.mentorName, lead.subMentorName, lead.lookupMatchedBy]).toEqual(["sub_mentor", "Anil Kapoor", "Vikram Singh", "phone"]);
    const out = await buildLeadPayload(leadId);
    expect(out).toMatchObject({ lead_type: "sub_mentor", lead_type_label: "Sub-mentor's lead", is_sub_mentor_lead: true, mentor_name: "Anil Kapoor", sub_mentor_name: "Vikram Singh" });
    expect(await prisma.leadLookup.count({ where: { clientId: client.id, source: "lead", webhookStatus: "with_lead" } })).toBe(1);
  });

  it("API: wrong key 401, no contact 422, otherwise the result straight away and saved", async () => {
    const { client } = await setup();
    const { POST } = await import("@/app/api/lookup/[token]/route");
    const cfg = await prisma.lookupConfig.findUniqueOrThrow({ where: { clientId: client.id } });
    const call = (token: string, body: unknown) =>
      POST(new NextRequest(`http://localhost/api/lookup/${token}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }), { params: Promise.resolve({ token }) });

    expect((await call("a".repeat(48), { email: "x@y.z" })).status).toBe(401);
    expect((await call(cfg.apiToken, { name: "No contact" })).status).toBe(422);
    const res = await call(cfg.apiToken, { name: "Asha Verma", email: "asha.verma@EXAMPLE.com", phone: "+91 98765 43210" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ event: "lead_lookup", lead_type: "mentor", mentor_name: "Anil Kapoor", matched_by: "email", source: "api", name: "Asha Verma" });
    expect(await prisma.leadLookup.count({ where: { clientId: client.id, source: "api" } })).toBe(1);
  });

  it("Pabbly down: lookup saved as failed; Send works once it's back", async () => {
    const { client, admin } = await setup();
    const { checkByHand, deliverLookup, resendLookup } = await import("@/lib/lookup");
    const { lookupId } = await checkByHand(admin, client.id, { email: "sameer@example.com" }, true);
    fakeNet({ mentor: MENTOR_CSV, sub: SUB_CSV }, 500);
    await expect(deliverLookup(lookupId)).rejects.toThrow(/failed/);
    expect((await prisma.leadLookup.findUniqueOrThrow({ where: { id: lookupId } })).webhookStatus).toBe("failed");
    fakeNet({ mentor: MENTOR_CSV, sub: SUB_CSV }, 200);
    await resendLookup(admin, lookupId);
    await deliverLookup(lookupId);
    const row = await prisma.leadLookup.findUniqueOrThrow({ where: { id: lookupId } });
    expect(row.webhookStatus).toBe("sent");
    expect(pabbly.at(-1)?.body).toMatchObject({ event: "lead_lookup", lead_type: "sub_mentor", sub_mentor_name: "Vikram Singh", source: "panel" });
  });

  it("a sheet that isn't shared shows the problem; the other still works; Google down uses the last good copy", async () => {
    const { client, admin } = await setup({ mentor: MENTOR_CSV, sub: "html" });
    const { checkByHand, reloadSheets, sheetStatus } = await import("@/lib/lookup");
    let cfg = await prisma.lookupConfig.findUniqueOrThrow({ where: { clientId: client.id } });
    const [m, s] = sheetStatus(cfg);
    expect([m.rows, m.error]).toEqual([3, null]);
    expect(s.error).toMatch(/isn't shared/);
    expect((await checkByHand(admin, client.id, { email: "asha.verma@example.com" }, false)).result.leadType).toBe("mentor");

    fakeNet({ mentor: new Error("getaddrinfo ENOTFOUND"), sub: SUB_CSV });
    await reloadSheets(admin, client.id);
    cfg = await prisma.lookupConfig.findUniqueOrThrow({ where: { clientId: client.id } });
    expect(sheetStatus(cfg)[0]).toMatchObject({ rows: 3, error: expect.stringMatching(/ENOTFOUND/) });
    expect((await checkByHand(admin, client.id, { email: "asha.verma@example.com" }, false)).result.mentorName).toBe("Anil Kapoor");
  });

  it("checks existing leads once; members can't change the settings", async () => {
    const { client, lp, admin } = await setup();
    const { checkExistingLeads, saveLookupConfig } = await import("@/lib/lookup");
    const p = payload({ fields: [{ key: "name", role: "name", value: "Asha" }, { key: "phone", type: "tel", value: "9876543210" }] });
    const id = (await ingestLead(lp, ingestPayloadSchema.parse(p))).leadId;
    expect(await checkExistingLeads(admin, client.id)).toBe(1);
    expect((await prisma.lead.findUniqueOrThrow({ where: { id } })).lookupType).toBe("mentor");
    const member = await makeUser("CLIENT_MEMBER", client.id);
    await expect(saveLookupConfig(member, client.id, { mentorSheetUrl: "", subMentorSheetUrl: "", webhookId: "", refreshMinutes: 2, enabled: false })).rejects.toThrow();
  });
});
