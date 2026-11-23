import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { makeClient, makeUser, resetDb } from "./helpers";

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

describe("lead lookup: global webhook in, your webhook out", () => {
  beforeEach(async () => {
    await resetDb();
    pabbly.length = 0;
  });
  afterEach(() => vi.unstubAllGlobals());

  async function setup(sheets: Sheets = { mentor: MENTOR_CSV, sub: SUB_CSV }, outboundUrl = "https://93.184.216.34/pabbly") {
    fakeNet(sheets);
    const admin = await makeUser("SUPER_ADMIN", null);
    const { saveLookupConfig, getLookupSetup } = await import("@/lib/lookup");
    await saveLookupConfig(admin, { mentorSheetUrl: MENTOR_URL, subMentorSheetUrl: SUB_URL, outboundUrl, refreshMinutes: 2, enabled: true });
    const { cfg } = await getLookupSetup(admin);
    return { admin, token: cfg.apiToken };
  }

  const post = async (token: string, body: unknown) => {
    const { POST } = await import("@/app/api/lookup/[token]/route");
    return POST(new NextRequest(`http://localhost/api/lookup/${token}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }), { params: Promise.resolve({ token }) });
  };

  it("wrong key 401, no contact 422; otherwise the result straight away, saved, and sent to your webhook", async () => {
    const { token } = await setup();
    const { deliverLookup } = await import("@/lib/lookup");
    expect((await post("a".repeat(48), { email: "x@y.z" })).status).toBe(401);
    expect((await post(token, { name: "No contact" })).status).toBe(422);

    const res = await post(token, { full_name: "Sameer Khan", mobile: "+91 70000 00002" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ event: "lead_lookup", lead_type: "sub_mentor", mentor_name: "Anil Kapoor", sub_mentor_name: "Vikram Singh", matched_by: "phone", source: "webhook", name: "Sameer Khan" });

    const row = await prisma.leadLookup.findUniqueOrThrow({ where: { id: body.lookup_id } });
    expect([row.source, row.webhookStatus, row.clientId]).toEqual(["webhook", "not_sent", null]);
    await deliverLookup(row.id); // what the queue runs
    expect((await prisma.leadLookup.findUniqueOrThrow({ where: { id: row.id } })).webhookStatus).toBe("sent");
    expect(pabbly.at(-1)?.body).toMatchObject({ event: "lead_lookup", lead_type: "sub_mentor", sub_mentor_name: "Vikram Singh" });
  });

  it("your webhook down: saved as failed; Send works once it's back", async () => {
    const { admin } = await setup();
    const { checkByHand, deliverLookup, resendLookup } = await import("@/lib/lookup");
    const { lookupId } = await checkByHand(admin, { email: "asha.verma@example.com" }, true);
    fakeNet({ mentor: MENTOR_CSV, sub: SUB_CSV }, 500);
    await expect(deliverLookup(lookupId)).rejects.toThrow(/failed/);
    expect((await prisma.leadLookup.findUniqueOrThrow({ where: { id: lookupId } })).webhookStatus).toBe("failed");
    fakeNet({ mentor: MENTOR_CSV, sub: SUB_CSV }, 200);
    await resendLookup(admin, lookupId);
    await deliverLookup(lookupId);
    expect((await prisma.leadLookup.findUniqueOrThrow({ where: { id: lookupId } })).webhookStatus).toBe("sent");
    expect(pabbly.at(-1)?.body).toMatchObject({ lead_type: "mentor", mentor_name: "Anil Kapoor", source: "panel" });
  });

  it("a sheet that isn't shared shows the problem; the other still works; Google down uses the last good copy", async () => {
    const { admin } = await setup({ mentor: MENTOR_CSV, sub: "html" });
    const { checkByHand, getLookupSetup, reloadSheets, sheetStatus } = await import("@/lib/lookup");
    const [m, s] = sheetStatus((await getLookupSetup(admin)).cfg);
    expect([m.rows, m.error]).toEqual([3, null]);
    expect(s.error).toMatch(/isn't shared/);
    expect((await checkByHand(admin, { email: "asha.verma@example.com" }, false)).result.leadType).toBe("mentor");

    fakeNet({ mentor: new Error("getaddrinfo ENOTFOUND"), sub: SUB_CSV });
    await reloadSheets(admin);
    expect(sheetStatus((await getLookupSetup(admin)).cfg)[0]).toMatchObject({ rows: 3, error: expect.stringMatching(/ENOTFOUND/) });
    expect((await checkByHand(admin, { email: "asha.verma@example.com" }, false)).result.mentorName).toBe("Anil Kapoor");
  });

  it("only super admins manage it; a bad webhook URL or non-Google sheet is refused; no webhook = not sent", async () => {
    const { admin, token } = await setup(undefined, "");
    const { saveLookupConfig } = await import("@/lib/lookup");
    const { client } = await makeClient("alpha");
    const clientAdmin = await makeUser("CLIENT_ADMIN", client.id);
    const base = { mentorSheetUrl: MENTOR_URL, subMentorSheetUrl: SUB_URL, outboundUrl: "", refreshMinutes: 2, enabled: true };
    await expect(saveLookupConfig(clientAdmin, base)).rejects.toThrow();
    await expect(saveLookupConfig(admin, { ...base, outboundUrl: "http://localhost:5432/x" })).rejects.toThrow();
    await expect(saveLookupConfig(admin, { ...base, mentorSheetUrl: "https://example.com/sheet" })).rejects.toThrow(/Google Sheets/);
    const body = await (await post(token, { email: "nobody@example.com" })).json();
    expect(body.lead_type).toBe("none");
    expect((await prisma.leadLookup.findUniqueOrThrow({ where: { id: body.lookup_id } })).webhookStatus).toBe("off");
  });
});
