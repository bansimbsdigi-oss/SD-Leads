import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { ingestClientWebhook } from "@/lib/ingest/clientWebhook";
import { guessRole, nestBracketKeys, normaliseWebhookBody, readBody, sourceKeyFromUrl } from "@/lib/ingest/webhook";
import { makeClient, resetDb } from "./helpers";

describe("webhook body parsing", () => {
  it("nests bracket keys", () => {
    expect(nestBracketKeys([["fields[name][value]", "Asha"], ["fields[name][title]", "Name"], ["tags[]", "a"], ["tags[]", "b"]])).toEqual({
      fields: { name: { value: "Asha", title: "Name" } },
      tags: { "0": "a", "1": "b" },
    });
  });

  it("reads urlencoded, json and multipart", async () => {
    const form = await readBody(new Request("http://x", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "Name=Asha&Phone=98765" }));
    expect(form).toEqual({ Name: "Asha", Phone: "98765" });
    const json = await readBody(new Request("http://x", { method: "POST", headers: { "content-type": "application/json" }, body: '{"a":1}' }));
    expect(json).toEqual({ a: 1 });
    const fd = new FormData();
    fd.set("email", "a@b.com");
    expect(await readBody(new Request("http://x", { method: "POST", body: fd }))).toEqual({ email: "a@b.com" });
    expect(await readBody(new Request("http://x", { method: "POST", headers: { "content-type": "application/json" }, body: "{bad" }))).toBeNull();
  });

  it("guesses core roles from keys and labels", () => {
    expect(guessRole("Mobile Number")).toBe("phone");
    expect(guessRole("whatsapp")).toBe("phone");
    expect(guessRole("Email Address")).toBe("email");
    expect(guessRole("Full Name")).toBe("name");
    expect(guessRole("company name")).toBeNull();
    expect(guessRole("budget")).toBeNull();
  });

  it("normalises Elementor simple format (labels as keys + metadata)", () => {
    const n = normaliseWebhookBody({
      Name: "Asha", Phone: "9876543210", "How often do you post?": "Weekly",
      Date: "October 29, 2026", Time: "10:30 am", "Page URL": "https://www.ritu.com/webinar/?utm_source=meta",
      "User Agent": "Mozilla", "Remote IP": "1.2.3.4", "Powered by": "Elementor", form_name: "Webinar form",
    });
    expect(n.fields.map((f) => [f.key, f.role])).toEqual([["Name", "name"], ["Phone", "phone"], ["How often do you post?", null]]);
    expect(n.pageUrl).toBe("https://www.ritu.com/webinar/?utm_source=meta");
    expect(n.formName).toBe("Webinar form");
    expect(n.tracking).toMatchObject({ ip: "1.2.3.4", user_agent: "Mozilla" });
  });

  it("normalises Elementor advanced format", () => {
    const n = normaliseWebhookBody({
      form: { id: "abc", name: "Quiz" },
      fields: {
        name: { id: "name", type: "text", title: "Your name", value: "Asha", raw_value: "Asha" },
        email: { id: "email", type: "email", title: "Email", value: "A@B.com", raw_value: "A@B.com" },
        q1: { id: "q1", type: "radio", title: "Posting", value: "Daily", raw_value: "Daily" },
      },
      meta: { page_url: { title: "Page URL", value: "https://ritu.com/quiz" }, remote_ip: { title: "Remote IP", value: "1.1.1.1" } },
    });
    expect(n.fields.map((f) => [f.key, f.label, f.role])).toEqual([["name", "Your name", "name"], ["email", "Email", "email"], ["q1", "Posting", null]]);
    expect(n.pageUrl).toBe("https://ritu.com/quiz");
    expect(n.formName).toBe("Quiz");
  });

  it("accepts our own lead.js shape unchanged", () => {
    const n = normaliseWebhookBody({ submission_id: "abc12345", fields: [{ key: "q", value: "x", score: 2 }], tracking: { page_url: "https://a.com/p" } });
    expect(n.submissionId).toBe("abc12345");
    expect(n.fields).toEqual([{ key: "q", value: "x", score: 2 }]);
    expect(n.pageUrl).toBe("https://a.com/p");
  });

  it("builds source keys from page URLs", () => {
    expect(sourceKeyFromUrl("https://www.Ritu.com/Webinar/?utm_source=x#top")).toBe("ritu.com/webinar");
    expect(sourceKeyFromUrl("https://ritu.com/")).toBe("ritu.com");
    expect(sourceKeyFromUrl("javascript:alert(1)")).toBeNull();
  });
});

describe("client webhook", () => {
  beforeEach(resetDb);

  it("files leads under an LP per page URL, creating LPs automatically", async () => {
    const { client } = await makeClient("ritu");
    const a = await ingestClientWebhook(client, { Name: "A", Phone: "9876500001", "Page URL": "https://ritu.com/webinar" });
    const b = await ingestClientWebhook(client, { Name: "B", Phone: "9876500002", "Page URL": "https://www.ritu.com/webinar/?utm_source=fb" });
    const c = await ingestClientWebhook(client, { Name: "C", Phone: "9876500003", "Page URL": "https://ritu.com/quiz" });
    if (!a.ok || !b.ok || !c.ok) throw new Error("expected ok");
    expect(a.lpId).toBe(b.lpId);
    expect(c.lpId).not.toBe(a.lpId);
    const lp = await prisma.landingPage.findUniqueOrThrow({ where: { id: a.lpId } });
    expect(lp).toMatchObject({ autoCreated: true, sourceKey: "ritu.com/webinar", name: "/webinar", allowedDomains: ["ritu.com"] });
    const lead = await prisma.lead.findUniqueOrThrow({ where: { id: a.leadId } });
    expect(lead).toMatchObject({ name: "A", phoneNormalised: "+919876500001", source: "webhook", clientId: client.id });
  });

  it("uses ?lp= to pin an existing LP, and the form name when there is no URL", async () => {
    const { client, lp } = await makeClient("ritu");
    const pinned = await ingestClientWebhook(client, { name: "A", "Page URL": "https://other.com/x" }, { lp: lp.lpKey });
    const byForm = await ingestClientWebhook(client, { name: "B", form_name: "Bootcamp" });
    const unknown = await ingestClientWebhook(client, { name: "C" });
    if (!pinned.ok || !byForm.ok || !unknown.ok) throw new Error("expected ok");
    expect(pinned.lpId).toBe(lp.id);
    expect((await prisma.landingPage.findUniqueOrThrow({ where: { id: byForm.lpId } })).name).toBe("Bootcamp");
    expect((await prisma.landingPage.findUniqueOrThrow({ where: { id: unknown.lpId } })).sourceKey).toBe("webhook:unknown");
  });

  it("an identical retry from the form tool does not create a second lead", async () => {
    const { client } = await makeClient("ritu");
    const body = { Name: "A", Phone: "9876500001", Date: "Oct 29", Time: "10:30", "Page URL": "https://ritu.com/w" };
    const [r1, r2] = await Promise.all([ingestClientWebhook(client, body), ingestClientWebhook(client, { ...body })]);
    if (!r1.ok || !r2.ok) throw new Error("expected ok");
    expect(r1.leadId).toBe(r2.leadId);
    expect(await prisma.lead.count()).toBe(1);
    expect(await prisma.landingPage.count({ where: { autoCreated: true } })).toBe(1);
  });

  it("keeps each client's leads in its own client", async () => {
    const a = await makeClient("alpha");
    const b = await makeClient("beta");
    const res = await ingestClientWebhook(a.client, { name: "X", "Page URL": "https://beta.com/page" });
    if (!res.ok) throw new Error("expected ok");
    const lead = await prisma.lead.findUniqueOrThrow({ where: { id: res.leadId }, include: { lp: true } });
    expect(lead.clientId).toBe(a.client.id);
    expect(lead.lp?.clientId).toBe(a.client.id);
    expect(await prisma.lead.count({ where: { clientId: b.client.id } })).toBe(0);
  });

  it("rejects empty bodies and paused LPs", async () => {
    const { client, lp } = await makeClient("ritu");
    expect(await ingestClientWebhook(client, {})).toMatchObject({ ok: false, status: 422 });
    await prisma.landingPage.update({ where: { id: lp.id }, data: { status: "paused" } });
    expect(await ingestClientWebhook(client, { name: "A" }, { lp: lp.lpKey })).toMatchObject({ ok: false, status: 403 });
  });
});

describe("scale and multi-client safety", () => {
  beforeEach(resetDb);

  it("concurrent first leads from a new page create exactly one LP", async () => {
    const { client } = await makeClient("ritu");
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => ingestClientWebhook(client, { name: `L${i}`, phone: `98765000${10 + i}`, "Page URL": "https://ritu.com/brand-new" })),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    expect(new Set(results.map((r) => (r.ok ? r.lpId : ""))).size).toBe(1);
    expect(await prisma.landingPage.count({ where: { autoCreated: true } })).toBe(1);
    expect(await prisma.lead.count()).toBe(8);
  });

  it("the same submission id, phone and page path on two clients stay two separate leads", async () => {
    const a = await makeClient("alpha");
    const b = await makeClient("beta");
    const body = { submission_id: "same-id-123", name: "Asha", phone: "9876543210", "Page URL": "https://shared.com/webinar" };
    const [ra, rb] = await Promise.all([ingestClientWebhook(a.client, body), ingestClientWebhook(b.client, body)]);
    if (!ra.ok || !rb.ok) throw new Error("expected ok");
    expect(ra.leadId).not.toBe(rb.leadId);
    expect(ra.duplicate || rb.duplicate).toBe(false);
    const lps = await prisma.landingPage.findMany({ where: { sourceKey: "shared.com/webinar" } });
    expect(lps.map((l) => l.clientId).sort()).toEqual([a.client.id, b.client.id].sort());
  });

  it("stores searchable text and skips registry writes when nothing changed", async () => {
    const { client } = await makeClient("ritu");
    const r = await ingestClientWebhook(client, { name: "Asha Rao", phone: "9876543210", Goal: "Launch a Course", "Page URL": "https://ritu.com/w" });
    if (!r.ok) throw new Error("expected ok");
    const lead = await prisma.lead.findUniqueOrThrow({ where: { id: r.leadId } });
    expect(lead.searchText).toContain("asha rao");
    expect(lead.searchText).toContain("919876543210");
    expect(lead.searchText).toContain("launch a course");

    const before = await prisma.formField.findMany({ where: { lpId: r.lpId }, orderBy: { fieldKey: "asc" } });
    await ingestClientWebhook(client, { name: "Ravi", phone: "9876543211", Goal: "x", "Page URL": "https://ritu.com/w" });
    const after = await prisma.formField.findMany({ where: { lpId: r.lpId }, orderBy: { fieldKey: "asc" } });
    expect(after.map((f) => f.lastSeenAt.getTime())).toEqual(before.map((f) => f.lastSeenAt.getTime()));
  });
});

describe("envelope payloads", () => {
  it("lifts answers out of data{} and treats the outer name as the form's name (Webflow style)", () => {
    const n = normaliseWebhookBody({
      name: "General Contact Form",
      site: "62749158efef318abc8d5a0f",
      id: "6321a1b0c12c3e5f",
      submittedAt: "2026-10-31T08:01:00Z",
      data: { Name: "Alex Morgan", Email: "alex@morgan.io", Phone: "9811100003", Message: "Need a quote", "Page URL": "https://lax.example.com/index.html" },
    });
    expect(n.formName).toBe("General Contact Form");
    expect(n.submissionId).toBe("6321a1b0c12c3e5f");
    expect(n.fields.map((f) => [f.key, f.role])).toEqual([["Name", "name"], ["Email", "email"], ["Phone", "phone"], ["Message", null]]);
    expect(n.pageUrl).toBe("https://lax.example.com/index.html");
    expect(n.tracking).toMatchObject({ site: "62749158efef318abc8d5a0f", submittedat: "2026-10-31T08:01:00Z" });
  });

  it("leaves flat bodies and lead.js / Elementor shapes alone", () => {
    expect(normaliseWebhookBody({ name: "Asha", phone: "98765" }).fields.map((f) => f.key)).toEqual(["name", "phone"]);
    expect(normaliseWebhookBody({ fields: [{ key: "q", value: "x" }] }).fields).toHaveLength(1);
  });
});

describe("merged columns", () => {
  beforeEach(resetDb);

  it("one column per field across landing pages and clients, also for All clients", async () => {
    const { answerFields } = await import("@/lib/leadQuery");
    const { makeUser } = await import("./helpers");
    const a = await makeClient("alpha");
    const b = await makeClient("beta");
    await ingestClientWebhook(a.client, { "Full Name": "A", "Email Address": "a@x.com", City: "Pune", Budget: "5L+", "Page URL": "https://alpha.com/one" });
    await ingestClientWebhook(a.client, { name: "B", EMAIL: "b@x.com", "Your City": "Delhi", "Page URL": "https://alpha.com/two" });
    await ingestClientWebhook(b.client, { name: "C", email: "c@x.com", city: "Goa", Message: "hi", "Page URL": "https://beta.com/p" });

    const admin = await makeUser("SUPER_ADMIN", null);
    const all = await answerFields(admin, {});
    expect(all.map((f) => f.key).sort()).toEqual(["budget", "city", "message"]); // name/email are core columns, city merged
    const one = await answerFields(admin, { clientId: a.client.id });
    expect(one.map((f) => f.key).sort()).toEqual(["budget", "city"]);

    // Email variants filled the core Email column, so nothing landed only in answers.
    const leads = await prisma.lead.findMany({ orderBy: { createdAt: "asc" } });
    expect(leads.map((l) => [l.name, l.emailNormalised])).toEqual([["A", "a@x.com"], ["B", "b@x.com"], ["C", "c@x.com"]]);
  });
});

describe("forms that send page details next to the answers", () => {
  beforeEach(resetDb);

  // Same fields as the live "Project & Quote Request Form".
  const projectForm = {
    page_identity: "project_quote_request",
    page_name: "Project & Quote Request Form",
    page_path: "/project-request.html",
    formType: "Project & Quote Request",
    name: "Sabhi Digital",
    email: "bansi.mbsdigi@gmail.com",
    company: "SD",
    phone: "9876543210",
    service: "Mobile App Development",
    timeline: "Flexible / Ongoing",
    budget: "$15,000 - $35,000",
    message: "Need an app",
    preferredContact: "Email",
    referralSource: "Google / Search Engine",
  };

  it("uses the person's name, not the page name, and keeps page details out of the answers", async () => {
    const { client } = await makeClient("lax");
    const r = await ingestClientWebhook(client, projectForm);
    if (!r.ok) throw new Error("expected ok");
    const lead = await prisma.lead.findUniqueOrThrow({ where: { id: r.leadId }, include: { lp: true } });
    expect(lead.name).toBe("Sabhi Digital");
    expect(lead.phoneNormalised).toBe("+919876543210");
    expect(lead.emailNormalised).toBe("bansi.mbsdigi@gmail.com");
    expect(lead.answers).not.toHaveProperty("page_name");
    expect(lead.answers).toMatchObject({ company: "SD", budget: "$15,000 - $35,000", preferredcontact: "Email" });
    expect(lead.tracking).toMatchObject({ page_identity: "project_quote_request", page_path: "/project-request.html", form_name: "Project & Quote Request Form" });
    expect(lead.lp?.name).toBe("Project & Quote Request Form");
  });

  it("is strict about which fields are the person's name, email and phone", () => {
    expect(guessRole("page_name")).toBeNull();
    expect(guessRole("form_name")).toBeNull();
    expect(guessRole("company_name")).toBeNull();
    expect(guessRole("user_name")).toBeNull();
    expect(guessRole("product_name")).toBeNull();
    expect(guessRole("name")).toBe("name");
    expect(guessRole("Your Full Name")).toBe("name");
    expect(guessRole("first_name")).toBe("name");
    expect(guessRole("Name as on ID")).toBe("name");
    expect(guessRole("email_consent")).toBeNull();
    expect(guessRole("preferredContact")).toBeNull();
    expect(guessRole("Email (work)")).toBe("email");
    expect(guessRole("Phone (with country code)")).toBe("phone");
  });

  it("joins first and last name when there is no full-name field, and skips invalid emails", async () => {
    const { client } = await makeClient("lax");
    const r = await ingestClientWebhook(client, { first_name: "Asha", last_name: "Rao", "Email (work)": "not given", "Your Email": "asha@rao.in" });
    if (!r.ok) throw new Error("expected ok");
    const lead = await prisma.lead.findUniqueOrThrow({ where: { id: r.leadId } });
    expect([lead.name, lead.emailNormalised]).toEqual(["Asha Rao", "asha@rao.in"]);
  });

  it("the one-time repair restores names that were saved as the page title", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const { client, lp } = await makeClient("lax");
    const wrong = await prisma.lead.create({
      data: { clientId: client.id, lpId: lp.id, submissionId: "old-1", name: "Project & Quote Request Form", answers: projectForm },
    });
    const untouched = await prisma.lead.create({
      data: { clientId: client.id, lpId: lp.id, submissionId: "old-2", name: "Asha", answers: { name: "Asha", page_name: "Contact" } },
    });
    const dir = readdirSync("prisma/migrations").find((d) => d.endsWith("fix_form_name_as_lead_name"))!;
    await prisma.$executeRawUnsafe(readFileSync(`prisma/migrations/${dir}/migration.sql`, "utf8"));
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: wrong.id } })).name).toBe("Sabhi Digital");
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: untouched.id } })).name).toBe("Asha");
  });
});

describe("tracking columns", () => {
  beforeEach(resetDb);

  it("shows every tracking detail the leads carry, page URL and UTMs first", async () => {
    const { leadColumns } = await import("@/lib/leadColumns");
    const { makeUser } = await import("./helpers");
    const { client } = await makeClient("vinita");
    await ingestClientWebhook(client, {
      name: "test divya", email: "test@gmail.com", phone: "1231231231", ref: "Ref", utm_placement: "feed",
      _fbp: "fb.1.17885892574.31368", page_url: "https://vinitabaghela.com/masterclass.html", Pixel_ID: "1079024314651914",
    });
    const admin = await makeUser("SUPER_ADMIN", null);
    const cols = await leadColumns(admin, {});
    // utm_placement and fbp have fixed columns; only Page URL is an extra tracking column.
    const tracking = cols.filter((c) => c.id.startsWith("t:")).map((c) => c.header);
    expect(tracking).toEqual(["Page URL"]);
    const lead = await prisma.lead.findFirstOrThrow();
    expect(cols.find((c) => c.header === "Fbp")!.value(lead as never)).toBe("fb.1.17885892574.31368");
    expect(cols.find((c) => c.header === "utm_placement")!.value(lead as never)).toBe("feed");
    expect(lead.answers).not.toHaveProperty("utm_placement"); // utm_* counts as tracking
    expect(cols.find((c) => c.header === "Pixel_ID")!.value(lead as never)).toBe("1079024314651914");
  });

  it("a condition on a tracking field no lead has yet matches nothing, not everything", async () => {
    const { leadMatchesConditions } = await import("@/lib/leadQuery");
    const { client } = await makeClient("vinita");
    const r = await ingestClientWebhook(client, { name: "A", email: "a@x.com" });
    if (!r.ok) throw new Error("expected ok");
    expect(await leadMatchesConditions(client.id, r.leadId, [{ field: "t:utm_source", op: "is", value: "meta" }])).toBe(false);
    expect(await leadMatchesConditions(client.id, r.leadId, [{ field: "t:utm_source", op: "empty" }])).toBe(true);
  });
});

describe("fixed column layout", () => {
  beforeEach(resetDb);

  const HEADERS = [
    "Date of Registration", "name", "Mobile", "email", "tag", "Formatted WhatsApp Number", "Source",
    "utm_term", "utm_source", "utm_content", "utm_campaign", "utm_placement", "fbclid", "gclid", "utm_medium",
    "Zoom Direct LInk", "Zoom Direct Button", "Zoom Webinar Link", "Zoom Webinar Button", "New Zoom Direct Link", "New Zoom Direct Button",
    "Fbc", "Fbp", "Pixel_ID", "Source_Platform", "Timestamp", "IP Address", "UserAgent", "AccessT", "Campaign_ID", "Adset_ID", "Ad_ID",
  ];

  it("starts with the fixed columns in order for every client, extras at the end", async () => {
    const { leadColumns } = await import("@/lib/leadColumns");
    const { makeUser } = await import("./helpers");
    const { client } = await makeClient("vinita");
    const r = await ingestClientWebhook(client, {
      Name: "Divya", Mobile: "9876500011", Email: "d@x.com", Tag: "Hot",
      "Zoom Direct LInk": "https://zoom.us/j/1", "Pixel_ID": "107902", client_ip_address: "157.48.1.1",
      client_user_agent: "Mozilla/5.0", event_time: "1793437516", Campaign_ID: "c1", "Ad Set ID": "s1",
      Budget: "5L+", "Page URL": "https://vinita.com/masterclass",
    });
    if (!r.ok) throw new Error("expected ok");
    const admin = await makeUser("SUPER_ADMIN", null);
    const cols = await leadColumns(admin, { clientId: client.id });
    expect(cols.slice(0, HEADERS.length).map((c) => c.header)).toEqual(HEADERS);
    const rest = cols.slice(HEADERS.length).map((c) => c.header);
    expect(rest.slice(0, 5)).toEqual(["Status", "Owner", "Landing page", "Received via", "Score"]);
    expect(rest.slice(5)).toEqual(["Budget", "Page URL"]); // anything else goes at the end

    const lead = await prisma.lead.findUniqueOrThrow({ where: { id: r.leadId } });
    const v = (h: string) => cols.find((c) => c.header === h)!.value(lead as never);
    expect([v("name"), v("Mobile"), v("email"), v("tag")]).toEqual(["Divya", "+919876500011", "d@x.com", "Hot"]);
    expect(v("Formatted WhatsApp Number")).toBe("919876500011"); // built from Mobile
    expect(v("Source")).toBe("Webhook"); // no source sent: how it arrived
    expect([v("Zoom Direct LInk"), v("Pixel_ID"), v("IP Address"), v("UserAgent"), v("Timestamp")]).toEqual([
      "https://zoom.us/j/1", "107902", "157.48.1.1", "Mozilla/5.0", "1793437516",
    ]);
    expect([v("Campaign_ID"), v("Adset_ID")]).toEqual(["c1", "s1"]);
  });

  it("fixed columns can be filtered and sorted like any other", async () => {
    const { leadFieldDefs, queryLeads } = await import("@/lib/leadQuery");
    const { makeUser } = await import("./helpers");
    const { client } = await makeClient("vinita");
    await ingestClientWebhook(client, { name: "A", email: "a@x.com", source: "Instagram" });
    await ingestClientWebhook(client, { name: "B", email: "b@x.com" });
    const admin = await makeUser("SUPER_ADMIN", null);
    const defs = await leadFieldDefs(admin, { clientId: client.id });
    const q = (conditions: { field: string; op: "is"; value: string }[]) =>
      queryLeads(admin, { clientId: client.id, conditions, dir: "asc", sort: "s:source", page: 1, pageSize: 25 }, defs);
    expect((await q([{ field: "s:source", op: "is", value: "Instagram" }])).rows.map((l) => l.name)).toEqual(["A"]);
    expect((await q([{ field: "s:source", op: "is", value: "webhook" }])).rows.map((l) => l.name)).toEqual(["B"]);
    expect((await q([])).rows.map((l) => l.name)).toEqual(["A", "B"]); // "Instagram" < "Webhook"
  });
});
