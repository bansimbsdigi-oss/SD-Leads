// Lead list query: search, date range, advanced conditions on any field (including form answers)
// and sorting on any column. Runs as one parameterised SQL query so it scales past a few thousand leads.
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { BLANK, MAX_FILTER_VALUES, OPS, RANGES, type Condition, type FieldMeta, type RangeId } from "@/lib/leadFilterSpec";
import { canonicalFieldKey, toFieldKey } from "@/lib/ingest/fieldKeys";
import { isDroppedKey, looseKey, readKeys, RECEIVED_VIA_LABEL, STANDARD_COLUMNS, STANDARD_KEYS, standardKeyOf, type StandardColumn } from "@/lib/standardColumns";
import { isSabhiStaff, leadScopeSql, lpWhere, visibleClientIds, type Ctx } from "@/lib/tenant";

export const PAGE_SIZES = [25, 50, 100, 250, 500, 1000] as const;
export const DEFAULT_PAGE_SIZE = 25;
/** Totals above this show as "10,000+" instead of being counted exactly (counting is the costly part of broad filters). */
export const COUNT_CAP = 10_000;

export type LeadQuery = {
  clientId?: string;
  lpId?: string;
  q?: string;
  range?: RangeId;
  conditions: Condition[];
  sort?: string;
  dir: "asc" | "desc";
  page: number;
  pageSize: number;
};

type Params = URLSearchParams | Record<string, string | string[] | undefined>;

const conditionsSchema = z
  .array(
    z.object({
      field: z.string().max(200),
      op: z.string(),
      value: z.string().max(500).optional(),
      values: z.array(z.string().max(500)).max(MAX_FILTER_VALUES).optional(),
    }),
  )
  .max(30);

export function parseLeadQuery(sp: Params): LeadQuery {
  const get = (k: string) => {
    const v = sp instanceof URLSearchParams ? sp.get(k) : sp[k];
    return (Array.isArray(v) ? v[0] : v) || undefined;
  };
  let conditions: Condition[] = [];
  try {
    const raw = get("f");
    const parsed = raw ? conditionsSchema.safeParse(JSON.parse(raw)) : null;
    if (parsed?.success) conditions = parsed.data as Condition[];
  } catch {
    /* ignore malformed filter param */
  }
  const range = get("range");
  return {
    clientId: get("client"),
    q: get("q")?.trim().slice(0, 200) || undefined,
    range: RANGES.some((r) => r.id === range) ? (range as RangeId) : undefined,
    conditions,
    sort: get("sort"),
    dir: get("dir") === "asc" ? "asc" : "desc",
    page: Math.max(1, Math.floor(Number(get("page"))) || 1),
    pageSize: PAGE_SIZES.find((s) => s === Number(get("size"))) ?? DEFAULT_PAGE_SIZE,
  };
}

/** URL params for a query, with overrides (undefined removes a key). */
export function queryToParams(q: LeadQuery, overrides: Partial<Record<"client" | "q" | "range" | "f" | "sort" | "dir" | "page" | "size", string | undefined>> = {}) {
  const base: Record<string, string | undefined> = {
    client: q.clientId,
    q: q.q,
    range: q.range,
    f: q.conditions.length ? JSON.stringify(q.conditions) : undefined,
    sort: q.sort,
    dir: q.sort ? q.dir : undefined,
    page: q.page > 1 ? String(q.page) : undefined,
    size: q.pageSize !== DEFAULT_PAGE_SIZE ? String(q.pageSize) : undefined,
    ...overrides,
  };
  return new URLSearchParams(Object.entries(base).filter(([, v]) => v) as [string, string][]);
}

// ---------- Date ranges (IST, fixed +05:30) ----------

const IST_OFFSET_MS = 330 * 60_000;

function istMidnight(daysAgo: number, monthsAgo = 0, now = new Date()): Date {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  const utcMidnight = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth() - monthsAgo, ist.getUTCDate() - daysAgo);
  return new Date(utcMidnight - IST_OFFSET_MS);
}

export function rangeBounds(range: RangeId, now = new Date()): { from: Date; to?: Date } {
  switch (range) {
    case "today": return { from: istMidnight(0, 0, now) };
    case "yesterday": return { from: istMidnight(1, 0, now), to: istMidnight(0, 0, now) };
    case "7d": return { from: istMidnight(6, 0, now) };
    case "15d": return { from: istMidnight(14, 0, now) };
    case "30d": return { from: istMidnight(29, 0, now) };
    case "6m": return { from: istMidnight(0, 6, now) };
  }
}

// created_at is stored as UTC without a time zone, so compare against naive UTC timestamps.
export const naiveUtc = (d: Date) => Prisma.sql`${d.toISOString().replace("Z", "")}::timestamp`;

// ---------- Fields ----------

/** One column. `keys` are every stored field key that means the same thing (e.g. email_address, email). */
export type AnswerField = { key: string; keys: string[]; label: string; inputType: string; options: string[] };

/** Core role fields have their own Name / Phone / Email columns. */
const CORE_KEYS = new Set(["name", "phone", "email"]);

/**
 * Column a stored field belongs to. Older leads stored a field sent twice as "ref_2" / "utm_placement_2" /
 * "phone_2"; such a copy joins the column its label names ("Ref", "UTM_Placement", "WhatsApp No.").
 * Numbered questions (q_1, q_2 with their own labels) stay separate.
 */
function groupKey(fieldKey: string, label: string): string {
  const key = canonicalFieldKey(fieldKey);
  const copy = /^(.+)_\d+$/.exec(fieldKey);
  if (!copy) return key;
  const fromLabel = canonicalFieldKey(toFieldKey(label));
  if (fromLabel === canonicalFieldKey(copy[1]) || CORE_KEYS.has(fromLabel) || STANDARD_KEYS.has(fromLabel)) return fromLabel;
  return key;
}

/** Stored keys that belong to a fixed column (by its key), e.g. { whatsapp: ["whatsapp_mobile_no", "phone_2"] }. */
export type Absorbed = Record<string, string[]>;

const absorb = (into: Absorbed, standardKey: string, rawKey: string) => {
  const list = (into[standardKey] ??= []);
  if (!list.includes(rawKey)) list.push(rawKey);
};

/**
 * Form fields for the leads in view (one LP, one client, or every client the user can see), split into
 * extra columns and keys absorbed by the fixed columns. Fields are merged by their shared key, so
 * "Email"/"E-mail"/"Email Address" never make extra columns.
 */
export async function formFieldGroups(ctx: Ctx, scope: { clientId?: string; lpId?: string }): Promise<{ answers: AnswerField[]; absorbed: Absorbed }> {
  const clientId = scope.clientId ?? (isSabhiStaff(ctx) ? undefined : ctx.clientId ?? undefined);
  const lpFilter = scope.lpId ? { id: scope.lpId } : clientId ? { clientId } : {};
  const fields = await prisma.formField.findMany({
    where: { isHidden: false, lp: { AND: [lpWhere(ctx), lpFilter] } },
    orderBy: [{ position: "asc" }, { firstSeenAt: "asc" }],
  });
  const byKey = new Map<string, AnswerField & { lastSeen: number }>();
  const absorbed: Absorbed = {};
  for (const f of fields) {
    const key = groupKey(f.fieldKey, f.label);
    const std = standardKeyOf(key);
    if (std) {
      absorb(absorbed, std, f.fieldKey); // shown in its fixed column, whatever role it was given
      continue;
    }
    if (f.role || CORE_KEYS.has(key) || standardKeyOf(f.fieldKey) || isDroppedKey(key)) continue; // name / Mobile / email, fixed or dropped
    const label = f.displayLabel || f.label;
    const options = Array.isArray(f.options) ? (f.options as unknown[]).map(String) : [];
    // "eventId" (stored as "eventid") and "event_id" are one column.
    const existing = byKey.get(looseKey(key));
    if (!existing) {
      byKey.set(looseKey(key), { key, keys: [f.fieldKey], label, inputType: f.inputType, options, lastSeen: f.lastSeenAt.getTime() });
    } else {
      if (!existing.keys.includes(f.fieldKey)) existing.keys.push(f.fieldKey);
      // Spelt with underscores ("event_id") beats run together ("eventId"): keep that name.
      existing.options = [...new Set([...existing.options, ...options])];
      if (key.length > existing.key.length) Object.assign(existing, { key, label });
      else if (key.length === existing.key.length && f.lastSeenAt.getTime() > existing.lastSeen) Object.assign(existing, { label, lastSeen: f.lastSeenAt.getTime() });
    }
  }
  const answers = [...byKey.values()].map((f) => ({ key: f.key, keys: f.keys, label: f.label, inputType: f.inputType, options: f.options }));
  return { answers, absorbed };
}

export async function answerFields(ctx: Ctx, scope: { clientId?: string; lpId?: string }): Promise<AnswerField[]> {
  return (await formFieldGroups(ctx, scope)).answers;
}

/** Stored keys a fixed column reads: its own keys and their old copies, plus any absorbed names. */
export function columnKeys(c: StandardColumn, ...groups: Absorbed[]): string[] {
  const extra = c.keys.flatMap((k) => groups.flatMap((g) => g[k] ?? []));
  return [...new Set([...readKeys(c), ...extra])];
}

type FieldDef = FieldMeta & {
  /** Text expression used by text/choice conditions. */
  expr: Prisma.Sql;
  /** jsonb expression for answers, to match values inside multi-select arrays. */
  json?: Prisma.Sql;
  /** Compare exactly (ids) instead of case-insensitively. */
  exact?: boolean;
  /** Form field key, for GIN-indexed containment matches on leads.answers. */
  answerKey?: string;
  num?: Prisma.Sql;
  sort: Prisma.Sql;
};

const SOURCES = [
  { value: "lp", label: "LP snippet" },
  { value: "webhook", label: "Webhook" },
  { value: "meta_instant_form", label: "Meta form" },
];

// Tracking columns appear for whatever details the leads in view actually carry, in this order first.
const TRACKING_ORDER = [
  "page_url", "landing_url", "referrer", "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
  "utm_id", "utm_placement", "fbclid", "fbp", "fbc", "gclid", "form_name", "form_id", "page_path", "page_identity",
];
const TRACKING_LABELS: Record<string, string> = {
  page_url: "Page URL", landing_url: "First page", referrer: "Referrer", form_name: "Form name", form_id: "Form ID",
  page_path: "Page path", page_identity: "Page ID", ip: "IP address", user_agent: "Browser",
};
export const trackingLabel = (key: string) => TRACKING_LABELS[key] ?? key;
const TRACKING_SAMPLE = 5000;
const MAX_TRACKING_COLUMNS = 40;

/**
 * Tracking keys used by the leads in view. Reads only the newest leads (index-backed), so it stays
 * instant however many leads there are; a key that only very old leads have won't get a column.
 */
export async function trackingKeys(ctx: Ctx, scope: { clientId?: string; lpId?: string }): Promise<string[]> {
  const where: Prisma.Sql[] = [leadScopeSql(ctx)];
  if (scope.clientId) where.push(Prisma.sql`l.client_id = ${scope.clientId}`);
  if (scope.lpId) where.push(Prisma.sql`l.lp_id = ${scope.lpId}`);
  const rows = await prisma.$queryRaw<{ k: string }[]>(Prisma.sql`
    SELECT DISTINCT k FROM (
      SELECT l.tracking FROM leads l WHERE ${Prisma.join(where, " AND ")} ORDER BY l.created_at DESC LIMIT ${TRACKING_SAMPLE}
    ) t CROSS JOIN LATERAL jsonb_object_keys(t.tracking) k`);
  const rank = (k: string) => {
    const i = TRACKING_ORDER.indexOf(k);
    return i === -1 ? TRACKING_ORDER.length : i;
  };
  return rows
    .map((r) => r.k)
    .filter((k) => !standardKeyOf(k) && !standardKeyOf(sharedKey(k)) && !CORE_KEYS.has(sharedKey(k)) && !isDroppedKey(sharedKey(k))) // fixed or dropped
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    .slice(0, MAX_TRACKING_COLUMNS);
}

/** Same normalisation as form fields ("WhatsApp No" -> "whatsapp"). */
const sharedKey = (k: string) => canonicalFieldKey(toFieldKey(k));

/** Tracking keys in view that belong to a fixed column under another name (e.g. "whatsapp no"). */
export async function trackingAbsorbed(ctx: Ctx, scope: { clientId?: string; lpId?: string }): Promise<Absorbed> {
  const where: Prisma.Sql[] = [leadScopeSql(ctx)];
  if (scope.clientId) where.push(Prisma.sql`l.client_id = ${scope.clientId}`);
  if (scope.lpId) where.push(Prisma.sql`l.lp_id = ${scope.lpId}`);
  const rows = await prisma.$queryRaw<{ k: string }[]>(Prisma.sql`
    SELECT DISTINCT k FROM (
      SELECT l.tracking FROM leads l WHERE ${Prisma.join(where, " AND ")} ORDER BY l.created_at DESC LIMIT ${TRACKING_SAMPLE}
    ) t CROSS JOIN LATERAL jsonb_object_keys(t.tracking) k`);
  const out: Absorbed = {};
  for (const { k } of rows) {
    const std = STANDARD_KEYS.has(k) ? undefined : standardKeyOf(sharedKey(k));
    if (std) absorb(out, std, k);
  }
  return out;
}

/**
 * Tracking keys as columns. A key that names a form column (ignoring underscores and case, e.g.
 * "eventId" for "event_id") feeds that column; the rest are grouped the same way among themselves.
 */
export function groupTracking(answers: { key: string }[], tracking: string[]) {
  const answerByLoose = new Map(answers.map((a) => [looseKey(a.key), a.key]));
  const intoAnswer: Record<string, string[]> = {};
  const columns = new Map<string, { key: string; keys: string[] }>();
  for (const k of tracking) {
    const loose = looseKey(sharedKey(k));
    const answer = answerByLoose.get(loose);
    if (answer) (intoAnswer[answer] ??= []).push(k);
    else if (columns.has(loose)) {
      const c = columns.get(loose)!;
      c.keys.push(k);
      if (k.length > c.key.length) c.key = k; // "page_url" names the column, not "pageUrl"
    } else columns.set(loose, { key: k, keys: [k] });
  }
  return { intoAnswer, columns: [...columns.values()] };
}

/** Every filterable / sortable field for the current view. */
export async function leadFieldDefs(ctx: Ctx, scope: { clientId?: string; lpId?: string }): Promise<FieldDef[]> {
  const clientId = scope.clientId ?? (isSabhiStaff(ctx) ? undefined : ctx.clientId ?? undefined);
  const clientIds = clientId ? [clientId] : visibleClientIds(ctx);
  const clientFilter = clientIds === null ? {} : { clientId: { in: clientIds } };

  const [{ answers, absorbed }, tracking, trackAbsorbed, stages, lps, owners, clients] = await Promise.all([
    formFieldGroups(ctx, scope),
    trackingKeys(ctx, { clientId, lpId: scope.lpId }),
    trackingAbsorbed(ctx, { clientId, lpId: scope.lpId }),
    prisma.pipelineStage.findMany({ where: clientFilter, orderBy: { position: "asc" }, select: { name: true } }),
    prisma.landingPage.findMany({ where: { AND: [lpWhere(ctx), clientId ? { clientId } : {}] }, orderBy: { name: "asc" }, select: { id: true, name: true, client: { select: { name: true } } } }),
    clientId ? prisma.user.findMany({ where: { clientId }, orderBy: { name: "asc" }, select: { id: true, name: true } }) : Promise.resolve([]),
    !clientId && isSabhiStaff(ctx) ? prisma.client.findMany({ where: clientIds === null ? {} : { id: { in: clientIds } }, orderBy: { name: "asc" }, select: { id: true, name: true } }) : Promise.resolve([]),
  ]);

  const defs: FieldDef[] = [
    { id: "name", label: "name", kind: "text", group: "Lead", expr: Prisma.sql`l.name`, sort: Prisma.sql`lower(l.name)` },
    { id: "phone", label: "Mobile", kind: "text", group: "Lead", expr: Prisma.sql`l.phone_normalised`, sort: Prisma.sql`l.phone_normalised` },
    { id: "email", label: "email", kind: "text", group: "Lead", expr: Prisma.sql`l.email_normalised`, sort: Prisma.sql`l.email_normalised` },
    {
      id: "status", label: "Status", kind: "choice", group: "Lead",
      options: [...new Set(stages.map((s) => s.name))].map((n) => ({ value: n, label: n })),
      expr: Prisma.sql`s.name`, sort: Prisma.sql`s.position`,
    },
    clientId
      ? { id: "owner", label: "Owner", kind: "choice", group: "Lead", exact: true, options: owners.map((o) => ({ value: o.id, label: o.name })), expr: Prisma.sql`l.owner_id`, sort: Prisma.sql`lower(o.name)` }
      : { id: "owner", label: "Owner", kind: "text", group: "Lead", expr: Prisma.sql`o.name`, sort: Prisma.sql`lower(o.name)` },
    {
      id: "lp", label: "Landing page", kind: "choice", group: "Lead", exact: true,
      options: lps.map((lp) => ({ value: lp.id, label: clientId ? lp.name : `${lp.name} (${lp.client.name})` })),
      expr: Prisma.sql`l.lp_id`, sort: Prisma.sql`lower(p.name)`,
    },
    ...(clients.length
      ? [{ id: "client", label: "Client", kind: "choice" as const, group: "Lead" as const, exact: true, options: clients.map((c) => ({ value: c.id, label: c.name })), expr: Prisma.sql`l.client_id`, sort: Prisma.sql`lower(c.name)` }]
      : []),
    { id: "source", label: "Received via", kind: "choice", group: "Lead", exact: true, options: SOURCES, expr: Prisma.sql`l.source`, sort: Prisma.sql`l.source` },
    ...STANDARD_COLUMNS.map<FieldDef>((c) => {
      const parts = columnKeys(c, absorbed, trackAbsorbed).flatMap((k) => [Prisma.sql`NULLIF(l.answers ->> ${k}, '')`, Prisma.sql`NULLIF(l.tracking ->> ${k}, '')`]);
      if (c.fallback === "whatsapp_from_phone") parts.push(Prisma.sql`NULLIF(ltrim(l.phone_normalised, '+'), '')`);
      if (c.fallback === "received_via") {
        parts.push(Prisma.sql`CASE l.source ${Prisma.join(Object.entries(RECEIVED_VIA_LABEL).map(([v, lbl]) => Prisma.sql`WHEN ${v} THEN ${lbl}`), " ")} ELSE l.source END`);
      }
      const expr = Prisma.sql`COALESCE(${Prisma.join(parts, ", ")})`;
      return { id: c.id, label: c.header, kind: "text", group: "Lead", expr, sort: Prisma.sql`lower(${expr})` };
    }),
    { id: "duplicate", label: "Duplicate", kind: "bool", group: "Lead", expr: Prisma.sql`l.is_duplicate::text`, num: Prisma.sql`l.is_duplicate`, sort: Prisma.sql`l.is_duplicate` },
    { id: "score", label: "Quiz score", kind: "number", group: "Lead", expr: Prisma.sql`l.total_score::text`, num: Prisma.sql`l.total_score`, sort: Prisma.sql`l.total_score` },
  ];

  const grouped = groupTracking(answers, tracking);
  for (const a of answers) {
    // Several stored keys can feed one column: use the first filled one.
    const trackKeys = grouped.intoAnswer[a.key] ?? [];
    const fromTracking = trackKeys.length > 0;
    const expr =
      a.keys.length === 1 && !fromTracking
        ? Prisma.sql`(l.answers ->> ${a.keys[0]})`
        : Prisma.sql`COALESCE(${Prisma.join(
            [...a.keys.map((k) => Prisma.sql`NULLIF(l.answers ->> ${k}, '')`), ...trackKeys.map((k) => Prisma.sql`NULLIF(l.tracking ->> ${k}, '')`)],
            ", ",
          )})`;
    const json =
      a.keys.length === 1 ? Prisma.sql`(l.answers -> ${a.keys[0]})` : Prisma.sql`COALESCE(${Prisma.join(a.keys.map((k) => Prisma.sql`l.answers -> ${k}`), ", ")})`;
    defs.push({
      id: `a:${a.key}`,
      label: a.label,
      kind: a.options.length ? "choice" : a.inputType === "number" ? "number" : "text",
      group: "Form",
      options: a.options.length ? a.options.map((o) => ({ value: o, label: o })) : undefined,
      expr,
      answerKey: a.keys.length === 1 && !fromTracking ? a.keys[0] : undefined, // GIN containment needs a single key
      json,
      num: Prisma.sql`(CASE WHEN ${expr} ~ '^\\s*-?[0-9]+(\\.[0-9]+)?\\s*$' THEN btrim(${expr})::numeric END)`,
      sort: Prisma.sql`lower(${expr})`,
    });
  }
  for (const { key, keys } of grouped.columns) {
    const expr = keys.length === 1 ? Prisma.sql`(l.tracking ->> ${key})` : Prisma.sql`COALESCE(${Prisma.join(keys.map((k) => Prisma.sql`NULLIF(l.tracking ->> ${k}, '')`), ", ")})`;
    defs.push({ id: `t:${key}`, label: trackingLabel(key), kind: "text", group: "Tracking", expr, sort: Prisma.sql`lower(${expr})` });
  }
  return defs;
}

/** What the filter UI needs (no SQL). */
export const toFieldMeta = (defs: FieldDef[]): FieldMeta[] =>
  defs.map(({ id, label, kind, group, options }) => ({ id, label, kind, group, options }));

// ---------- SQL ----------

const likeEscape = (v: string) => v.replace(/[\\%_]/g, (m) => `\\${m}`);

function emptySql(def: FieldDef): Prisma.Sql {
  const e = def.expr;
  return def.json
    ? Prisma.sql`(${e} IS NULL OR btrim(${e}) = '' OR ${def.json} = '[]'::jsonb)`
    : Prisma.sql`(${e} IS NULL OR btrim(${e}) = '')`;
}

/** Column "filter by values": matches any picked value (any element, for multi-select answers). */
function inSql(def: FieldDef, values: string[]): Prisma.Sql {
  const picked = [...new Set(values.map((v) => v.trim()))].slice(0, MAX_FILTER_VALUES);
  if (!picked.length) return Prisma.sql`FALSE`; // everything unticked: nothing matches, as in Sheets
  const real = picked.filter((v) => v !== BLANK);
  const parts: Prisma.Sql[] = [];
  if (real.length) {
    const e = def.expr;
    if (def.exact) {
      parts.push(Prisma.sql`${e} IN (${Prisma.join(real)})`);
    } else {
      const lower = Prisma.join(real.map((v) => v.toLowerCase()));
      parts.push(
        def.json
          ? Prisma.sql`(lower(${e}) IN (${lower}) OR (jsonb_typeof(${def.json}) = 'array' AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(${def.json}) x WHERE lower(x) IN (${lower}))))`
          : Prisma.sql`lower(${e}) IN (${lower})`,
      );
    }
  }
  if (picked.includes(BLANK)) parts.push(emptySql(def));
  return Prisma.sql`(${Prisma.join(parts, " OR ")})`;
}

function conditionSql(def: FieldDef, c: Condition): Prisma.Sql | null {
  if (c.op === "in") return Array.isArray(c.values) ? inSql(def, c.values) : null;
  const allowed = OPS[def.kind].find((o) => o.op === c.op);
  if (!allowed) return null;
  const v = (c.value ?? "").trim();
  if (allowed.needsValue && !v) return null;
  const e = def.expr;
  const empty = emptySql(def);
  const isMatch = def.exact
    ? Prisma.sql`${e} = ${v}`
    : def.json
      ? Prisma.sql`(lower(${e}) = lower(${v}) OR (jsonb_typeof(${def.json}) = 'array' AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(${def.json}) x WHERE lower(x) = lower(${v}))))`
      : Prisma.sql`lower(${e}) = lower(${v})`;
  const num = Number(v);
  // A dropdown/radio/checkbox value picked from the form's own options: exact containment,
  // which the GIN index on leads.answers serves directly (single value or inside an array).
  const isOption = def.answerKey !== undefined && def.options?.some((o) => o.value === v);
  const indexedMatch = isOption
    ? Prisma.sql`(l.answers @> jsonb_build_object(${def.answerKey}::text, ${v}::text) OR l.answers @> jsonb_build_object(${def.answerKey}::text, jsonb_build_array(${v}::text)))`
    : null;

  switch (c.op) {
    case "contains": return Prisma.sql`${e} ILIKE ${`%${likeEscape(v)}%`}`;
    case "not_contains": return Prisma.sql`(${e} IS NULL OR ${e} NOT ILIKE ${`%${likeEscape(v)}%`})`;
    case "starts_with": return Prisma.sql`${e} ILIKE ${`${likeEscape(v)}%`}`;
    case "is":
      if (def.kind === "number") return Number.isFinite(num) && def.num ? Prisma.sql`${def.num} = ${num}` : null;
      return indexedMatch ?? isMatch;
    case "is_not": return Prisma.sql`(${e} IS NULL OR NOT ${indexedMatch ?? isMatch})`;
    case "empty": return empty;
    case "not_empty": return Prisma.sql`NOT ${empty}`;
    case "gt": return Number.isFinite(num) && def.num ? Prisma.sql`${def.num} > ${num}` : null;
    case "lt": return Number.isFinite(num) && def.num ? Prisma.sql`${def.num} < ${num}` : null;
    case "true": return Prisma.sql`l.is_duplicate = TRUE`;
    case "false": return Prisma.sql`l.is_duplicate = FALSE`;
  }
}

/**
 * One LIKE on leads.search_text (lowercased name, email, phone digits and answer values), served by
 * its trigram index. Phone-like input ("098765 43210", "+91 98765") is matched on digits only.
 */
function searchSql(q: string): Prisma.Sql {
  const phoneLike = /^[\d\s+()-]+$/.test(q);
  const digits = q.replace(/\D/g, "").replace(/^0+/, "");
  const needle = phoneLike && digits.length >= 3 ? digits : q.toLowerCase().replace(/\s+/g, " ");
  return Prisma.sql`l.search_text LIKE ${`%${likeEscape(needle)}%`}`;
}

export const LEAD_INCLUDE = {
  lp: { select: { id: true, name: true } },
  status: { select: { id: true, name: true } },
  owner: { select: { id: true, name: true } },
  client: { select: { name: true } },
} satisfies Prisma.LeadInclude;

export type LeadRow = Prisma.LeadGetPayload<{ include: typeof LEAD_INCLUDE }>;

/**
 * A condition on a form ("a:key") or tracking ("t:key") field that has no column right now (e.g. no
 * recent lead carries it) still filters on that key, so it matches nothing rather than being dropped.
 * Keys are bound as parameters, never spliced into SQL.
 */
function jsonFieldDef(id: string): FieldDef | undefined {
  const m = /^(a|t):(.{1,200})$/.exec(id);
  if (!m) return undefined;
  const col = m[1] === "a" ? Prisma.raw("l.answers") : Prisma.raw("l.tracking");
  const expr = Prisma.sql`(${col} ->> ${m[2]})`;
  return { id, label: m[2], kind: "text", group: m[1] === "a" ? "Form" : "Tracking", expr, json: m[1] === "a" ? Prisma.sql`(${col} -> ${m[2]})` : undefined, sort: Prisma.sql`lower(${expr})` };
}

const FROM_LEADS = Prisma.sql`FROM leads l
    LEFT JOIN pipeline_stages s ON s.id = l.status_id
    LEFT JOIN users o ON o.id = l.owner_id
    LEFT JOIN landing_pages p ON p.id = l.lp_id
    LEFT JOIN clients c ON c.id = l.client_id`; // all LEFT JOINs on primary keys: Postgres drops the unused ones

/** WHERE for a query, always tenant-scoped. `skipField` leaves out that column's own conditions. */
function buildWhere(ctx: Ctx, query: LeadQuery, byId: Map<string, FieldDef>, skipField?: string): Prisma.Sql {
  const where: Prisma.Sql[] = [leadScopeSql(ctx)];
  if (query.clientId) where.push(Prisma.sql`l.client_id = ${query.clientId}`);
  if (query.lpId) where.push(Prisma.sql`l.lp_id = ${query.lpId}`);
  if (query.range) {
    const { from, to } = rangeBounds(query.range);
    where.push(Prisma.sql`l.created_at >= ${naiveUtc(from)}`);
    if (to) where.push(Prisma.sql`l.created_at < ${naiveUtc(to)}`);
  }
  if (query.q) where.push(searchSql(query.q));
  for (const c of query.conditions) {
    if (c.field === skipField) continue;
    const def = byId.get(c.field) ?? jsonFieldDef(c.field);
    const sql = def && conditionSql(def, c);
    if (sql) where.push(sql);
  }
  return Prisma.join(where, " AND ");
}

export async function queryLeads(ctx: Ctx, query: LeadQuery, defs?: FieldDef[]) {
  const fieldDefs = defs ?? (query.conditions.length || query.sort ? await leadFieldDefs(ctx, query) : []);
  const byId = new Map(fieldDefs.map((d) => [d.id, d]));
  const from = FROM_LEADS;
  const whereSql = buildWhere(ctx, query, byId);
  const sortDef = query.sort ? byId.get(query.sort) : undefined;
  const dir = Prisma.raw(query.dir === "asc" ? "ASC" : "DESC");
  const orderBy = sortDef
    ? Prisma.sql`${sortDef.sort} ${dir} NULLS LAST, l.created_at DESC, l.id DESC`
    : query.sort === "created_at"
      ? Prisma.sql`l.created_at ${dir}, l.id ${dir}`
      : Prisma.sql`l.created_at DESC, l.id DESC`; // id breaks ties so pages never repeat or skip rows
  const offset = (query.page - 1) * query.pageSize;

  const [countRows, idRows] = await Promise.all([
    // Counting stops at COUNT_CAP: exact totals for normal views, bounded cost for huge ones.
    prisma.$queryRaw<{ n: number }[]>(
      Prisma.sql`SELECT count(*)::int AS n FROM (SELECT 1 ${from} WHERE ${whereSql} LIMIT ${COUNT_CAP + 1}) t`,
    ),
    prisma.$queryRaw<{ id: string }[]>(
      Prisma.sql`SELECT l.id ${from} WHERE ${whereSql} ORDER BY ${orderBy} LIMIT ${query.pageSize} OFFSET ${offset}`,
    ),
  ]);
  const ids = idRows.map((r) => r.id);
  const found = ids.length ? await prisma.lead.findMany({ where: { id: { in: ids } }, include: LEAD_INCLUDE }) : [];
  const order = new Map(ids.map((id, i) => [id, i]));
  found.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  const counted = countRows[0]?.n ?? 0;
  return { rows: found, total: Math.min(counted, COUNT_CAP), totalCapped: counted > COUNT_CAP };
}

/** Distinct values are read from at most this many of the newest matching leads. */
const VALUES_SAMPLE = 50_000;
const VALUES_LIMIT = 500;

export type ColumnValue = { value: string; label: string; count: number };

/**
 * Values for a column's "filter by values" list, with counts. Like Google Sheets, it reflects every
 * other active filter but ignores this column's own, so unticked values can be ticked again.
 */
export async function columnValues(ctx: Ctx, query: LeadQuery, defs: FieldDef[], fieldId: string) {
  const byId = new Map(defs.map((d) => [d.id, d]));
  const def = byId.get(fieldId);
  if (!def) return null;
  const whereSql = buildWhere(ctx, query, byId, fieldId);
  const sample = Prisma.sql`SELECT ${def.json ?? Prisma.sql`NULL::jsonb`} AS j, ${def.expr} AS v ${FROM_LEADS}
    WHERE ${whereSql} ORDER BY l.created_at DESC LIMIT ${VALUES_SAMPLE}`;
  // Multi-select answers count once per ticked option; empty arrays count as blank.
  const valueSql = def.json
    ? Prisma.sql`SELECT NULLIF(btrim(x), '') AS v FROM t CROSS JOIN LATERAL jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(t.j) = 'array' AND jsonb_array_length(t.j) > 0 THEN t.j
             WHEN jsonb_typeof(t.j) = 'array' THEN '[null]'::jsonb
             ELSE jsonb_build_array(t.j #>> '{}') END) x`
    : Prisma.sql`SELECT NULLIF(btrim(t.v), '') AS v FROM t`;
  const rows = await prisma.$queryRaw<{ v: string | null; n: number; sampled: number }[]>(Prisma.sql`
    WITH t AS (${sample})
    SELECT v, count(*)::int AS n, (SELECT count(*) FROM t)::int AS sampled FROM (${valueSql}) vals
    GROUP BY v ORDER BY v IS NULL, lower(v) LIMIT ${VALUES_LIMIT + 1}`);
  const labels = new Map((def.options ?? []).map((o) => [o.value, o.label]));
  const values: ColumnValue[] = rows.slice(0, VALUES_LIMIT).map((r) => ({
    value: r.v ?? BLANK,
    label: r.v === null ? "(Blanks)" : labels.get(r.v) ?? r.v,
    count: r.n,
  }));
  return { values, truncated: rows.length > VALUES_LIMIT, sampled: (rows[0]?.sampled ?? 0) >= VALUES_SAMPLE };
}

/**
 * Does one lead match a set of conditions? Used by outbound webhooks. Runs with system scope, limited
 * to the lead's own client, so conditions on form fields resolve against that client's fields.
 */
export async function leadMatchesConditions(clientId: string, leadId: string, conditions: Condition[]): Promise<boolean> {
  const system: Ctx = { userId: "system", role: "SUPER_ADMIN", clientId: null, managedClientIds: [], lpIds: [] };
  const query: LeadQuery = { clientId, conditions, dir: "desc", page: 1, pageSize: 1 };
  const defs = conditions.length ? await leadFieldDefs(system, { clientId }) : [];
  const where = buildWhere(system, query, new Map(defs.map((d) => [d.id, d])));
  const rows = await prisma.$queryRaw<{ ok: number }[]>(
    Prisma.sql`SELECT 1 AS ok ${FROM_LEADS} WHERE l.id = ${leadId} AND ${where} LIMIT 1`,
  );
  return rows.length > 0;
}
