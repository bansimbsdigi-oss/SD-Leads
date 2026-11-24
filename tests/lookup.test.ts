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
    expect(r({ email: "  ASHA.verma@example.com " })).toEqual({ leadType: "mentor", mentorName: "Anil Kapoor", mentorTeam: null, subMentorName: null, matchedBy: "email" });
    expect(r({ phone: "098765-43210" })).toMatchObject({ leadType: "mentor", matchedBy: "phone" });
    expect(r({ phone: "+91 70000 00002" })).toEqual({ leadType: "sub_mentor", mentorName: "Anil Kapoor", mentorTeam: null, subMentorName: "Vikram Singh", matchedBy: "phone" });
    expect(r({ email: "nobody@example.com", phone: "9111111111" })).toEqual({ leadType: "none", mentorName: null, mentorTeam: null, subMentorName: null, matchedBy: null });
    // In both sheets: Mentor's lead, and the Sub-mentor sheet isn't checked.
    expect(r({ email: "both@example.com" })).toEqual({ leadType: "mentor", mentorName: "Neha Rao", mentorTeam: null, subMentorName: null, matchedBy: "email" });
  });

  it("team letters in the Mentor sheet become names; a closed team (D) is never routed to", async () => {
    const { matchLead, parseTeams, readSheetRows, teamCode, DEFAULT_TEAMS } = await import("@/lib/lookup");
    expect(["A", "Team B", "team-c", " TEAM g ", "Anupa"].map(teamCode)).toEqual(["A", "B", "C", "G", null]);
    const teams = parseTeams(DEFAULT_TEAMS);
    expect([teams.get("A"), teams.get("D"), teams.get("G")]).toEqual(["Anupa", null, "Sweety"]);
    const m = readSheetRows("Name,Mobile,Team\nX,9800000001,Team A\nY,9800000002,D\nZ,9800000003,F\nW,9800000004,Ravi\n", "mentor");
    const s = readSheetRows("Phone,Sub Mentor Name,Mentor Name\n9800000002,Karan Shah,Team C\n", "subMentor");
    const r = (phone: string) => matchLead(m, s, { phone }, teams);
    expect(r("9800000001")).toMatchObject({ leadType: "mentor", mentorName: "Anupa", mentorTeam: "A" });
    expect(r("9800000003")).toMatchObject({ leadType: "mentor", mentorName: "Shobhita", mentorTeam: "F" });
    expect(r("9800000004")).toMatchObject({ leadType: "mentor", mentorName: "Ravi", mentorTeam: null }); // a name stays as it is
    // Team D: skipped, so the Sub-mentor sheet decides (its Mentor Name "Team C" is decoded too).
    expect(r("9800000002")).toMatchObject({ leadType: "sub_mentor", subMentorName: "Karan Shah", mentorName: "Jesal", mentorTeam: "C" });
    expect(matchLead(m, [], { phone: "9800000002" }, teams).leadType).toBe("none");
    // The list is editable: a renamed team takes effect.
    expect(matchLead(m, s, { phone: "9800000001" }, parseTeams("A: Asha\nTeam D - closed")).mentorName).toBe("Asha");
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
    const { addSheetLink, saveLookupConfig, getLookupSetup } = await import("@/lib/lookup");
    await saveLookupConfig(admin, { outboundUrl, refreshMinutes: 2, enabled: true });
    await addSheetLink(admin, "mentor", MENTOR_URL);
    await addSheetLink(admin, "subMentor", SUB_URL);
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
    const { addSheetLink, saveLookupConfig } = await import("@/lib/lookup");
    const { client } = await makeClient("alpha");
    const clientAdmin = await makeUser("CLIENT_ADMIN", client.id);
    const base = { outboundUrl: "", refreshMinutes: 2, enabled: true };
    await expect(saveLookupConfig(clientAdmin, base)).rejects.toThrow();
    await expect(addSheetLink(clientAdmin, "mentor", MENTOR_URL)).rejects.toThrow();
    await expect(saveLookupConfig(admin, { ...base, outboundUrl: "http://localhost:5432/x" })).rejects.toThrow();
    await expect(addSheetLink(admin, "mentor", "https://example.com/sheet")).rejects.toThrow(/Google Sheets/);
    await expect(addSheetLink(admin, "mentor", "https://docs.google.com/spreadsheets/d/MENTOR123/edit?gid=0")).rejects.toThrow(/already/);
    const body = await (await post(token, { email: "nobody@example.com" })).json();
    expect(body.lead_type).toBe("none");
    expect((await prisma.leadLookup.findUniqueOrThrow({ where: { id: body.lookup_id } })).webhookStatus).toBe("off");
  });

  it("webhook history: received, rejected, sent and failed are logged; Send test posts a marked sample", async () => {
    const { admin, token } = await setup();
    const { deliverLookup, sendLookupTest, webhookHistory } = await import("@/lib/lookup");
    const ok = await (await post(token, { name: "Sameer Khan", phone: "7000000002" })).json();
    await post(token, { name: "No contact" }); // 422
    await post("b".repeat(48), { email: "x@y.z" }); // wrong URL
    await deliverLookup(ok.lookup_id); // sent
    fakeNet({ mentor: MENTOR_CSV, sub: SUB_CSV }, 500);
    const again = await (await post(token, { email: "asha.verma@example.com" })).json();
    await expect(deliverLookup(again.lookup_id)).rejects.toThrow();
    await expect(deliverLookup(again.lookup_id)).rejects.toThrow();

    const h = await webhookHistory(admin);
    expect(h.counts).toMatchObject({ all: 7, received: 2, rejected: 2, sent: 1, failed: 2 });
    const received = h.rows.find((r) => r.status === "received" && r.lookupId === ok.lookup_id)!;
    expect(received.body).toMatchObject({ name: "Sameer Khan", phone: "7000000002" });
    expect(received.response).toContain("sub_mentor");
    const failed = (await webhookHistory(admin, "failed")).rows;
    expect(failed.map((r) => [r.httpStatus, r.attempt])).toEqual([[500, 2], [500, 1]]);
    expect(failed[0].body).toMatchObject({ lead_type: "mentor", mentor_name: "Anil Kapoor" });
    expect((await webhookHistory(admin, "rejected")).rows.map((r) => r.httpStatus).sort()).toEqual([401, 422]);
    const wrong = (await webhookHistory(admin, "rejected")).rows.find((r) => r.httpStatus === 401)!;
    expect(wrong.body).toBeNull();

    fakeNet({ mentor: MENTOR_CSV, sub: SUB_CSV }, 200);
    const t = await sendLookupTest(admin, "sub_mentor");
    expect(t.ok).toBe(true);
    expect(pabbly.at(-1)?.body).toMatchObject({ test: true, source: "test", lead_type: "sub_mentor", mentor_name: "Jesal", mentor_team: "C" });
    const sent = (await webhookHistory(admin, "sent")).rows[0];
    expect([sent.test, sent.httpStatus]).toEqual([true, 200]);
    await prisma.lookupConfig.update({ where: { id: "global" }, data: { outboundConfig: null } });
    await expect(sendLookupTest(admin, "mentor")).rejects.toThrow(/Save your webhook/);
  });

  it("two Mentor Google Sheets and one Sub-mentor sheet: searched together, and edits in Google are picked up", async () => {
    const { admin, token } = await setup();
    const { addSheetLink, getLookupSetup, removeSheetLink, sheetStatus } = await import("@/lib/lookup");
    const second = { csv: "Mentor Name,Phone\nMeera Iyer,9855555555\n" };
    const base = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (url, init) =>
      String(url).includes("MENTORTWO") ? new Response(second.csv, { headers: { "content-type": "text/csv" } }) : base(url, init));
    const TWO = "https://docs.google.com/spreadsheets/d/MENTORTWO/edit#gid=5";
    expect(await addSheetLink(admin, "mentor", TWO)).toEqual({ rows: 1, error: null });
    const [m] = sheetStatus((await getLookupSetup(admin)).cfg);
    expect([m.links.map((l) => l.rows), m.rows]).toEqual([[3, 1], 4]);

    const ask = async (body: object) => (await post(token, body)).json();
    expect(await ask({ phone: "9855555555" })).toMatchObject({ lead_type: "mentor", mentor_name: "Meera Iyer" });
    expect(await ask({ email: "asha.verma@example.com" })).toMatchObject({ lead_type: "mentor", mentor_name: "Anil Kapoor" });

    // Someone is added in Google Sheets; once the copy is older than the refresh time it's read again.
    second.csv += "Meera Iyer,9866666666\n";
    expect(await ask({ phone: "9866666666" })).toMatchObject({ lead_type: "none" }); // copy still fresh
    const cfg = (await getLookupSetup(admin)).cfg;
    const old = new Date(Date.now() - 3 * 60_000).toISOString();
    await prisma.lookupConfig.update({ where: { id: "global" }, data: { mentorLinks: (cfg.mentorLinks as { readAt: string }[]).map((l) => ({ ...l, readAt: old })) } });
    expect(await ask({ phone: "9866666666" })).toMatchObject({ lead_type: "mentor", mentor_name: "Meera Iyer" });

    await removeSheetLink(admin, "mentor", TWO);
    expect(await ask({ phone: "9855555555" })).toMatchObject({ lead_type: "none" });
  });

  it("two Mentor files and one Sub-mentor file are searched together; a file can be removed or replaced", async () => {
    const { admin, token } = await setup();
    const { getLookupSetup, removeSheetFile, removeSheetLink, sheetStatus, uploadSheet } = await import("@/lib/lookup");
    // Files only (no links).
    await removeSheetLink(admin, "mentor", MENTOR_URL);
    await removeSheetLink(admin, "subMentor", SUB_URL);
    const file = (name: string, csv: string) => new File([csv], name, { type: "text/csv" });
    await uploadSheet(admin, "mentor", file("mentors-a.csv", "Email,Phone,Mentor Name\na@example.com,9822222221,Ravi Menon\n"));
    await uploadSheet(admin, "mentor", file("mentors-b.csv", "Mobile Number,Mentor Name\n9822222222,Sunita Rao\n9822222223,Sunita Rao\n"));
    await uploadSheet(admin, "subMentor", file("subs.csv", "Phone,Sub Mentor Name,Mentor Name\n9833333333,Karan Shah,Ravi Menon\n9822222222,Should Not Win,X\n"));

    const [m, sub] = sheetStatus((await getLookupSetup(admin)).cfg);
    expect([m.files.map((f) => [f.name, f.rows]), m.rows]).toEqual([[["mentors-a.csv", 1], ["mentors-b.csv", 2]], 3]);
    expect([sub.files.length, sub.rows]).toEqual([1, 2]);

    const ask = async (body: object) => (await post(token, body)).json();
    expect(await ask({ email: "A@example.com" })).toMatchObject({ lead_type: "mentor", mentor_name: "Ravi Menon" }); // first Mentor file
    expect(await ask({ phone: "98222 22222" })).toMatchObject({ lead_type: "mentor", mentor_name: "Sunita Rao", sub_mentor_name: "" }); // second file; Sub-mentor not checked
    expect(await ask({ phone: "9833333333" })).toMatchObject({ lead_type: "sub_mentor", sub_mentor_name: "Karan Shah", mentor_name: "Ravi Menon" });

    // Same name replaces; removing a file stops its people matching.
    await uploadSheet(admin, "mentor", file("mentors-b.csv", "Mobile Number,Mentor Name\n9822222229,New Person\n"));
    expect(sheetStatus((await getLookupSetup(admin)).cfg)[0].files.map((f) => [f.name, f.rows])).toEqual([["mentors-a.csv", 1], ["mentors-b.csv", 1]]);
    await removeSheetFile(admin, "mentor", "mentors-a.csv");
    expect(await ask({ email: "a@example.com" })).toMatchObject({ lead_type: "none" });
    await expect(uploadSheet(admin, "mentor", file("bad.csv", "Name,City\nA,B\n"))).rejects.toThrow(/Email or Phone/);
  });

  it("with \"check every new lead\" on, new SD-Leads leads are looked up and sent automatically", async () => {
    const { admin } = await setup();
    const { saveLookupConfig } = await import("@/lib/lookup");
    await saveLookupConfig(admin, { outboundUrl: "https://93.184.216.34/pabbly", refreshMinutes: 2, enabled: true, autoCheckLeads: true });
    const { ingestLead } = await import("@/lib/ingest/service");
    const { ingestPayloadSchema } = await import("@/lib/ingest/schema");
    const { payload } = await import("./helpers");
    const { runJob } = await import("@/lib/jobs");
    const { lp } = await makeClient("alpha");
    const leadId = (await ingestLead(lp, ingestPayloadSchema.parse(payload({ fields: [{ key: "name", role: "name", value: "Sameer" }, { key: "phone", type: "tel", value: "7000000002" }] })))).leadId;
    await runJob("lead.created", { leadId }, 1);
    const row = await prisma.leadLookup.findFirstOrThrow({ where: { leadId } });
    expect([row.source, row.leadType, row.subMentorName]).toEqual(["lead", "sub_mentor", "Vikram Singh"]);
  });
});
