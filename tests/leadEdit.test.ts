import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { ingestPayloadSchema } from "@/lib/ingest/schema";
import { ingestLead } from "@/lib/ingest/service";
import { ForbiddenError, NotFoundError } from "@/lib/tenant";
import { makeClient, makeUser, payload, resetDb } from "./helpers";

const newLead = async (lp: Parameters<typeof ingestLead>[0], phone = String(9000000000 + Math.floor(Math.random() * 1e9))) => {
  const p = payload();
  p.fields[1] = { ...p.fields[1], value: phone };
  return (await ingestLead(lp, ingestPayloadSchema.parse(p))).leadId;
};

describe("working leads", () => {
  beforeEach(resetDb);

  it("status: only a stage of the lead's own client; recorded on the timeline", async () => {
    const { setLeadStatus } = await import("@/lib/leadEdit");
    const a = await makeClient("alpha");
    const b = await makeClient("beta");
    const la = await newLead(a.lp);
    const lb = await newLead(b.lp);
    const admin = await makeUser("SUPER_ADMIN", null);
    const won = await prisma.pipelineStage.findFirstOrThrow({ where: { clientId: a.client.id, name: "Won" } });

    expect(await setLeadStatus(admin, [la, lb], won.id)).toBe(1); // beta's lead is skipped
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: la } })).statusId).toBe(won.id);
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: lb } })).statusId).not.toBe(won.id);
    await expect(setLeadStatus(admin, [lb], won.id)).rejects.toThrow(/different client/);
    const ev = await prisma.leadEvent.findFirstOrThrow({ where: { leadId: la, type: "status_changed" } });
    expect(ev.payload).toEqual({ to: "Won" });
    expect(await setLeadStatus(admin, [la], won.id)).toBe(0); // already that status: nothing logged twice
  });

  it("assign: not for members; owner must belong to the lead's client or be Sabhi staff", async () => {
    const { assignLeads, ownerOptions } = await import("@/lib/leadEdit");
    const a = await makeClient("alpha");
    const b = await makeClient("beta");
    const la = await newLead(a.lp);
    const adminA = await makeUser("CLIENT_ADMIN", a.client.id);
    const memberA = await makeUser("CLIENT_MEMBER", a.client.id, { lpIds: [a.lp.id] });
    const memberB = await makeUser("CLIENT_MEMBER", b.client.id);
    const staff = await makeUser("SUPER_ADMIN", null);

    await expect(assignLeads(memberA, [la], memberA.userId)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(assignLeads(adminA, [la], memberB.userId)).rejects.toThrow(/can't be given/);
    expect(await assignLeads(adminA, [la], memberA.userId)).toBe(1);
    expect(await assignLeads(adminA, [la], staff.userId)).toBe(1);
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: la } })).ownerId).toBe(staff.userId);
    const options = (await ownerOptions(a.client.id)).map((o) => o.id);
    expect(options).toContain(memberA.userId);
    expect(options).toContain(staff.userId);
    expect(options).not.toContain(memberB.userId);
  });

  it("tags: cleaned, de-duplicated (any case), bulk add and remove", async () => {
    const { bulkTag, cleanTags, setLeadTags, tagSuggestions } = await import("@/lib/leadEdit");
    expect(cleanTags(["  vip ", "VIP", "", "No   answer"])).toEqual(["vip", "No answer"]);
    const a = await makeClient("alpha");
    const [l1, l2] = [await newLead(a.lp), await newLead(a.lp)];
    const admin = await makeUser("CLIENT_ADMIN", a.client.id);
    await setLeadTags(admin, l1, ["VIP"]);
    expect(await bulkTag(admin, [l1, l2], "vip")).toBe(1); // l1 already has it
    expect(await bulkTag(admin, [l1, l2], "Paid")).toBe(2);
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: l2 } })).tags).toEqual(["vip", "Paid"]);
    expect(await bulkTag(admin, [l1, l2], "PAID", true)).toBe(2);
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: l1 } })).tags).toEqual(["VIP"]);
    expect(await tagSuggestions(admin, a.client.id)).toEqual(expect.arrayContaining(["VIP", "vip"]));
  });

  it("notes and details: members on their own leads; bad phone refused; search text follows the edit", async () => {
    const { addNote, editLeadDetails } = await import("@/lib/leadEdit");
    const { queryLeads } = await import("@/lib/leadQuery");
    const a = await makeClient("alpha");
    const la = await newLead(a.lp);
    const member = await makeUser("CLIENT_MEMBER", a.client.id, { lpIds: [a.lp.id] });
    const outsider = await makeUser("CLIENT_MEMBER", a.client.id); // no LPs, owns nothing

    await addNote(member, la, "  Called, joins Sunday  ");
    expect((await prisma.leadEvent.findFirstOrThrow({ where: { leadId: la, type: "note" } })).payload).toEqual({ text: "Called, joins Sunday" });
    await expect(addNote(member, la, "   ")).rejects.toThrow(/Write something/);
    await expect(addNote(outsider, la, "hi")).rejects.toBeInstanceOf(NotFoundError);

    await expect(editLeadDetails(member, la, { name: "X", phone: "12", email: "" })).rejects.toThrow(/phone/);
    await editLeadDetails(member, la, { name: "Kavya Rao", phone: "98111 22233", email: "Kavya@Mail.com" });
    const after = await prisma.lead.findUniqueOrThrow({ where: { id: la } });
    expect([after.name, after.phoneNormalised, after.emailNormalised]).toEqual(["Kavya Rao", "+919811122233", "kavya@mail.com"]);
    const ev = await prisma.leadEvent.findFirstOrThrow({ where: { leadId: la, type: "edited" } });
    expect(Object.keys((ev.payload as { changes: object }).changes).sort()).toEqual(["email", "name", "phone"]);
    const admin = await makeUser("SUPER_ADMIN", null);
    const found = await queryLeads(admin, { q: "kavya", conditions: [], dir: "desc", page: 1, pageSize: 25 });
    expect(found.rows.map((r) => r.id)).toEqual([la]);
  });

  it("manual tags show in the tag column and can be filtered", async () => {
    const { setLeadTags } = await import("@/lib/leadEdit");
    const { leadColumns } = await import("@/lib/leadColumns");
    const { leadFieldDefs, queryLeads } = await import("@/lib/leadQuery");
    const a = await makeClient("alpha");
    const [l1] = [await newLead(a.lp), await newLead(a.lp)];
    const admin = await makeUser("SUPER_ADMIN", null);
    await setLeadTags(admin, l1, ["Hot", "Paid"]);
    const cols = await leadColumns(admin, { clientId: a.client.id });
    const lead = await prisma.lead.findUniqueOrThrow({ where: { id: l1 } });
    expect(cols.find((c) => c.id === "s:tag")!.value(lead as never)).toBe("Hot, Paid");
    const defs = await leadFieldDefs(admin, { clientId: a.client.id });
    const r = await queryLeads(admin, { clientId: a.client.id, conditions: [{ field: "s:tag", op: "contains", value: "paid" }], dir: "desc", page: 1, pageSize: 25 }, defs);
    expect(r.rows.map((x) => x.id)).toEqual([l1]);
  });
});
