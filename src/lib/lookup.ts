// Lead lookup: is a lead in the client's Mentor sheet, Sub-mentor sheet, or neither? The two Google Sheets
// stay in Google and are read live (at most every few minutes; the last good copy is kept for outages).
// New leads are checked as they arrive and the result rides along in their webhook; Pabbly can also call
// the lookup API for leads that never come through SD-Leads.
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { newWebhookToken } from "@/lib/crypto";
import { logger } from "@/lib/logger";
import { LEAD_TYPE_LABEL, type LeadType } from "@/lib/lookupLabels";
import { postJson, webhookTarget } from "@/lib/outbound/webhooks";
import { enqueue } from "@/lib/queue";
import { can, canSeeClient, ForbiddenError, NotFoundError, type Ctx } from "@/lib/tenant";

export type Sheet = "mentor" | "subMentor";
export type SheetRow = { email: string | null; phone: string | null; name: string; mentor: string | null };
export type LookupResult = { leadType: LeadType; mentorName: string | null; subMentorName: string | null; matchedBy: "email" | "phone" | null };

export { LEAD_TYPE_LABEL, type LeadType };

// ---------- Matching keys ----------

export const emailKey = (v: unknown) => {
  const s = typeof v === "string" ? v.trim().toLowerCase().replace(/\s+/g, "") : "";
  return s.includes("@") ? s : null;
};
/** Last 10 digits: +91 98765 43210, 098765-43210 and 9876543210 all match. */
export const phoneKey = (v: unknown) => {
  const d = (typeof v === "number" ? String(v) : typeof v === "string" ? v : "").replace(/\D/g, "");
  return d.length >= 7 ? d.slice(-10) : null;
};

// ---------- Reading a Google Sheet ----------

/** A normal sheet link → its CSV download (published "pubhtml" links too). Only Google Sheets links. */
export function sheetCsvUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new Error("That isn't a link. Paste the Google Sheet's address from the browser.");
  }
  if (u.protocol !== "https:" || u.hostname !== "docs.google.com" || !u.pathname.startsWith("/spreadsheets/")) {
    throw new Error("Use a Google Sheets link (docs.google.com/spreadsheets/…).");
  }
  const published = /^\/spreadsheets\/d\/e\/([\w-]+)\//.exec(u.pathname);
  if (published) {
    const gid = u.searchParams.get("gid");
    return `https://docs.google.com/spreadsheets/d/e/${published[1]}/pub?output=csv${gid ? `&gid=${gid}` : ""}`;
  }
  const id = /^\/spreadsheets\/d\/([\w-]+)/.exec(u.pathname)?.[1];
  if (!id) throw new Error("Couldn't find the sheet in that link.");
  const gid = u.searchParams.get("gid") ?? /gid=(\d+)/.exec(u.hash)?.[1];
  return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv${gid ? `&gid=${gid}` : ""}`;
}

/** RFC 4180-ish CSV: quoted fields, doubled quotes, commas and line breaks inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => f.trim()));
}

const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const EMAIL_HEADERS = new Set(["email", "email id", "e mail", "mail", "email address", "mail id", "e mail id"]);
const PHONE_HEADERS = new Set([
  "phone", "phone number", "phone no", "mobile", "mobile number", "mobile no", "whatsapp", "whatsapp number", "whatsapp no",
  "contact", "contact number", "contact no", "number", "mob", "mob no", "cell",
]);
const MENTOR_HEADERS = new Set(["mentor name", "mentor", "mentors name", "name of mentor"]);
const SUB_HEADERS = new Set(["sub mentor name", "submentor name", "sub mentor", "submentor", "sub mentors name", "name of sub mentor"]);

/**
 * Rows of a Mentor or Sub-mentor sheet. The header row is found by name, in any order, within the
 * first five rows. Rows without an email or phone are skipped; the first row for a person wins.
 */
export function readSheetRows(csv: string, sheet: Sheet): SheetRow[] {
  const rows = parseCsv(csv);
  const headerAt = rows.slice(0, 5).findIndex((r) => r.some((h) => EMAIL_HEADERS.has(norm(h)) || PHONE_HEADERS.has(norm(h))));
  if (headerAt < 0) throw new Error("No Email or Phone column found in the first rows. Check the header names.");
  const header = rows[headerAt].map(norm);
  const col = (names: Set<string>) => header.findIndex((h) => names.has(h));
  const email = col(EMAIL_HEADERS);
  const phone = col(PHONE_HEADERS);
  const nameCol = sheet === "mentor" ? col(MENTOR_HEADERS) : col(SUB_HEADERS);
  const mentorCol = sheet === "subMentor" ? col(MENTOR_HEADERS) : -1;
  if (nameCol < 0) throw new Error(sheet === "mentor" ? "No “Mentor Name” column found." : "No “Sub Mentor Name” column found.");
  return rows.slice(headerAt + 1).flatMap((r) => {
    const e = email >= 0 ? emailKey(r[email]) : null;
    const p = phone >= 0 ? phoneKey(r[phone]) : null;
    if (!e && !p) return [];
    return [{ email: e, phone: p, name: (r[nameCol] ?? "").trim(), mentor: mentorCol >= 0 ? (r[mentorCol] ?? "").trim() || null : null }];
  });
}

const MAX_CSV = 5 * 1024 * 1024;

async function downloadSheet(url: string): Promise<string> {
  const res = await fetch(sheetCsvUrl(url), { redirect: "follow", signal: AbortSignal.timeout(15_000), headers: { "User-Agent": "SabhiLeads-Lookup/1" } });
  if ([400, 401, 403, 404].includes(res.status)) throw new Error("Google couldn't open that sheet. Check the link, and that it's shared as “Anyone with the link can view”.");
  if (!res.ok) throw new Error(`Google answered ${res.status}. Try again in a minute.`);
  if ((res.headers.get("content-type") ?? "").includes("text/html")) throw new Error("The sheet isn't shared. Set it to “Anyone with the link can view”, or publish it to the web as CSV.");
  const text = await res.text();
  if (text.length > MAX_CSV) throw new Error("The sheet is larger than 5 MB.");
  return text;
}

// ---------- Settings and the cached copies ----------

const FIELDS = {
  mentor: { url: "mentorSheetUrl", rows: "mentorRows", readAt: "mentorReadAt", error: "mentorError" },
  subMentor: { url: "subMentorSheetUrl", rows: "subMentorRows", readAt: "subMentorReadAt", error: "subMentorError" },
} as const;

type Config = NonNullable<Awaited<ReturnType<typeof prisma.lookupConfig.findUnique>>>;

/** Re-reads a sheet when its copy is older than the refresh time (or `force`). Keeps the last good copy on failure. */
async function freshRows(cfg: Config, sheet: Sheet, force = false): Promise<{ rows: SheetRow[]; error: string | null; readAt: Date | null }> {
  const f = FIELDS[sheet];
  const url = cfg[f.url];
  const cached = (cfg[f.rows] as SheetRow[] | null) ?? [];
  if (!url) return { rows: [], error: null, readAt: null };
  const age = cfg[f.readAt] ? Date.now() - cfg[f.readAt]!.getTime() : Infinity;
  if (!force && age < cfg.refreshMinutes * 60_000 && !cfg[f.error]) return { rows: cached, error: null, readAt: cfg[f.readAt] };
  try {
    const rows = readSheetRows(await downloadSheet(url), sheet);
    const readAt = new Date();
    await prisma.lookupConfig.update({ where: { clientId: cfg.clientId }, data: { [f.rows]: rows, [f.readAt]: readAt, [f.error]: null } });
    return { rows, error: null, readAt };
  } catch (err) {
    const error = err instanceof Error ? err.message.slice(0, 300) : "Couldn't read the sheet.";
    await prisma.lookupConfig.update({ where: { clientId: cfg.clientId }, data: { [f.error]: error } });
    logger.warn({ clientId: cfg.clientId, sheet, error }, "lookup sheet read failed; using last good copy");
    return { rows: cached, error, readAt: cfg[f.readAt] };
  }
}

function find(rows: SheetRow[], email: string | null, phone: string | null) {
  // Email first, then phone; the first row wins.
  const byEmail = email ? rows.find((r) => r.email === email) : undefined;
  if (byEmail) return { row: byEmail, by: "email" as const };
  const byPhone = phone ? rows.find((r) => r.phone === phone) : undefined;
  return byPhone ? { row: byPhone, by: "phone" as const } : null;
}

/** The matching rules: Mentor sheet first; a lead in both is Mentor's lead with the sub-mentor's name filled in. */
export function matchLead(mentorRows: SheetRow[], subRows: SheetRow[], lead: { email?: unknown; phone?: unknown }): LookupResult {
  const email = emailKey(lead.email);
  const phone = phoneKey(lead.phone);
  const m = find(mentorRows, email, phone);
  const s = find(subRows, email, phone);
  if (m) return { leadType: "mentor", mentorName: m.row.name || null, subMentorName: s?.row.name || null, matchedBy: m.by };
  if (s) return { leadType: "sub_mentor", mentorName: s.row.mentor, subMentorName: s.row.name || null, matchedBy: s.by };
  return { leadType: "none", mentorName: null, subMentorName: null, matchedBy: null };
}

async function lookupFor(cfg: Config, lead: { email?: unknown; phone?: unknown }) {
  const [m, s] = await Promise.all([freshRows(cfg, "mentor"), freshRows(cfg, "subMentor")]);
  return matchLead(m.rows, s.rows, lead);
}

/** The payload Pabbly receives: the same fields for every result, so they're mapped once. */
export function lookupPayload(r: LookupResult, lead: { name?: string | null; email?: string | null; phone?: string | null }, source: "lead" | "api" | "panel", at = new Date()) {
  return {
    event: "lead_lookup",
    event_name: "Lead Lookup",
    lead_type: r.leadType,
    lead_type_label: LEAD_TYPE_LABEL[r.leadType],
    is_mentor_lead: r.leadType === "mentor",
    is_sub_mentor_lead: r.leadType === "sub_mentor",
    is_none_of_above: r.leadType === "none",
    name: lead.name ?? "",
    email: lead.email ?? "",
    phone: lead.phone ?? "",
    mentor_name: r.mentorName ?? "",
    sub_mentor_name: r.subMentorName ?? "",
    matched_by: r.matchedBy ?? "",
    source,
    checked_at: new Date(at.getTime() + 330 * 60_000).toISOString().replace("Z", "+05:30").replace(/\.\d{3}/, ""),
  };
}

const configured = (cfg: Config | null): cfg is Config => Boolean(cfg?.enabled && (cfg.mentorSheetUrl || cfg.subMentorSheetUrl));

// ---------- New leads (automatic) ----------

/** Checks a new lead and saves the result on it, before its webhooks go out. Never throws. */
export async function lookupNewLead(leadId: string) {
  try {
    const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { id: true, clientId: true, name: true, emailNormalised: true, phoneNormalised: true } });
    if (!lead || (!lead.emailNormalised && !lead.phoneNormalised)) return null;
    const cfg = await prisma.lookupConfig.findUnique({ where: { clientId: lead.clientId } });
    if (!configured(cfg)) return null;
    const r = await lookupFor(cfg, { email: lead.emailNormalised, phone: lead.phoneNormalised });
    await saveOnLead(lead.id, r);
    await prisma.leadLookup.create({
      data: {
        clientId: lead.clientId, leadId: lead.id, name: lead.name, email: lead.emailNormalised, phone: lead.phoneNormalised,
        leadType: r.leadType, mentorName: r.mentorName, subMentorName: r.subMentorName, matchedBy: r.matchedBy,
        source: "lead", webhookStatus: "with_lead",
        payload: lookupPayload(r, { name: lead.name, email: lead.emailNormalised, phone: lead.phoneNormalised }, "lead"),
      },
    });
    return r;
  } catch (err) {
    logger.error({ err, leadId }, "lead lookup failed");
    return null;
  }
}

const saveOnLead = (id: string, r: LookupResult) =>
  prisma.lead.update({ where: { id }, data: { lookupType: r.leadType, mentorName: r.mentorName, subMentorName: r.subMentorName, lookupMatchedBy: r.matchedBy, lookupAt: new Date() } });

// ---------- API (Pabbly) and checks by hand ----------

export class LookupInputError extends Error {}

/** Picks name / email / phone out of a JSON or form body, accepting common alternative names. */
export function lookupInput(body: Record<string, unknown>) {
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      const v = body[k] ?? body[k.toLowerCase()];
      if ((typeof v === "string" && v.trim()) || typeof v === "number") return String(v).trim();
    }
    return "";
  };
  const name = pick("name", "full_name", "fullName", "Name", "lead_name");
  const email = pick("email", "Email", "email_address", "email_id", "mail");
  const phone = pick("phone", "Phone", "mobile", "phone_number", "mobile_number", "whatsapp", "whatsapp_number", "contact", "number");
  if (!emailKey(email) && !phoneKey(phone)) throw new LookupInputError("Send an email or a phone number.");
  return { name: name.slice(0, 200) || null, email: email.slice(0, 200) || null, phone: phone.slice(0, 40) || null };
}

/** Looks up a lead, saves it and (when `send`) queues it to the client's lookup webhook. */
export async function lookupAndLog(clientId: string, input: { name: string | null; email: string | null; phone: string | null }, source: "api" | "panel", send: boolean) {
  const cfg = await prisma.lookupConfig.findUnique({ where: { clientId } });
  if (!configured(cfg)) throw new Error("Lead lookup isn't set up for this client yet: add the sheet links first.");
  const r = await lookupFor(cfg, input);
  const payload = lookupPayload(r, input, source);
  const willSend = send && Boolean(cfg.webhookId);
  const row = await prisma.leadLookup.create({
    data: {
      clientId, name: input.name, email: input.email, phone: input.phone, leadType: r.leadType, mentorName: r.mentorName,
      subMentorName: r.subMentorName, matchedBy: r.matchedBy, source, payload,
      webhookStatus: !send ? "not_sent" : cfg.webhookId ? "not_sent" : "off",
    },
  });
  if (willSend) await enqueue("lookup.deliver", { lookupId: row.id }, { attempts: 3, backoffMs: 20_000, jobId: `lookup-${row.id}` });
  return { result: r, payload, lookupId: row.id };
}

/** Sends one saved lookup to the client's lookup webhook. Throws on failure so the queue retries. */
export async function deliverLookup(lookupId: string) {
  const row = await prisma.leadLookup.findUnique({ where: { id: lookupId } });
  if (!row) return;
  const cfg = await prisma.lookupConfig.findUnique({ where: { clientId: row.clientId } });
  const target = cfg?.webhookId ? await webhookTarget(cfg.webhookId, row.clientId) : null;
  if (!target) {
    await prisma.leadLookup.update({ where: { id: lookupId }, data: { webhookStatus: "off", webhookError: "No lookup webhook chosen" } });
    return;
  }
  const res = await postJson(target.url, row.payload);
  await prisma.leadLookup.update({ where: { id: lookupId }, data: { webhookStatus: res.ok ? "sent" : "failed", webhookError: res.error } });
  if (!res.ok) throw new Error(`Lookup webhook failed: ${res.error}`);
}

// ---------- Settings page ----------

function assertView(ctx: Ctx, clientId: string) {
  if (!canSeeClient(ctx, clientId)) throw new NotFoundError("Client not found");
  if (!can.editFields(ctx, clientId)) throw new ForbiddenError();
}
function assertManage(ctx: Ctx, clientId: string) {
  assertView(ctx, clientId);
  if (!can.manageLps(ctx, clientId)) throw new ForbiddenError();
}

export async function getLookupConfig(ctx: Ctx, clientId: string) {
  assertView(ctx, clientId);
  return prisma.lookupConfig.findUnique({ where: { clientId } });
}

export async function saveLookupConfig(ctx: Ctx, clientId: string, input: { mentorSheetUrl: string; subMentorSheetUrl: string; webhookId: string; refreshMinutes: number; enabled: boolean }) {
  assertManage(ctx, clientId);
  const mentor = input.mentorSheetUrl.trim() || null;
  const sub = input.subMentorSheetUrl.trim() || null;
  for (const u of [mentor, sub]) if (u) sheetCsvUrl(u); // throws a friendly error for a wrong link
  if (input.webhookId && !(await webhookTarget(input.webhookId, clientId))) throw new NotFoundError("Webhook not found");
  const refreshMinutes = Math.min(60, Math.max(1, Math.round(input.refreshMinutes || 2)));
  const before = await prisma.lookupConfig.findUnique({ where: { clientId } });
  const data = {
    mentorSheetUrl: mentor, subMentorSheetUrl: sub, webhookId: input.webhookId || null, refreshMinutes, enabled: input.enabled,
    // A changed link starts from scratch.
    ...(before?.mentorSheetUrl !== mentor ? { mentorRows: Prisma.DbNull, mentorReadAt: null, mentorError: null } : {}),
    ...(before?.subMentorSheetUrl !== sub ? { subMentorRows: Prisma.DbNull, subMentorReadAt: null, subMentorError: null } : {}),
  };
  await prisma.lookupConfig.upsert({ where: { clientId }, update: data, create: { clientId, apiToken: newWebhookToken(), ...data } });
  await prisma.auditLog.create({ data: { actorId: ctx.userId, clientId, action: "lookup.settings", target: clientId } });
  await reloadSheets(ctx, clientId);
}

export async function rotateLookupToken(ctx: Ctx, clientId: string) {
  assertManage(ctx, clientId);
  await prisma.lookupConfig.update({ where: { clientId }, data: { apiToken: newWebhookToken() } });
  await prisma.auditLog.create({ data: { actorId: ctx.userId, clientId, action: "lookup.rotate_token", target: clientId } });
}

/** Re-reads both sheets now. */
export async function reloadSheets(ctx: Ctx, clientId: string) {
  assertView(ctx, clientId);
  const cfg = await prisma.lookupConfig.findUnique({ where: { clientId } });
  if (!cfg) return;
  await Promise.all([freshRows(cfg, "mentor", true), freshRows(cfg, "subMentor", true)]);
}

/** One card per sheet: connected?, rows loaded, last read, or the problem. */
export function sheetStatus(cfg: Config | null) {
  return (["mentor", "subMentor"] as const).map((sheet) => {
    const f = FIELDS[sheet];
    const rows = (cfg?.[f.rows] as SheetRow[] | null) ?? null;
    return { sheet, label: sheet === "mentor" ? "Mentor sheet" : "Sub-mentor sheet", url: cfg?.[f.url] ?? null, rows: rows?.length ?? null, readAt: cfg?.[f.readAt] ?? null, error: cfg?.[f.error] ?? null };
  });
}

export async function checkByHand(ctx: Ctx, clientId: string, input: Record<string, unknown>, send: boolean) {
  assertView(ctx, clientId);
  return lookupAndLog(clientId, lookupInput(input), "panel", send);
}

export async function recentLookups(ctx: Ctx, clientId: string) {
  assertView(ctx, clientId);
  return prisma.leadLookup.findMany({ where: { clientId }, orderBy: { createdAt: "desc" }, take: 50 });
}

/** Send (again) a lookup that failed or wasn't sent. */
export async function resendLookup(ctx: Ctx, lookupId: string) {
  const row = await prisma.leadLookup.findUnique({ where: { id: lookupId } });
  if (!row) throw new NotFoundError("Lookup not found");
  assertView(ctx, row.clientId);
  const cfg = await prisma.lookupConfig.findUnique({ where: { clientId: row.clientId } });
  if (!cfg?.webhookId) throw new Error("Choose a lookup webhook in the settings first.");
  await prisma.leadLookup.update({ where: { id: lookupId }, data: { webhookStatus: "not_sent", webhookError: null } });
  await enqueue("lookup.deliver", { lookupId }, { attempts: 1 });
}

/** Checks the client's existing leads once (no webhooks). Returns how many were checked. */
export async function checkExistingLeads(ctx: Ctx, clientId: string) {
  assertManage(ctx, clientId);
  const cfg = await prisma.lookupConfig.findUnique({ where: { clientId } });
  if (!configured(cfg)) throw new Error("Add the sheet links first.");
  const [m, s] = await Promise.all([freshRows(cfg, "mentor", true), freshRows(cfg, "subMentor", true)]);
  let cursor: string | undefined;
  let done = 0;
  for (;;) {
    const batch = await prisma.lead.findMany({
      where: { clientId, deletedAt: null },
      orderBy: { id: "asc" },
      take: 500,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true, emailNormalised: true, phoneNormalised: true },
    });
    if (!batch.length) break;
    cursor = batch[batch.length - 1].id;
    for (const l of batch) {
      if (!l.emailNormalised && !l.phoneNormalised) continue;
      await saveOnLead(l.id, matchLead(m.rows, s.rows, { email: l.emailNormalised, phone: l.phoneNormalised }));
      done++;
    }
  }
  await prisma.auditLog.create({ data: { actorId: ctx.userId, clientId, action: "lookup.check_existing", target: `${done} leads` } });
  return done;
}
