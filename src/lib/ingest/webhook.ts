// Client webhook: turns whatever a form tool posts (lead.js JSON, Elementor, WPForms, Pabbly, plain
// key/value forms) into our ingest payload, and works out which LP it came from.
import { createHash } from "node:crypto";
import type { IngestField } from "./schema";

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };
type Obj = { [k: string]: Json };

/** Parses `a[b][c]=1` style keys (Elementor "advanced data", PHP forms) into nested objects. */
export function nestBracketKeys(entries: [string, string][]): Obj {
  const root: Obj = {};
  for (const [rawKey, value] of entries) {
    const parts = rawKey.replace(/\]/g, "").split("[");
    let node: Obj = root;
    parts.forEach((part, i) => {
      const last = i === parts.length - 1;
      const key = part === "" ? String(Object.keys(node).length) : part; // `a[]=x` appends
      if (last) {
        const prev = node[key];
        node[key] = prev === undefined ? value : Array.isArray(prev) ? [...prev, value] : [prev as Json, value];
      } else {
        if (typeof node[key] !== "object" || node[key] === null || Array.isArray(node[key])) node[key] = {};
        node = node[key] as Obj;
      }
    });
  }
  return root;
}

/** Reads JSON, x-www-form-urlencoded or multipart bodies. Returns null when unreadable. */
export async function readBody(req: Request): Promise<Obj | null> {
  const type = req.headers.get("content-type") ?? "";
  try {
    if (type.includes("multipart/form-data")) {
      const fd = await req.formData();
      return nestBracketKeys([...fd.entries()].filter(([, v]) => typeof v === "string") as [string, string][]);
    }
    const text = await req.text();
    if (!text.trim()) return {};
    if (type.includes("application/x-www-form-urlencoded") || (!type.includes("json") && !/^\s*[[{]/.test(text))) {
      return nestBracketKeys([...new URLSearchParams(text).entries()]);
    }
    const parsed = JSON.parse(text) as Json;
    if (Array.isArray(parsed)) return (parsed[0] as Obj) ?? {};
    return parsed && typeof parsed === "object" ? (parsed as Obj) : null;
  } catch {
    return null;
  }
}

const TRACKING_KEYS = new Set([
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "utm_id",
  "fbclid", "gclid", "fbp", "fbc", "_fbp", "_fbc", "page_url", "referrer", "landing_url",
]);
// Metadata many form tools add as plain fields. Kept in tracking, not shown as answers.
const META_ALIASES: Record<string, string> = {
  "page url": "page_url", page_url: "page_url", url: "page_url", "source url": "page_url", referer: "referrer",
  "user agent": "user_agent", user_agent: "user_agent", "remote ip": "ip", remote_ip: "ip", ip: "ip",
  date: "date", time: "time", "powered by": "powered_by", form_id: "form_id", form_name: "form_name",
  "form name": "form_name", "form id": "form_id", post_id: "post_id",
};
const CONTROL_KEYS = new Set(["submission_id", "lp", "lp_key", "turnstile_token", "action", "_wpnonce", "g-recaptcha-response", "cf-turnstile-response"]);

export function guessRole(key: string, label = ""): IngestField["role"] {
  const s = `${key} ${label}`.toLowerCase();
  if (/e-?mail/.test(s)) return "email";
  if (/phone|mobile|whats\s?app|contact\s*(no|number)|\bcell\b|\btel\b/.test(s)) return "phone";
  if (/(^|[\s_])(full[\s_]?)?name\b|your name|first[\s_]?name/.test(s) && !/company|business|brand|user ?name/.test(s)) return "name";
  return null;
}

function toValue(v: Json): IngestField["value"] {
  if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  if (Array.isArray(v)) return v.map((x) => (typeof x === "object" && x !== null ? JSON.stringify(x) : String(x)));
  return JSON.stringify(v);
}

function str(v: Json | undefined): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : undefined;
}

export type NormalisedWebhook = {
  submissionId: string | null;
  fields: IngestField[];
  tracking: Record<string, string>;
  consent: { given: boolean; text?: string; at?: string } | null;
  pageUrl: string | null;
  formName: string | null;
  lpKey: string | null;
};

// Envelope formats (Webflow, some Pabbly/Zapier/Make setups) put the answers in a nested object and use
// the top-level "name"/"title" for the FORM's name: { name: "Contact Form", data: { Name, Email, ... } }.
const ENVELOPE_KEYS = ["data", "payload", "submission", "form_data", "formdata", "form_response", "entry", "values", "answers", "fields_data"];
const FORM_NAME_KEYS = ["name", "form_name", "formname", "form", "title", "form_title"];

function isPlainObject(v: Json | undefined): v is Obj {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

/** Lifts the answers out of an envelope. Returns null when the body isn't one. */
export function unwrapEnvelope(body: Obj): { body: Obj; formName: string | null; meta: Record<string, string> } | null {
  const lower = new Map(Object.keys(body).map((k) => [k.toLowerCase(), k]));
  const envKey = ENVELOPE_KEYS.map((k) => lower.get(k)).find((k) => k && isPlainObject(body[k]) && Object.keys(body[k] as Obj).length > 0);
  if (!envKey) return null;
  const inner = body[envKey] as Obj;
  let formName: string | null = null;
  const meta: Record<string, string> = {};
  const lifted: Obj = { ...inner };
  for (const [k, v] of Object.entries(body)) {
    if (k === envKey) continue;
    const lk = k.toLowerCase();
    if (FORM_NAME_KEYS.includes(lk)) {
      formName ??= str(isPlainObject(v) ? v.name : v) ?? null;
    } else if (lk === "submission_id" || lk === "id" || lk === "_id") {
      lifted.submission_id ??= v; // the tool's own id makes its retries idempotent
    } else if (TRACKING_KEYS.has(lk) || META_ALIASES[lk] || CONTROL_KEYS.has(lk)) {
      lifted[k] ??= v; // handled by the normal rules below
    } else if (!isPlainObject(v) && !Array.isArray(v) && str(v)) {
      meta[lk.slice(0, 60)] = str(v)!.slice(0, 500); // e.g. site, submittedAt: context, not answers
    }
  }
  return { body: lifted, formName, meta };
}

/** Converts any supported body into fields + tracking. */
export function normaliseWebhookBody(rawBody: Obj): NormalisedWebhook {
  const tracking: Record<string, string> = {};
  const fields: IngestField[] = [];
  let formName: string | null = null;
  let body = rawBody;
  const envelope = Array.isArray(rawBody.fields) || isPlainObject(rawBody.fields) ? null : unwrapEnvelope(rawBody);
  if (envelope) {
    body = envelope.body;
    formName = envelope.formName;
    Object.assign(tracking, envelope.meta);
  }

  const addTracking = (k: string, v: Json | undefined) => {
    const s = str(v);
    if (s) tracking[k.replace(/^_(fbp|fbc)$/, "$1")] = s.slice(0, 2000);
  };

  // 1. Our own lead.js shape: { fields: [{ key, value, ... }], tracking, consent }
  if (Array.isArray(body.fields) && body.fields.every((f) => f && typeof f === "object" && "key" in (f as Obj))) {
    for (const f of body.fields as Obj[]) fields.push(f as unknown as IngestField);
    if (body.tracking && typeof body.tracking === "object") for (const [k, v] of Object.entries(body.tracking as Obj)) addTracking(k, v);
  }
  // 2. Elementor "advanced data": fields[id][title|value|type], meta[page_url][value], form[name]
  else if (body.fields && typeof body.fields === "object" && !Array.isArray(body.fields)) {
    for (const [id, raw] of Object.entries(body.fields as Obj)) {
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        const f = raw as Obj;
        const label = str(f.title) ?? id;
        const type = str(f.type) ?? "text";
        fields.push({ key: str(f.id) ?? id, label, type, role: guessRole(id, label), value: toValue(f.raw_value ?? f.value ?? "") });
      } else {
        fields.push({ key: id, label: id, type: "text", role: guessRole(id), value: toValue(raw) });
      }
    }
    const meta = body.meta as Obj | undefined;
    if (meta && typeof meta === "object") {
      for (const [k, v] of Object.entries(meta)) {
        const val = v && typeof v === "object" && !Array.isArray(v) ? (v as Obj).value : v;
        addTracking(META_ALIASES[k.toLowerCase()] ?? k.toLowerCase(), val);
      }
    }
    const form = body.form as Obj | undefined;
    formName = str(form?.name) ?? null;
  }

  // 3. Plain key/value (Elementor simple, WPForms, Pabbly, HTML forms). Also catches top-level extras of 1–2.
  for (const [key, raw] of Object.entries(body)) {
    if (key === "fields" || key === "meta" || key === "form" || key === "tracking" || key === "consent") continue;
    const lower = key.toLowerCase().trim();
    if (CONTROL_KEYS.has(lower)) continue;
    if (TRACKING_KEYS.has(lower)) { addTracking(lower, raw); continue; }
    if (META_ALIASES[lower]) {
      if (META_ALIASES[lower] === "form_name") formName = str(raw) ?? formName;
      addTracking(META_ALIASES[lower], raw);
      continue;
    }
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      // Nested object such as name[first], name[last]: one field per leaf.
      for (const [sub, v] of Object.entries(raw as Obj)) {
        fields.push({ key: `${key}_${sub}`, label: `${key} ${sub}`, type: "text", role: guessRole(`${key}_${sub}`), value: toValue(v) });
      }
      continue;
    }
    const role = guessRole(key);
    fields.push({ key, label: key, type: role === "email" ? "email" : role === "phone" ? "tel" : "text", role, value: toValue(raw) });
  }

  let consent: NormalisedWebhook["consent"] = null;
  if (body.consent && typeof body.consent === "object" && !Array.isArray(body.consent)) {
    const c = body.consent as Obj;
    consent = { given: c.given === true || c.given === "true", text: str(c.text), at: str(c.at) };
  }

  const submissionId = str(body.submission_id) ?? str(body.entry_id) ?? str(body.lead_id) ?? null;
  return {
    submissionId,
    fields,
    tracking,
    consent,
    pageUrl: tracking.page_url ?? tracking.referrer ?? null,
    formName,
    lpKey: str(body.lp_key) ?? str(body.lp) ?? null,
  };
}

/** Stable id for bodies without one, so a form tool retrying the same POST never creates two leads. */
export function fallbackSubmissionId(clientId: string, body: Obj): string {
  const canonical = JSON.stringify(body, Object.keys(flattenKeys(body)).sort());
  return `wh-${createHash("sha256").update(`${clientId}|${canonical}`).digest("hex").slice(0, 32)}`;
}

function flattenKeys(o: Json, out: Record<string, true> = {}): Record<string, true> {
  if (o && typeof o === "object") {
    for (const [k, v] of Object.entries(o)) {
      out[k] = true;
      flattenKeys(v as Json, out);
    }
  }
  return out;
}

/** "ritu.com/webinar" from a page URL: host without www + path, no query, no trailing slash. */
export function sourceKeyFromUrl(pageUrl: string): string | null {
  try {
    const u = new URL(pageUrl);
    if (!/^https?:$/.test(u.protocol)) return null;
    const path = u.pathname.replace(/\/+$/, "").toLowerCase();
    return `${u.hostname.toLowerCase().replace(/^www\./, "")}${path}`.slice(0, 300);
  } catch {
    return null;
  }
}
