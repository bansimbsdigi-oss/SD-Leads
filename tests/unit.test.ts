import { describe, expect, it } from "vitest";
import { assignFieldKeys, formVersionHash, toFieldKey } from "@/lib/ingest/fieldKeys";
import { isOriginAllowed } from "@/lib/ingest/guards";
import { normaliseEmail, normalisePhone } from "@/lib/ingest/normalise";
import { ingestPayloadSchema } from "@/lib/ingest/schema";
import { toCsv } from "@/lib/leadColumns";

describe("field keys", () => {
  it("lowercases and replaces non-alphanumerics", () => {
    expect(toFieldKey("Your City?")).toBe("your_city");
    expect(toFieldKey("q-1")).toBe("q_1");
    expect(toFieldKey("x".repeat(100))).toHaveLength(64);
  });
  it("renames reserved keys", () => {
    expect(toFieldKey("submission_id")).toBe("submission_id_field");
    expect(toFieldKey("LP")).toBe("lp_field");
  });
  it("suffixes duplicates within one submission", () => {
    expect(assignFieldKeys(["q", "Q", "q", "city"])).toEqual(["q", "q_2", "q_3", "city"]);
  });
  it("version hash ignores order but not types", () => {
    const a = formVersionHash([{ key: "a", type: "text" }, { key: "b", type: "tel" }]);
    expect(formVersionHash([{ key: "b", type: "tel" }, { key: "a", type: "text" }])).toBe(a);
    expect(formVersionHash([{ key: "a", type: "text" }, { key: "b", type: "text" }])).not.toBe(a);
  });
});

describe("normalisation", () => {
  it.each(["9876543210", "98765 43210", "+91 98765-43210", "919876543210", "09876543210", "0091 9876543210"])(
    "phone %s → +919876543210",
    (raw) => expect(normalisePhone(raw)).toBe("+919876543210"),
  );
  it("keeps foreign numbers and rejects junk", () => {
    expect(normalisePhone("+44 20 7946 0958")).toBe("+442079460958");
    expect(normalisePhone("12345")).toBeNull();
    expect(normalisePhone("")).toBeNull();
  });
  it("email lowercase + trim", () => {
    expect(normaliseEmail("  Asha@Example.COM ")).toBe("asha@example.com");
    expect(normaliseEmail("not-an-email")).toBeNull();
  });
});

describe("origin check", () => {
  const allowed = ["ritu.com", "localhost"];
  it("allows exact and subdomain matches", () => {
    expect(isOriginAllowed("https://ritu.com", allowed)).toBe(true);
    expect(isOriginAllowed("https://www.ritu.com", allowed)).toBe(true);
    expect(isOriginAllowed("http://localhost:3000", allowed)).toBe(true);
  });
  it("rejects lookalikes and missing origins", () => {
    expect(isOriginAllowed("https://evilritu.com", allowed)).toBe(false);
    expect(isOriginAllowed("https://ritu.com.evil.io", allowed)).toBe(false);
    expect(isOriginAllowed(null, allowed)).toBe(false);
    expect(isOriginAllowed("null", allowed)).toBe(false);
  });
});

describe("payload schema", () => {
  const base = { submission_id: "abcdefgh-1234", fields: [{ key: "a", value: "x" }] };
  it("accepts a minimal payload", () => expect(ingestPayloadSchema.safeParse(base).success).toBe(true));
  it("limits field count and value length", () => {
    const many = { ...base, fields: Array.from({ length: 101 }, (_, i) => ({ key: `f${i}`, value: "x" })) };
    expect(ingestPayloadSchema.safeParse(many).success).toBe(false);
    const long = { ...base, fields: [{ key: "a", value: "x".repeat(5001) }] };
    expect(ingestPayloadSchema.safeParse(long).success).toBe(false);
  });
});

describe("csv", () => {
  it("escapes quotes, commas and formula prefixes", () => {
    const cols = [{ id: "a", header: "A", value: (r: { v: string }) => r.v }];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const csv = toCsv(cols as any, [{ v: 'he said "hi", ok' }, { v: "=SUM(A1)" }] as any);
    expect(csv).toContain('"he said ""hi"", ok"');
    expect(csv).toContain("'=SUM(A1)");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(toCsv(cols as any, [{ v: "+919876543210" }] as any)).toContain("\r\n+919876543210");
  });
});

describe("chart axis", () => {
  it("uses 4 clean whole-number steps", async () => {
    const { niceAxis } = await import("@/lib/chartScale");
    expect(niceAxis(0)).toEqual({ max: 4, ticks: [0, 1, 2, 3, 4] });
    expect(niceAxis(4).ticks).toEqual([0, 1, 2, 3, 4]);
    expect(niceAxis(6).ticks).toEqual([0, 2, 4, 6, 8]);
    expect(niceAxis(57).ticks).toEqual([0, 20, 40, 60, 80]);
    expect(niceAxis(84_079).ticks).toEqual([0, 25000, 50000, 75000, 100000]);
    expect(niceAxis(9).ticks).toEqual([0, 3, 6, 9, 12]);
  });
});
