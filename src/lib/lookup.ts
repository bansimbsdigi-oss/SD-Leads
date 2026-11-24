// Lead lookup: is a lead in the Mentor list, the Sub-mentor list, or neither? One global setup: leads are
// sent to a secret inbound webhook, checked against each list's Google Sheet links (re-read every few
// minutes, so edits are picked up; the last good copy is kept for outages) and uploaded files, and the
// result is sent on to the outbound webhook.
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
export type LookupResult = {
  leadType: LeadType;
  mentorName: string | null;
  mentorTeam: string | null;
  mentorPhone: string | null;
  mentorEmail: string | null;
  subMentorName: string | null;
  subMentorPhone: string | null;
  subMentorEmail: string | null;
  matchedBy: "email" | "phone" | null;
};

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
/** The Mentor sheet may hold a team letter instead of a name (decoded with the team list). */
const TEAM_HEADERS = new Set(["team", "team name", "mentor team", "assigned team", "team assigned", "assign team", "team assign"]);
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
  const nameCol = sheet === "mentor" ? (col(MENTOR_HEADERS) >= 0 ? col(MENTOR_HEADERS) : col(TEAM_HEADERS)) : col(SUB_HEADERS);
  const mentorCol = sheet === "subMentor" ? col(MENTOR_HEADERS) : -1;
  if (nameCol < 0) throw new Error(sheet === "mentor" ? "No “Mentor Name” (or “Team”) column found." : "No “Sub Mentor Name” column found.");
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
const LINKS = { mentor: "mentorLinks", subMentor: "subMentorLinks" } as const;
type SheetLink = { url: string; rows: SheetRow[]; readAt: string | null; error: string | null };
const linksOf = (cfg: Config, sheet: Sheet) => ((cfg[LINKS[sheet]] as SheetLink[] | null) ?? []);
const MAX_LINKS = 10;

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

/** All rows of a list: its Google Sheet links (in the order added), then its uploaded files. */
async function freshRows(cfg: Config, sheet: Sheet, force = false): Promise<SheetRow[]> {
  const links = await freshLinks(cfg, sheet, force);
  return [...links.flatMap((l) => l.rows), ...filesOf(cfg, sheet).flatMap((f) => f.rows)];
}

/** Reads one link now. On failure the last good copy is kept, with the problem noted. */
async function readLink(link: SheetLink, sheet: Sheet): Promise<SheetLink> {
  try {
    return { ...link, rows: readSheetRows(await downloadSheet(link.url), sheet), readAt: new Date().toISOString(), error: null };
  } catch (err) {
    const error = err instanceof Error ? err.message.slice(0, 300) : "Couldn't read the sheet.";
    logger.warn({ sheet, error }, "lookup sheet read failed; using last good copy");
    return { ...link, error };
  }
}

/**
 * Re-reads a list's links whose copy is older than the refresh time (or all, with `force`), so edits in
 * Google Sheets are picked up within a few minutes. Saved together, in one write.
 */
async function freshLinks(cfg: Config, sheet: Sheet, force: boolean): Promise<SheetLink[]> {
  const links = linksOf(cfg, sheet);
  const stale = (l: SheetLink) => force || l.error || !l.readAt || Date.now() - new Date(l.readAt).getTime() >= cfg.refreshMinutes * 60_000;
  if (!links.some(stale)) return links;
  const next = await Promise.all(links.map((l) => (stale(l) ? readLink(l, sheet) : l)));
  // Written against the current list, so a link added or removed meanwhile isn't undone.
  const now = linksOf(await config(), sheet);
  const merged = now.map((l) => next.find((n) => n.url === l.url) ?? l);
  await prisma.lookupConfig.update({ where: { id: GLOBAL }, data: { [LINKS[sheet]]: merged } });
  return merged;
}

function find(rows: SheetRow[], email: string | null, phone: string | null) {
  // Email first, then phone; the first row wins.
  const byEmail = email ? rows.find((r) => r.email === email) : undefined;
  if (byEmail) return { row: byEmail, by: "email" as const };
  const byPhone = phone ? rows.find((r) => r.phone === phone) : undefined;
  return byPhone ? { row: byPhone, by: "phone" as const } : null;
}

// ---------- Teams and sub-mentors ----------

/** A Mentor team: the letter used in the Mentor sheet, its mentor and their contact. A closed team never gets leads. */
export type Team = { code: string; mentor: string; phone: string; email: string; closed: boolean };
/** A sub-mentor: the name used in the Sub-mentor sheet, their team and contact. */
export type SubMentor = { name: string; team: string; phone: string; email: string };
export type Directory = { teams: Team[]; subMentors: SubMentor[] };

export const DUMMY_MENTOR_PHONE = "0000000000";
export const DEFAULT_TEAMS: Team[] = [
  ["A", "Anupa"], ["B", "Varsha"], ["C", "Jesal"], ["D", ""], ["E", "Poonam"], ["F", "Shobhita"], ["G", "Sweety"],
].map(([code, mentor]) => ({ code, mentor, phone: DUMMY_MENTOR_PHONE, email: "", closed: code === "D" }));

const asList = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
export const directoryOf = (cfg: { teams: unknown; subMentors: unknown }): Directory => ({ teams: asList<Team>(cfg.teams), subMentors: asList<SubMentor>(cfg.subMentors) });

/** The team code in a cell like "A", "Team A", "team-a" or "TEAM A"; null for anything else (e.g. a name). */
export const teamCode = (v: string | null | undefined) => /^\s*(?:team\s*[-_ ]?\s*)?([a-z0-9]{1,3})\s*$/i.exec(v ?? "")?.[1]?.toUpperCase() ?? null;

/** Names compared loosely: case, dots, "Dr." and extra spaces don't matter. */
const personKey = (v: string) => v.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\b(dr|mr|mrs|ms)\b/g, " ").replace(/\s+/g, " ").trim();

/** A sub-mentor by the name in the sheet: same name, or one name contained in the other ("Arpan Bagga" / "Arpan Bagga Sahay"). */
export function findSubMentor(name: string | null, subs: SubMentor[]): SubMentor | null {
  const key = personKey(name ?? "");
  if (!key) return null;
  const exact = subs.find((s) => personKey(s.name) === key);
  if (exact) return exact;
  const words = key.split(" ");
  const within = (a: string[], b: string[]) => a.length >= 2 && a.every((w) => b.includes(w));
  return subs.find((s) => { const w = personKey(s.name).split(" "); return within(words, w) || within(w, words); }) ?? null;
}

/** A mentor cell → its team: by team letter ("Team A"), or by the mentor's name. */
function teamFor(raw: string | null, teams: Team[]): Team | null {
  const code = teamCode(raw);
  if (code) return teams.find((t) => t.code.toUpperCase() === code) ?? null;
  const key = personKey(raw ?? "");
  return key ? teams.find((t) => t.mentor && personKey(t.mentor) === key) ?? null : null;
}

const none = (matchedBy: LookupResult["matchedBy"] = null) => ({ mentorName: null, mentorTeam: null, mentorPhone: null, mentorEmail: null, subMentorName: null, subMentorPhone: null, subMentorEmail: null, matchedBy });
const mentorOf = (t: Team | null, fallbackName: string | null) =>
  t && !t.closed
    ? { mentorName: t.mentor || fallbackName, mentorTeam: t.code, mentorPhone: t.phone || null, mentorEmail: t.email || null }
    : { mentorName: t ? null : fallbackName, mentorTeam: t?.code ?? null, mentorPhone: null, mentorEmail: null };

/**
 * The matching rules: the Mentor sheet first. Found there → Mentor's lead, and the Sub-mentor sheet isn't
 * checked; rows of a closed team (e.g. Team D) are skipped. Otherwise the Sub-mentor sheet; otherwise None
 * of the above. Mentor and sub-mentor contacts come from the directory (teams and sub-mentors).
 */
export function matchLead(mentorRows: SheetRow[], subRows: SheetRow[], lead: { email?: unknown; phone?: unknown }, dir: Directory = { teams: DEFAULT_TEAMS, subMentors: [] }): LookupResult {
  const email = emailKey(lead.email);
  const phone = phoneKey(lead.phone);
  const m = find(mentorRows.filter((r) => !teamFor(r.name, dir.teams)?.closed), email, phone);
  if (m) {
    const raw = m.row.name || null;
    const t = teamFor(raw, dir.teams);
    return { leadType: "mentor", ...none(m.by), ...mentorOf(t, teamCode(raw) ? null : raw) };
  }
  const s = find(subRows, email, phone);
  if (s) {
    const sub = findSubMentor(s.row.name, dir.subMentors);
    // The team from the sheet's Mentor column, or else the sub-mentor's team in the directory.
    const t = teamFor(s.row.mentor, dir.teams) ?? (sub ? teamFor(sub.team, dir.teams) : null);
    return {
      leadType: "sub_mentor",
      ...none(s.by),
      ...mentorOf(t, s.row.mentor && !teamCode(s.row.mentor) ? s.row.mentor : null),
      subMentorName: s.row.name || sub?.name || null,
      subMentorPhone: sub?.phone || null,
      subMentorEmail: sub?.email || null,
    };
  }
  return { leadType: "none", ...none() };
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
    mentor_team: r.mentorTeam ?? "",
    mentor_phone: r.mentorPhone ?? "",
    mentor_email: r.mentorEmail ?? "",
    sub_mentor_name: r.subMentorName ?? "",
    sub_mentor_phone: r.subMentorPhone ?? "",
    sub_mentor_email: r.subMentorEmail ?? "",
    matched_by: r.matchedBy ?? "",
    source,
    checked_at: new Date(at.getTime() + 330 * 60_000).toISOString().replace("Z", "+05:30").replace(/\.\d{3}/, ""),
  };
}

const ready = (cfg: Config) =>
  cfg.enabled && (["mentor", "subMentor"] as const).some((s) => linksOf(cfg, s).length > 0 || filesOf(cfg, s).length > 0);

// ---------- Inbound webhook and checks by hand ----------

export class LookupInputError extends Error {}

/**
 * Picks name / email / phone out of a JSON or form body, accepting common alternative names. Every other
 * field sent (e.g. "type") is kept in `extra` and passed on to your webhook unchanged.
 */
export function lookupInput(body: Record<string, unknown>) {
  const used = new Set<string>();
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      for (const key of [k, k.toLowerCase()]) {
        const v = body[key];
        if ((typeof v === "string" && v.trim()) || typeof v === "number") {
          used.add(key);
          return String(v).trim();
        }
      }
    }
    return "";
  };
  const name = pick("name", "full_name", "fullName", "Name", "lead_name");
  const email = pick("email", "Email", "email_address", "email_id", "mail");
  const phone = pick("phone", "Phone", "mobile", "phone_number", "mobile_number", "whatsapp", "whatsapp_number", "contact", "number");
  if (!emailKey(email) && !phoneKey(phone)) throw new LookupInputError("Send an email or a phone number.");
  const extra = Object.fromEntries(
    Object.entries(body)
      .filter(([k, v]) => !used.has(k) && !/^(name|email|phone)$/i.test(k) && v !== undefined)
      .slice(0, 50)
      .map(([k, v]) => [k.slice(0, 100), typeof v === "string" ? v.slice(0, 2000) : v]),
  );
  return { name: name.slice(0, 200) || null, email: email.slice(0, 200) || null, phone: phone.slice(0, 40) || null, extra };
}

/** Our result fields plus the extra fields sent in; an extra field with the same name as ours is sent as input_<name>. */
function withExtra<T extends Record<string, unknown>>(payload: T, extra?: Record<string, unknown>) {
  if (!extra) return payload;
  const out: Record<string, unknown> = { ...payload };
  for (const [k, v] of Object.entries(extra)) out[k in payload ? `input_${k}` : k] = v;
  return out as T;
}

/** The inbound webhook's secret token, or null when it isn't this one. */
export async function lookupTokenMatches(token: string) {
  if (!/^[a-f0-9]{32,64}$/.test(token)) return false;
  return Boolean(await prisma.lookupConfig.findUnique({ where: { apiToken: token }, select: { id: true } }));
}

/** Looks up a lead, saves it and (when `send` and an outbound webhook is set) queues it to be sent. */
export async function lookupAndLog(input: { name: string | null; email: string | null; phone: string | null; extra?: Record<string, unknown>; clientId?: string; leadId?: string }, source: "webhook" | "panel" | "lead", send: boolean) {
  const cfg = await config();
  if (!ready(cfg)) throw new Error(cfg.enabled ? "Lead lookup isn't set up yet: add the Mentor and Sub-mentor sheets first." : "Lead lookup is switched off.");
  const [m, s] = await Promise.all([freshRows(cfg, "mentor"), freshRows(cfg, "subMentor")]);
  const r = matchLead(m, s, input, directoryOf(cfg));
  const payload = withExtra(lookupPayload(r, input, source), input.extra);
  const hasOut = Boolean(cfg.outboundConfig);
  const row = await prisma.leadLookup.create({
    data: {
      clientId: input.clientId ?? null,
      leadId: input.leadId ?? null,
      name: input.name, email: input.email, phone: input.phone, leadType: r.leadType, mentorName: r.mentorName,
      subMentorName: r.subMentorName, matchedBy: r.matchedBy, source, payload: payload as Prisma.InputJsonValue,
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

// ---------- Webhook history ----------

const LOG_DAYS = 30;
type LogEntry = {
  status: "received" | "rejected" | "sent" | "failed";
  test?: boolean;
  lookupId?: string | null;
  httpStatus?: number | null;
  body?: unknown;
  response?: string | null;
  error?: string | null;
  attempt?: number | null;
  durationMs?: number | null;
};

/** A body as stored JSON: as it is when small, otherwise a note. */
function keepable(body: unknown): Prisma.InputJsonValue | undefined {
  if (body === undefined || body === null) return undefined;
  const json = JSON.stringify(body);
  return json.length <= 20_000 ? (JSON.parse(json) as Prisma.InputJsonValue) : { note: `Too large to keep (${json.length.toLocaleString("en-IN")} characters)` };
}

/** Adds a line to the webhook history (never throws). Now and then drops lines older than 30 days. */
export async function logWebhook(e: LogEntry) {
  try {
    await prisma.lookupWebhookLog.create({
      data: {
        status: e.status,
        direction: e.status === "received" || e.status === "rejected" ? "in" : "out",
        test: Boolean(e.test),
        lookupId: e.lookupId ?? null,
        httpStatus: e.httpStatus ?? null,
        body: keepable(e.body),
        response: e.response?.slice(0, 1000) ?? null,
        error: e.error?.slice(0, 500) ?? null,
        attempt: e.attempt ?? null,
        durationMs: e.durationMs ?? null,
      },
    });
    if (Math.random() < 0.02) await prisma.lookupWebhookLog.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - LOG_DAYS * 86_400_000) } } });
  } catch (err) {
    logger.warn({ err }, "lookup webhook history: couldn't save a line");
  }
}

export const LOG_FILTERS = ["all", "received", "rejected", "sent", "failed"] as const;
export type LogFilter = (typeof LOG_FILTERS)[number];
const LOG_PAGE = 50;

/** One page of the webhook history, newest first, with counts for the filter tabs. */
export async function webhookHistory(ctx: Ctx, filter: LogFilter = "all", page = 1) {
  assertAdmin(ctx);
  const where = filter === "all" ? {} : { status: filter };
  const [rows, total, groups] = await Promise.all([
    prisma.lookupWebhookLog.findMany({ where, orderBy: { createdAt: "desc" }, skip: (Math.max(1, page) - 1) * LOG_PAGE, take: LOG_PAGE }),
    prisma.lookupWebhookLog.count({ where }),
    prisma.lookupWebhookLog.groupBy({ by: ["status"], _count: { _all: true } }),
  ]);
  const counts = Object.fromEntries(groups.map((g) => [g.status, g._count._all])) as Partial<Record<LogFilter, number>>;
  counts.all = groups.reduce((n, g) => n + g._count._all, 0);
  return { rows, total, pages: Math.max(1, Math.ceil(total / LOG_PAGE)), counts };
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
  const attempt = (await prisma.lookupWebhookLog.count({ where: { lookupId, direction: "out" } })) + 1;
  const res = await postJson(url, row.payload, { keepResponse: true });
  await logWebhook({ status: res.ok ? "sent" : "failed", lookupId, httpStatus: res.status, body: row.payload, response: res.response, error: res.error, attempt, durationMs: res.durationMs });
  await prisma.leadLookup.update({ where: { id: lookupId }, data: { webhookStatus: res.ok ? "sent" : "failed", webhookError: res.error } });
  if (!res.ok) throw new Error(`Lookup webhook failed: ${res.error}`);
}

/** Sample results for Send test, using the first open team and its first sub-mentor from the directory. */
function testResult(leadType: LeadType, dir: Directory): LookupResult {
  const blank = { leadType, mentorName: null, mentorTeam: null, mentorPhone: null, mentorEmail: null, subMentorName: null, subMentorPhone: null, subMentorEmail: null, matchedBy: null };
  if (leadType === "none") return blank;
  const sub = dir.subMentors.find((x) => dir.teams.some((t) => t.code === x.team && !t.closed));
  const team = (leadType === "sub_mentor" && sub ? dir.teams.find((t) => t.code === sub.team) : null) ?? dir.teams.find((t) => !t.closed);
  const mentor = { mentorName: team?.mentor || "Test Mentor", mentorTeam: team?.code ?? "A", mentorPhone: team?.phone || DUMMY_MENTOR_PHONE, mentorEmail: team?.email || null };
  if (leadType === "mentor") return { ...blank, ...mentor, matchedBy: "email" };
  return { ...blank, ...mentor, subMentorName: sub?.name ?? "Test Sub-mentor", subMentorPhone: sub?.phone || "9000000001", subMentorEmail: sub?.email || "sub.mentor@example.com", matchedBy: "phone" };
}

/**
 * Sends a sample result to the saved outbound webhook right now (not queued, not retried), so its fields
 * can be mapped in Pabbly. Marked "test": true.
 */
export async function sendLookupTest(ctx: Ctx, leadType: LeadType) {
  assertAdmin(ctx);
  const url = outboundUrl(await config());
  if (!url) throw new Error("Save your webhook URL in Settings first.");
  const payload = { ...lookupPayload(testResult(leadType, directoryOf(await config())), { name: "Test Lead", email: "test.lead@example.com", phone: "+91 90000 00000" }, "panel"), source: "test", test: true, type: "Test type" };
  const res = await postJson(url, payload, { keepResponse: true });
  await logWebhook({ status: res.ok ? "sent" : "failed", test: true, httpStatus: res.status, body: payload, response: res.response, error: res.error, durationMs: res.durationMs });
  await prisma.auditLog.create({ data: { actorId: ctx.userId, action: "lookup.test_send", target: leadType } });
  return res;
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

export async function saveLookupConfig(ctx: Ctx, input: { outboundUrl: string; refreshMinutes: number; enabled: boolean; autoCheckLeads?: boolean }) {
  assertAdmin(ctx);
  const out = input.outboundUrl.trim();
  if (out) {
    const problem = webhookUrlProblem(out);
    if (problem) throw new Error(problem);
  }
  await config();
  await prisma.lookupConfig.update({
    where: { id: GLOBAL },
    data: {
      outboundConfig: out ? encryptJson({ url: out }) : null,
      refreshMinutes: Math.min(60, Math.max(1, Math.round(input.refreshMinutes || 2))),
      enabled: input.enabled,
      autoCheckLeads: Boolean(input.autoCheckLeads),
    },
  });
  await prisma.auditLog.create({ data: { actorId: ctx.userId, action: "lookup.settings", target: "global" } });
}

/** Saves the teams (letter → mentor and contact) and sub-mentors (name → team and contact). */
export async function saveDirectory(ctx: Ctx, input: { teams: unknown; subMentors: unknown }) {
  assertAdmin(ctx);
  const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const teamText = (v: unknown) => text(v, 20).toUpperCase().replace(/^TEAM\s*[-_ ]?\s*/, "").slice(0, 3);
  const teams = asList<Record<string, unknown>>(input.teams)
    .map((t) => ({ code: teamText(t.code), mentor: text(t.mentor, 120), phone: text(t.phone, 40), email: text(t.email, 200), closed: Boolean(t.closed) }))
    .filter((t) => t.code);
  const subMentors = asList<Record<string, unknown>>(input.subMentors)
    .map((x) => ({ name: text(x.name, 120), team: teamText(x.team), phone: text(x.phone, 40), email: text(x.email, 200) }))
    .filter((x) => x.name);
  const dup = teams.find((t, i) => teams.findIndex((u) => u.code === t.code) !== i);
  if (dup) throw new Error(`Team ${dup.code} is listed twice.`);
  const unknown = subMentors.find((x) => x.team && !teams.some((t) => t.code === x.team));
  if (unknown) throw new Error(`${unknown.name}: there is no Team ${unknown.team}.`);
  if (teams.length > 50 || subMentors.length > 200) throw new Error("That's more teams or sub-mentors than allowed.");
  await config();
  await prisma.lookupConfig.update({ where: { id: GLOBAL }, data: { teams, subMentors } });
  await prisma.auditLog.create({ data: { actorId: ctx.userId, action: "lookup.directory", target: `${teams.length} teams, ${subMentors.length} sub-mentors` } });
}

/** Adds a Google Sheet link to a list and reads it straight away. Returns its rows and any problem reading it. */
export async function addSheetLink(ctx: Ctx, sheet: Sheet, raw: string) {
  assertAdmin(ctx);
  const url = raw.trim();
  sheetCsvUrl(url); // throws a friendly error for a wrong link
  const links = linksOf(await config(), sheet);
  if (links.some((l) => sheetCsvUrl(l.url) === sheetCsvUrl(url))) throw new Error("That sheet is already in this list.");
  if (links.length >= MAX_LINKS) throw new Error(`A list can have up to ${MAX_LINKS} links. Remove one first.`);
  const link = await readLink({ url, rows: [], readAt: null, error: null }, sheet);
  await prisma.lookupConfig.update({ where: { id: GLOBAL }, data: { [LINKS[sheet]]: [...linksOf(await config(), sheet), link] } });
  await prisma.auditLog.create({ data: { actorId: ctx.userId, action: "lookup.add_link", target: `${sheet}: ${url.slice(0, 150)}` } });
  return { rows: link.rows.length, error: link.error };
}

/** Takes one Google Sheet link out of a list. */
export async function removeSheetLink(ctx: Ctx, sheet: Sheet, url: string) {
  assertAdmin(ctx);
  const cfg = await config();
  await prisma.lookupConfig.update({ where: { id: GLOBAL }, data: { [LINKS[sheet]]: linksOf(cfg, sheet).filter((l) => l.url !== url) } });
  await prisma.auditLog.create({ data: { actorId: ctx.userId, action: "lookup.remove_link", target: `${sheet}: ${url.slice(0, 150)}` } });
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

/** One card per list: its Google Sheet links and uploaded files, total rows, and any problem. */
export function sheetStatus(cfg: Config) {
  return (["mentor", "subMentor"] as const).map((sheet) => {
    const links = linksOf(cfg, sheet).map((l) => ({ url: l.url, rows: l.readAt ? l.rows.length : null, readAt: l.readAt, error: l.error }));
    const files = filesOf(cfg, sheet).map((x) => ({ name: x.name, rows: x.rows.length, uploadedAt: x.uploadedAt }));
    const total = links.reduce((n, l) => n + (l.rows ?? 0), 0) + files.reduce((n, x) => n + x.rows, 0);
    return {
      sheet,
      label: sheet === "mentor" ? "Mentor" : "Sub-mentor",
      links,
      files,
      rows: links.length || files.length ? total : null,
      error: links.find((l) => l.error)?.error ?? null,
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

/** Adds an uploaded CSV or Excel file to a list (a fixed copy; Google Sheet links stay up to date). */
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
