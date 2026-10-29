import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { ingestPayloadSchema } from "@/lib/ingest/schema";
import { ingestLead } from "@/lib/ingest/service";
import type { Condition } from "@/lib/leadFilterSpec";
import { columnValues, leadFieldDefs, parseLeadQuery, queryLeads, rangeBounds, type LeadQuery } from "@/lib/leadQuery";
import type { Ctx } from "@/lib/tenant";
import { makeClient, makeUser, resetDb } from "./helpers";

const base = (o: Partial<LeadQuery> = {}): LeadQuery => ({ conditions: [], dir: "desc", page: 1, pageSize: 100, ...o });

async function add(lp: { id: string; clientId: string; currentFormVersion: string | null }, name: string, phone: string, extra: Record<string, unknown>[], daysAgo = 0) {
  const r = await ingestLead(lp, ingestPayloadSchema.parse({
    submission_id: `s-${name}-${Math.random()}`,
    fields: [{ key: "name", role: "name", value: name }, { key: "phone", type: "tel", value: phone }, ...extra],
  }));
  if (daysAgo) await prisma.lead.update({ where: { id: r.leadId }, data: { createdAt: new Date(Date.now() - daysAgo * 86_400_000) } });
  return r.leadId;
}

describe("lead query", () => {
  let ctx: Ctx;
  let clientId: string;
  let lpId: string;

  beforeEach(async () => {
    await resetDb();
    const { client, lp } = await makeClient("acme");
    clientId = client.id;
    lpId = lp.id;
    ctx = await makeUser("CLIENT_ADMIN", client.id);
    await add(lp, "Asha", "9876500001", [
      { key: "city", type: "text", value: "Pune" },
      { key: "budget", type: "select", options: ["<1L", "1-5L", "5L+"], value: "5L+" },
      { key: "platforms", type: "checkbox", options: ["Instagram", "YouTube"], value: ["Instagram", "YouTube"] },
      { key: "q1", type: "radio", options: ["a", "b"], value: "b", score: 3 },
    ]);
    await add(lp, "Ravi", "9876500002", [
      { key: "city", type: "text", value: "Mumbai" },
      { key: "budget", type: "select", value: "<1L" },
      { key: "platforms", type: "checkbox", value: ["YouTube"] },
      { key: "q1", type: "radio", value: "a", score: 1 },
    ], 1.2);
    await add(lp, "Zoya", "9876500003", [{ key: "city", type: "text", value: "" }], 20);
  });

  const names = async (q: Partial<LeadQuery>) => (await queryLeads(ctx, base({ clientId, ...q }))).rows.map((r) => r.name);
  const where = (...conditions: Condition[]) => names({ conditions });

  it("searches name, phone digits and answer values", async () => {
    expect(await names({ q: "ash" })).toEqual(["Asha"]);
    expect(await names({ q: "500002" })).toEqual(["Ravi"]);
    expect(await names({ q: "098765 00003" })).toEqual(["Zoya"]);
    expect(await names({ q: "mumb" })).toEqual(["Ravi"]);
    expect(await names({ q: "city" })).toEqual([]); // keys are not searched, only values
    expect(await names({ q: "100%_'" })).toEqual([]);
  });

  it("filters by date presets", async () => {
    expect(await names({ range: "today" })).toEqual(["Asha"]);
    expect(await names({ range: "7d" })).toEqual(["Asha", "Ravi"]);
    expect(await names({ range: "30d" })).toEqual(["Asha", "Ravi", "Zoya"]);
  });

  it("filters on form answers, including multi-select arrays", async () => {
    expect(await where({ field: "a:city", op: "is", value: "pune" })).toEqual(["Asha"]);
    expect(await where({ field: "a:city", op: "contains", value: "um" })).toEqual(["Ravi"]);
    expect(await where({ field: "a:city", op: "not_contains", value: "pune" })).toEqual(["Ravi", "Zoya"]);
    expect(await where({ field: "a:city", op: "empty" })).toEqual(["Zoya"]);
    expect(await where({ field: "a:platforms", op: "is", value: "Instagram" })).toEqual(["Asha"]);
    expect(await where({ field: "a:platforms", op: "is", value: "youtube" })).toEqual(["Asha", "Ravi"]);
    expect(await where({ field: "a:platforms", op: "is_not", value: "Instagram" })).toEqual(["Ravi", "Zoya"]);
    expect(await where({ field: "a:budget", op: "is", value: "5L+" }, { field: "a:city", op: "not_empty" })).toEqual(["Asha"]);
  });

  it("filters on core fields", async () => {
    const stages = await prisma.pipelineStage.findMany({ where: { clientId } });
    await prisma.lead.updateMany({ where: { name: "Ravi" }, data: { statusId: stages.find((s) => s.name === "Won")!.id } });
    expect(await where({ field: "status", op: "is", value: "Won" })).toEqual(["Ravi"]);
    expect(await where({ field: "score", op: "gt", value: "2" })).toEqual(["Asha"]);
    expect(await where({ field: "score", op: "empty" })).toEqual(["Zoya"]);
    expect(await where({ field: "lp", op: "is", value: lpId })).toHaveLength(3);
    expect(await where({ field: "duplicate", op: "true" })).toEqual([]);
    expect(await where({ field: "phone", op: "starts_with", value: "+9198765" })).toHaveLength(3);
  });

  it("ignores unknown fields and invalid operators", async () => {
    expect(await where({ field: "a:nope'; DROP TABLE leads;--", op: "is", value: "x" })).toHaveLength(3);
    expect(await where({ field: "name", op: "gt", value: "x" })).toHaveLength(3);
  });

  it("sorts by any column, answers included, empties last", async () => {
    expect(await names({ sort: "name", dir: "asc" })).toEqual(["Asha", "Ravi", "Zoya"]);
    expect(await names({ sort: "name", dir: "desc" })).toEqual(["Zoya", "Ravi", "Asha"]);
    expect(await names({ sort: "a:city", dir: "asc" })).toEqual(["Zoya", "Ravi", "Asha"]); // "" sorts first, NULL would be last
    expect(await names({ sort: "score", dir: "desc" })).toEqual(["Asha", "Ravi", "Zoya"]);
    expect(await names({ sort: "created_at", dir: "asc" })).toEqual(["Zoya", "Ravi", "Asha"]);
  });

  it("paginates and counts", async () => {
    const page1 = await queryLeads(ctx, base({ clientId, pageSize: 2 }));
    const page2 = await queryLeads(ctx, base({ clientId, pageSize: 2, page: 2 }));
    expect(page1.total).toBe(3);
    expect(page1.rows.map((r) => r.name)).toEqual(["Asha", "Ravi"]);
    expect(page2.rows.map((r) => r.name)).toEqual(["Zoya"]);
  });

  it("never leaks another client's leads through filters", async () => {
    const other = await makeClient("beta");
    await add(other.lp, "Outsider", "9000000009", [{ key: "city", type: "text", value: "Pune" }]);
    expect(await names({ clientId: other.client.id })).toEqual([]);
    expect(await names({ clientId: undefined, q: "Outsider" })).toEqual([]);
    expect(await where({ field: "a:city", op: "is", value: "Pune" })).toEqual(["Asha"]);
  });

  it("filters by a list of values (Sheets-style), with blanks and multi-select", async () => {
    expect(await where({ field: "a:city", op: "in", values: ["Pune", "mumbai"] })).toEqual(["Asha", "Ravi"]);
    expect(await where({ field: "a:city", op: "in", values: [""] })).toEqual(["Zoya"]); // (Blanks)
    expect(await where({ field: "a:city", op: "in", values: ["Pune", ""] })).toEqual(["Asha", "Zoya"]);
    expect(await where({ field: "a:platforms", op: "in", values: ["Instagram"] })).toEqual(["Asha"]);
    expect(await where({ field: "a:city", op: "in", values: [] })).toEqual([]);
    expect(await where({ field: "lp", op: "in", values: [lpId] })).toHaveLength(3);
    expect(await where({ field: "score", op: "in", values: ["1", "3"] })).toEqual(["Asha", "Ravi"]);
  });

  it("lists a column's values with counts, ignoring that column's own filter", async () => {
    const defs = await leadFieldDefs(ctx, { clientId });
    const city = await columnValues(ctx, base({ clientId, conditions: [{ field: "a:city", op: "in", values: ["Pune"] }] }), defs, "a:city");
    expect(city?.values).toEqual([
      { value: "Mumbai", label: "Mumbai", count: 1 },
      { value: "Pune", label: "Pune", count: 1 },
      { value: "", label: "(Blanks)", count: 1 },
    ]);
    // Multi-select answers count once per ticked option; other filters still apply.
    const platforms = await columnValues(ctx, base({ clientId, conditions: [{ field: "a:city", op: "is", value: "Pune" }] }), defs, "a:platforms");
    expect(platforms?.values.map((v) => [v.value, v.count])).toEqual([["Instagram", 1], ["YouTube", 1]]);
    const lp = await columnValues(ctx, base({ clientId }), defs, "lp");
    expect(lp?.values).toEqual([{ value: lpId, label: "acme LP", count: 3 }]);
    expect(await columnValues(ctx, base({ clientId }), defs, "a:nope")).toBeNull();
  });

  it("column values never include another client's leads", async () => {
    const other = await makeClient("beta");
    await add(other.lp, "Outsider", "9000000009", [{ key: "city", type: "text", value: "Goa" }]);
    const defs = await leadFieldDefs(ctx, { clientId: other.client.id });
    const res = await columnValues(ctx, base({ clientId: other.client.id }), defs, "name");
    expect(res?.values).toEqual([]);
  });

  it("offers the client's form fields as filter fields", async () => {
    const defs = await leadFieldDefs(ctx, { clientId });
    const budget = defs.find((d) => d.id === "a:budget");
    expect(budget).toMatchObject({ kind: "choice", group: "Form" });
    expect(budget?.options?.map((o) => o.value)).toEqual(["<1L", "1-5L", "5L+"]);
    expect(defs.some((d) => d.id === "a:name")).toBe(false); // core role fields are columns already
  });
});

describe("query parsing and IST ranges", () => {
  it("parses URL params defensively", () => {
    const q = parseLeadQuery(new URLSearchParams({ q: " asha ", range: "bogus", f: "not json", page: "-3", dir: "asc", sort: "name" }));
    expect(q).toMatchObject({ q: "asha", range: undefined, conditions: [], page: 1, dir: "asc", sort: "name" });
    const f = parseLeadQuery(new URLSearchParams({ f: JSON.stringify([{ field: "a:city", op: "is", value: "Pune" }]) }));
    expect(f.conditions).toEqual([{ field: "a:city", op: "is", value: "Pune" }]);
    expect(parseLeadQuery(new URLSearchParams()).pageSize).toBe(25);
    expect(parseLeadQuery(new URLSearchParams({ size: "1000" })).pageSize).toBe(1000);
    expect(parseLeadQuery(new URLSearchParams({ size: "5000" })).pageSize).toBe(25); // only the offered sizes
  });

  it("uses India midnight for day boundaries", () => {
    const now = new Date("2026-10-29T20:00:00Z"); // 30 Oct 01:30 IST
    expect(rangeBounds("today", now).from.toISOString()).toBe("2026-10-29T18:30:00.000Z");
    const y = rangeBounds("yesterday", now);
    expect([y.from.toISOString(), y.to?.toISOString()]).toEqual(["2026-10-28T18:30:00.000Z", "2026-10-29T18:30:00.000Z"]);
    expect(rangeBounds("7d", now).from.toISOString()).toBe("2026-10-23T18:30:00.000Z");
    expect(rangeBounds("6m", now).from.toISOString()).toBe("2026-04-29T18:30:00.000Z");
  });
});
