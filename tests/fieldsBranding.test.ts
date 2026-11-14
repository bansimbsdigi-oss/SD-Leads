import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { ingestPayloadSchema } from "@/lib/ingest/schema";
import { ingestLead } from "@/lib/ingest/service";
import { ForbiddenError } from "@/lib/tenant";
import { makeClient, makeUser, payload, resetDb } from "./helpers";

const withAnswers = (extra: Record<string, unknown>[]) =>
  payload({ fields: [{ key: "name", role: "name", value: "Asha" }, { key: "phone", type: "tel", value: "9811122233" }, ...extra] });

describe("field manager", () => {
  beforeEach(resetDb);

  it("renames, hides and merges columns across landing pages; merges can be undone", async () => {
    const { fieldColumns, mergeColumn, renameColumn, setColumnHidden, unmergeField } = await import("@/lib/fieldManager");
    const { leadColumns } = await import("@/lib/leadColumns");
    const { client, lp } = await makeClient("alpha");
    const lp2 = await prisma.landingPage.create({ data: { clientId: client.id, name: "LP two", lpKey: "alpha-two", allowedDomains: [] } });
    await ingestLead(lp, ingestPayloadSchema.parse(withAnswers([{ key: "goal", label: "Goal", value: "Lose weight" }, { key: "city", label: "City", value: "Pune" }])));
    const second = (await ingestLead(lp2, ingestPayloadSchema.parse(withAnswers([{ key: "your_goal", label: "Your goal", value: "Gain muscle" }])))).leadId;
    const admin = await makeUser("CLIENT_ADMIN", client.id);
    const headers = async () => (await leadColumns(admin, { clientId: client.id })).map((c) => c.header);

    const cols = await fieldColumns(admin, client.id);
    expect(cols.map((c) => c.key)).toEqual(expect.arrayContaining(["goal", "your_goal", "city"]));

    await mergeColumn(admin, client.id, "your_goal", "goal");
    await renameColumn(admin, client.id, "goal", "Fitness goal");
    expect(await headers()).toContain("Fitness goal");
    expect(await headers()).not.toContain("Your goal");
    const merged = (await leadColumns(admin, { clientId: client.id })).find((c) => c.header === "Fitness goal")!;
    expect(merged.value((await prisma.lead.findUniqueOrThrow({ where: { id: second } })) as never)).toBe("Gain muscle");

    await setColumnHidden(admin, client.id, "city", true);
    expect(await headers()).not.toContain("City");
    expect((await fieldColumns(admin, client.id)).find((c) => c.key === "city")?.hidden).toBe(true); // still listed, to show again

    // Merge into a fixed column, then undo it.
    await mergeColumn(admin, client.id, "goal", "tag");
    const fixed = (await fieldColumns(admin, client.id)).find((c) => c.fixed);
    expect(fixed?.label).toBe("tag");
    for (const f of fixed!.fields) await unmergeField(admin, f.id);
    expect((await fieldColumns(admin, client.id)).some((c) => c.fixed)).toBe(false);
  });

  it("members can't change fields; merging into an unknown column is refused", async () => {
    const { mergeColumn, renameColumn } = await import("@/lib/fieldManager");
    const { client, lp } = await makeClient("alpha");
    await ingestLead(lp, ingestPayloadSchema.parse(withAnswers([{ key: "goal", label: "Goal", value: "x" }])));
    const member = await makeUser("CLIENT_MEMBER", client.id);
    await expect(renameColumn(member, client.id, "goal", "Hack")).rejects.toBeInstanceOf(ForbiddenError);
    const admin = await makeUser("CLIENT_ADMIN", client.id);
    await expect(mergeColumn(admin, client.id, "goal", "nope")).rejects.toThrow(/not found/i);
    await expect(mergeColumn(admin, client.id, "goal", "goal")).rejects.toThrow(/different column/);
  });
});

describe("client branding", () => {
  beforeEach(resetDb);

  const png = () => new File([Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)])], "logo.png", { type: "image/png" });

  it("accepts real PNG/JPEG/WebP up to 300 KB; refuses SVG, fakes and big files; only admins", async () => {
    const { brandBySlug, removeLogo, saveLogo } = await import("@/lib/branding");
    const { client } = await makeClient("alpha");
    const admin = await makeUser("CLIENT_ADMIN", client.id);
    const member = await makeUser("CLIENT_MEMBER", client.id);

    await expect(saveLogo(member, client.id, png())).rejects.toBeInstanceOf(ForbiddenError);
    await expect(saveLogo(admin, client.id, new File(["<svg onload=alert(1)></svg>"], "x.svg", { type: "image/svg+xml" }))).rejects.toThrow(/PNG, JPEG or WebP/);
    await expect(saveLogo(admin, client.id, new File(["not really"], "x.png", { type: "image/png" }))).rejects.toThrow(/PNG, JPEG or WebP/);
    await expect(saveLogo(admin, client.id, new File([Buffer.alloc(301 * 1024)], "big.png", { type: "image/png" }))).rejects.toThrow(/300 KB/);

    await saveLogo(admin, client.id, png());
    const brand = await brandBySlug("alpha");
    expect(brand?.name).toBe("alpha");
    expect(brand?.logo).toMatch(/^\/api\/brand\/alpha\/logo\?v=\d+$/);
    await removeLogo(admin, client.id);
    expect((await brandBySlug("alpha"))?.logo).toBeNull();
    expect(await brandBySlug("no-such-client")).toBeNull();
  });
});
