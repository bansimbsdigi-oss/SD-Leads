import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { ingestPayloadSchema } from "@/lib/ingest/schema";
import { ingestLead } from "@/lib/ingest/service";
import { makeClient, payload, resetDb } from "./helpers";

const parse = (p: unknown) => ingestPayloadSchema.parse(p);

describe("ingestLead", () => {
  beforeEach(resetDb);

  it("stores answers, core fields, scores, tracking and a created event", async () => {
    const { lp } = await makeClient("acme");
    const res = await ingestLead(lp, parse(payload()));
    expect(res.created).toBe(true);
    const lead = await prisma.lead.findUniqueOrThrow({ where: { id: res.leadId }, include: { events: true, status: true } });
    expect(lead.name).toBe("Asha");
    expect(lead.phoneNormalised).toBe("+919876543210");
    expect(lead.answers).toMatchObject({ q1: "Weekly", budget: "5L+", phone: "98765 43210" });
    expect(lead.scores).toEqual({ q1: 2 });
    expect(lead.totalScore).toBe(2);
    expect(lead.tracking).toEqual({ utm_source: "meta" });
    expect(lead.status?.name).toBe("New");
    expect(lead.events.map((e) => e.type)).toEqual(["created"]);
  });

  it("is idempotent on (lp, submission_id), including concurrent submits", async () => {
    const { lp } = await makeClient("acme");
    const p = parse(payload({ submission_id: "same-submission-1" }));
    const results = await Promise.all([ingestLead(lp, p), ingestLead(lp, p), ingestLead(lp, p)]);
    expect(new Set(results.map((r) => r.leadId)).size).toBe(1);
    expect(await prisma.lead.count()).toBe(1);
  });

  it("flags duplicates by phone within the client but still saves them", async () => {
    const { lp } = await makeClient("acme");
    const first = await ingestLead(lp, parse(payload()));
    const second = await ingestLead(lp, parse(payload({
      fields: [{ key: "phone", type: "tel", value: "+91 98765-43210" }, { key: "name", role: "name", value: "Asha again" }],
    })));
    expect(second.created).toBe(true);
    expect(second.duplicateOfId).toBe(first.leadId);
    const events = await prisma.leadEvent.findMany({ where: { leadId: second.leadId } });
    expect(events.map((e) => e.type).sort()).toEqual(["created", "duplicate_of"]);
  });

  it("does not flag duplicates across clients", async () => {
    const a = await makeClient("alpha");
    const b = await makeClient("beta");
    await ingestLead(a.lp, parse(payload()));
    const res = await ingestLead(b.lp, parse(payload()));
    expect(res.duplicateOfId).toBeNull();
  });

  it("registers new fields and form versions without touching old leads", async () => {
    const { lp } = await makeClient("acme");
    const r1 = await ingestLead(lp, parse(payload()));
    expect(await prisma.formField.count({ where: { lpId: lp.id } })).toBe(4);

    const withCity = payload();
    withCity.fields.push({ key: "City", type: "text", label: "Your city", value: "Pune" } as never);
    const r2 = await ingestLead({ ...lp, currentFormVersion: null }, parse(withCity));

    const fields = await prisma.formField.findMany({ where: { lpId: lp.id }, orderBy: { position: "asc" } });
    expect(fields.map((f) => f.fieldKey)).toEqual(["name", "phone", "q1", "budget", "city"]);
    expect(fields.find((f) => f.fieldKey === "q1")?.options).toEqual(["Never", "Weekly", "Daily"]);

    const [l1, l2] = await Promise.all([
      prisma.lead.findUniqueOrThrow({ where: { id: r1.leadId } }),
      prisma.lead.findUniqueOrThrow({ where: { id: r2.leadId } }),
    ]);
    expect(l1.formVersionId).not.toBe(l2.formVersionId);
    expect(l1.answers).not.toHaveProperty("city");
    const refreshed = await prisma.landingPage.findUniqueOrThrow({ where: { id: lp.id } });
    expect(refreshed.currentFormVersion).toBe(l2.formVersionId);
    expect(await prisma.formVersion.count({ where: { lpId: lp.id } })).toBe(2);
  });

  it("updates registry labels on label change but keeps admin display labels", async () => {
    const { lp } = await makeClient("acme");
    await ingestLead(lp, parse(payload()));
    await prisma.formField.updateMany({ where: { lpId: lp.id, fieldKey: "budget" }, data: { displayLabel: "Investment budget" } });
    const renamed = payload();
    renamed.fields[3] = { ...renamed.fields[3], label: "Monthly budget" };
    await ingestLead(lp, parse(renamed));
    const f = await prisma.formField.findFirstOrThrow({ where: { lpId: lp.id, fieldKey: "budget" } });
    expect(f.label).toBe("Monthly budget");
    expect(f.displayLabel).toBe("Investment budget");

    // A bare key from a plain webhook post does not overwrite the real label.
    const bare = payload();
    bare.fields[3] = { ...bare.fields[3], label: "budget" };
    await ingestLead(lp, parse(bare));
    expect((await prisma.formField.findFirstOrThrow({ where: { lpId: lp.id, fieldKey: "budget" } })).label).toBe("Monthly budget");
  });

  it("stores multi-value checkbox answers as arrays", async () => {
    const { lp } = await makeClient("acme");
    const p = payload();
    p.fields.push({ key: "platforms", type: "checkbox", options: ["Instagram", "YouTube"], value: ["Instagram", "YouTube"] } as never);
    const res = await ingestLead(lp, parse(p));
    const lead = await prisma.lead.findUniqueOrThrow({ where: { id: res.leadId } });
    expect((lead.answers as Record<string, unknown>).platforms).toEqual(["Instagram", "YouTube"]);
  });
});
