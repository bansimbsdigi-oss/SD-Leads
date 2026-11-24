// Lead lookup: is a lead in the Mentor sheet, the Sub-mentor sheet, or neither? One global setup: leads are
// sent to a secret inbound webhook, checked against the two Google Sheets (read live, at most every few
// minutes; the last good copy is kept for outages), and the result is sent on to the outbound webhook.
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { decryptJson, encryptJson, newWebhookToken } from "@/lib/crypto";
import { logger } from "@/lib/logger";
import { LEAD_TYPE_LABEL, type LeadType } from "@/lib/lookupLabels";
import { webhookUrlProblem } from "@/lib/outbound/safeUrl";
import { postJson } from "@/lib/outbound/webhooks";
import { enqueue } from "@/lib/queue";
import { ForbiddenError, NotFoundError, type Ctx } from "@/lib/tenant";

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
  return readSheetTable(parseCsv(csv), sheet);
}

/** Same as readSheetRows, from a table already split into cells (an uploaded Excel file). */
export function readSheetTable(rows: string[][], sheet: Sheet): SheetRow[] {
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

const GLOBAL = "global";
const FIELDS = {
  mentor: { url: "mentorSheetUrl", rows: "mentorRows", readAt: "mentorReadAt", error: "mentorError" },
  subMentor: { url: "subMentorSheetUrl", rows: "subMentorRows", readAt: "subMentorReadAt", error: "subMentorError" },
} as const;

const FILES = { mentor: "mentorFiles", subMentor: "subMentorFiles" } as const;
type UploadedFile = { name: string; rows: SheetRow[]; uploadedAt: string };
const filesOf = (cfg: Config, sheet: Sheet) => ((cfg[FILES[sheet]] as UploadedFile[] | null) ?? []);

type Config = NonNullable<Awaited<ReturnType<typeof prisma.lookupConfig.findUnique>>>;

/** The one lookup setup, created on first use (with its secret inbound webhook token). */
async function config(): Promise<Config> {
  return (
    (await prisma.lookupConfig.findUnique({ where: { id: GLOBAL } })) ??
    prisma.lookupConfig.upsert({ where: { id: GLOBAL }, update: {}, create: { id: GLOBAL, apiToken: newWebhookToken() } })
  );
}

const outboundUrl = (cfg: Config) => (cfg.outboundConfig ? decryptJson<{ url: string }>(cfg.outboundConfig).url : null);

/** All rows of a list: its uploaded files (in upload order), then its sheet link. */
async function freshRows(cfg: Config, sheet: Sheet, force = false): Promise<{ rows: SheetRow[]; error: string | null; readAt: Date | null }> {
  const fileRows = filesOf(cfg, sheet).flatMap((f) => f.rows);
  const link = await linkRows(cfg, sheet, force);
  return { ...link, rows: [...fileRows, ...link.rows] };
}

/** Re-reads a sheet link when its copy is older than the refresh time (or `force`). Keeps the last good copy on failure. */
async function linkRows(cfg: Config, sheet: Sheet, force: boolean): Promise<{ rows: SheetRow[]; error: string | null; readAt: Date | null }> {
  const f = FIELDS[sheet];
  const url = cfg[f.url];
  const cached = (cfg[f.rows] as SheetRow[] | null) ?? [];
  if (!url) return { rows: [], error: null, readAt: null };
  const age = cfg[f.readAt] ? Date.now() - cfg[f.readAt]!.getTime() : Infinity;
  if (!force && age < cfg.refreshMinutes * 60_000 && !cfg[f.error]) return { rows: cached, error: null, readAt: cfg[f.readAt] };
  try {
    const rows = readSheetRows(await downloadSheet(url), sheet);
    const readAt = new Date();
    await prisma.lookupConfig.update({ where: { id: GLOBAL }, data: { [f.rows]: rows, [f.readAt]: readAt, [f.error]: null } });
    return { rows, error: null, readAt };
  } catch (err) {
    const error = err instanceof Error ? err.message.slice(0, 300) : "Couldn't read the sheet.";
    await prisma.lookupConfig.update({ where: { id: GLOBAL }, data: { [f.error]: error } });
    logger.warn({ sheet, error }, "lookup sheet read failed; using last good copy");
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

/**
 * The matching rules: the Mentor sheet first. Found there → Mentor's lead, and the Sub-mentor sheet isn't
 * checked. Otherwise the Sub-mentor sheet; otherwise None of the above.
 */
export function matchLead(mentorRows: SheetRow[], subRows: SheetRow[], lead: { email?: unknown; phone?: unknown }): LookupResult {
  const email = emailKey(lead.email);
  const phone = phoneKey(lead.phone);
  const m = find(mentorRows, email, phone);
  if (m) return { leadType: "mentor", mentorName: m.row.name || null, subMentorName: null, matchedBy: m.by };
  const s = find(subRows, email, phone);
  if (s) return { leadType: "sub_mentor", mentorName: s.row.mentor, subMentorName: s.row.name || null, matchedBy: s.by };
  return { leadType: "none", mentorName: null, subMentorName: null, matchedBy: null };
}

/** The payload sent on: the same fields for every result, so they're mapped once in Pabbly. */
export function lookupPayload(r: LookupResult, lead: { name?: string | null; email?: string | null; phone?: string | null }, source: "webhook" | "panel" | "lead", at = new Date()) {
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

const ready = (cfg: Config) =>
  cfg.enabled && Boolean(cfg.mentorSheetUrl || cfg.subMentorSheetUrl || filesOf(cfg, "mentor").length || filesOf(cfg, "subMentor").length);

// ---------- Inbound webhook and checks by hand ----------

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

/** The inbound webhook's secret token, or null when it isn't this one. */
export async function lookupTokenMatches(token: string) {
  if (!/^[a-f0-9]{32,64}$/.test(token)) return false;
  return Boolean(await prisma.lookupConfig.findUnique({ where: { apiToken: token }, select: { id: true } }));
}

/** Looks up a lead, saves it and (when `send` and an outbound webhook is set) queues it to be sent. */
export async function lookupAndLog(input: { name: string | null; email: string | null; phone: string | null; clientId?: string; leadId?: string }, source: "webhook" | "panel" | "lead", send: boolean) {
  const cfg = await config();
  if (!ready(cfg)) throw new Error(cfg.enabled ? "Lead lookup isn't set up yet: add the sheet links first." : "Lead lookup is switched off.");
  const [m, s] = await Promise.all([freshRows(cfg, "mentor"), freshRows(cfg, "subMentor")]);
  const r = matchLead(m.rows, s.rows, input);
  const payload = lookupPayload(r, input, source);
  const hasOut = Boolean(cfg.outboundConfig);
  const row = await prisma.leadLookup.create({
    data: {
      clientId: input.clientId ?? null,
      leadId: input.leadId ?? null,
      name: input.name, email: input.email, phone: input.phone, leadType: r.leadType, mentorName: r.mentorName,
      subMentorName: r.subMentorName, matchedBy: r.matchedBy, source, payload,
      webhookStatus: send && hasOut ? "not_sent" : send ? "off" : "not_sent",
    },
  });
  if (send && hasOut) await enqueue("lookup.deliver", { lookupId: row.id }, { attempts: 3, backoffMs: 20_000, jobId: `lookup-${row.id}` });
  return { result: r, payload, lookupId: row.id };
}

/** "Check every new SD-Leads lead": looks a new lead up and sends the result on. Never throws. */
export async function autoLookupLead(leadId: string) {
  try {
    const cfg = await prisma.lookupConfig.findUnique({ where: { id: GLOBAL } });
    if (!cfg?.autoCheckLeads || !ready(cfg)) return null;
    const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { id: true, clientId: true, name: true, emailNormalised: true, phoneNormalised: true } });
    if (!lead || (!lead.emailNormalised && !lead.phoneNormalised)) return null;
    return await lookupAndLog({ name: lead.name, email: lead.emailNormalised, phone: lead.phoneNormalised, clientId: lead.clientId, leadId: lead.id }, "lead", true);
  } catch (err) {
    logger.error({ err, leadId }, "automatic lead lookup failed");
    return null;
  }
}

/** Sends one saved lookup to the outbound webhook. Throws on failure so the queue retries. */
export async function deliverLookup(lookupId: string) {
  const row = await prisma.leadLookup.findUnique({ where: { id: lookupId } });
  if (!row) return;
  const url = outboundUrl(await config());
  if (!url) {
    await prisma.leadLookup.update({ where: { id: lookupId }, data: { webhookStatus: "off", webhookError: "No outbound webhook set" } });
    return;
  }
  const res = await postJson(url, row.payload);
  await prisma.leadLookup.update({ where: { id: lookupId }, data: { webhookStatus: res.ok ? "sent" : "failed", webhookError: res.error } });
  if (!res.ok) throw new Error(`Lookup webhook failed: ${res.error}`);
}

// ---------- Lead lookup page (super admins) ----------

function assertAdmin(ctx: Ctx) {
  if (ctx.role !== "SUPER_ADMIN") throw new ForbiddenError();
}

export async function getLookupSetup(ctx: Ctx) {
  assertAdmin(ctx);
  const cfg = await config();
  return { cfg, outboundUrl: outboundUrl(cfg) };
}

export async function saveLookupConfig(ctx: Ctx, input: { mentorSheetUrl: string; subMentorSheetUrl: string; outboundUrl: string; refreshMinutes: number; enabled: boolean; autoCheckLeads?: boolean }) {
  assertAdmin(ctx);
  const mentor = input.mentorSheetUrl.trim() || null;
  const sub = input.subMentorSheetUrl.trim() || null;
  for (const u of [mentor, sub]) if (u) sheetCsvUrl(u); // throws a friendly error for a wrong link
  const out = input.outboundUrl.trim();
  if (out) {
    const problem = webhookUrlProblem(out);
    if (problem) throw new Error(problem);
  }
  const before = await config();
  await prisma.lookupConfig.update({
    where: { id: GLOBAL },
    data: {
      mentorSheetUrl: mentor,
      subMentorSheetUrl: sub,
      outboundConfig: out ? encryptJson({ url: out }) : null,
      refreshMinutes: Math.min(60, Math.max(1, Math.round(input.refreshMinutes || 2))),
      enabled: input.enabled,
      autoCheckLeads: Boolean(input.autoCheckLeads),
      // A changed link starts from scratch. Uploaded files are kept either way.
      ...(before.mentorSheetUrl !== mentor ? { mentorRows: Prisma.DbNull, mentorReadAt: null, mentorError: null } : {}),
      ...(before.subMentorSheetUrl !== sub ? { subMentorRows: Prisma.DbNull, subMentorReadAt: null, subMentorError: null } : {}),
    },
  });
  await prisma.auditLog.create({ data: { actorId: ctx.userId, action: "lookup.settings", target: "global" } });
  await reloadSheets(ctx);
}

export async function rotateLookupToken(ctx: Ctx) {
  assertAdmin(ctx);
  await config();
  await prisma.lookupConfig.update({ where: { id: GLOBAL }, data: { apiToken: newWebhookToken() } });
  await prisma.auditLog.create({ data: { actorId: ctx.userId, action: "lookup.rotate_token", target: "global" } });
}

/** Re-reads both sheets now. */
export async function reloadSheets(ctx: Ctx) {
  assertAdmin(ctx);
  const cfg = await config();
  await Promise.all([freshRows(cfg, "mentor", true), freshRows(cfg, "subMentor", true)]);
}

/** One card per list: its uploaded files, its sheet link, total rows, or the problem. */
export function sheetStatus(cfg: Config) {
  return (["mentor", "subMentor"] as const).map((sheet) => {
    const f = FIELDS[sheet];
    const files = filesOf(cfg, sheet).map((x) => ({ name: x.name, rows: x.rows.length, uploadedAt: x.uploadedAt }));
    const linkRows = cfg[f.url] ? ((cfg[f.rows] as SheetRow[] | null)?.length ?? null) : null;
    const total = files.reduce((n, x) => n + x.rows, 0) + (linkRows ?? 0);
    return {
      sheet,
      label: sheet === "mentor" ? "Mentor" : "Sub-mentor",
      url: cfg[f.url] ?? null,
      linkRows,
      files,
      rows: files.length || cfg[f.url] ? total : null,
      readAt: cfg[f.readAt] ?? null,
      error: cfg[f.url] ? cfg[f.error] ?? null : null,
    };
  });
}

export async function checkByHand(ctx: Ctx, input: Record<string, unknown>, send: boolean) {
  assertAdmin(ctx);
  return lookupAndLog(lookupInput(input), "panel", send);
}

export async function recentLookups(ctx: Ctx) {
  assertAdmin(ctx);
  return prisma.leadLookup.findMany({ orderBy: { createdAt: "desc" }, take: 50 });
}

/** Send (again) a lookup that failed or wasn't sent. */
export async function resendLookup(ctx: Ctx, lookupId: string) {
  assertAdmin(ctx);
  const row = await prisma.leadLookup.findUnique({ where: { id: lookupId } });
  if (!row) throw new NotFoundError("Lookup not found");
  if (!(await config()).outboundConfig) throw new Error("Add your webhook URL in the settings first.");
  await prisma.leadLookup.update({ where: { id: lookupId }, data: { webhookStatus: "not_sent", webhookError: null } });
  await enqueue("lookup.deliver", { lookupId }, { attempts: 1 });
}

// ---------- Uploaded sheets ----------

const MAX_UPLOAD = 5 * 1024 * 1024;

/** Uses an uploaded CSV or Excel file for a sheet (instead of a Google link). */
export async function uploadSheet(ctx: Ctx, sheet: Sheet, file: File) {
  assertAdmin(ctx);
  if (!file || file.size === 0) throw new Error("Choose a file first.");
  if (file.size > MAX_UPLOAD) throw new Error("The file must be 5 MB or smaller.");
  const name = file.name.slice(0, 200);
  const buf = Buffer.from(await file.arrayBuffer());
  let rows: SheetRow[];
  if (/\.xlsx$/i.test(name) || (buf[0] === 0x50 && buf[1] === 0x4b)) {
    const { default: readXlsxFile } = await import("read-excel-file/node");
    const table = await readXlsxFile(buf).catch(() => {
      throw new Error("Couldn't read that Excel file. Save it as .xlsx or .csv and try again.");
    });
    rows = readSheetTable(table.map((r) => r.map((c) => (c === null || c === undefined ? "" : String(c)))), sheet);
  } else if (/\.(csv|txt)$/i.test(name) || !/\.xls$/i.test(name)) {
    rows = readSheetRows(buf.toString("utf8"), sheet);
  } else {
    throw new Error("Old .xls files aren't supported. Save it as .xlsx or .csv.");
  }
  if (!rows.length) throw new Error(`${name}: no rows with an email or phone were found under the header.`);
  // Adds the file to the list; a file with the same name replaces the old copy (upload again after edits).
  const cfg = await config();
  const files = [...filesOf(cfg, sheet).filter((x) => x.name !== name), { name, rows, uploadedAt: new Date().toISOString() }];
  if (files.length > 20) throw new Error("A list can have up to 20 files. Remove one first.");
  await prisma.lookupConfig.update({ where: { id: GLOBAL }, data: { [FILES[sheet]]: files } });
  await prisma.auditLog.create({ data: { actorId: ctx.userId, action: "lookup.upload", target: `${sheet}: ${name} (${rows.length} rows)` } });
  return rows.length;
}

/** Takes one uploaded file out of a list. */
export async function removeSheetFile(ctx: Ctx, sheet: Sheet, name: string) {
  assertAdmin(ctx);
  const cfg = await config();
  await prisma.lookupConfig.update({ where: { id: GLOBAL }, data: { [FILES[sheet]]: filesOf(cfg, sheet).filter((x) => x.name !== name) } });
  await prisma.auditLog.create({ data: { actorId: ctx.userId, action: "lookup.remove_file", target: `${sheet}: ${name}` } });
}
