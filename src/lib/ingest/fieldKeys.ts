// Field key rules (plan section 5.3).
import { createHash } from "node:crypto";

export const RESERVED_KEYS = new Set(["submission_id", "lp", "tracking"]);
const MAX_KEY_LENGTH = 64;

export function toFieldKey(name: string): string {
  let key = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, MAX_KEY_LENGTH);
  if (!key) key = "field";
  if (RESERVED_KEYS.has(key)) key = `${key}_field`;
  return key;
}

// Common spellings of the same question share one key, so "Email", "E-mail", "Email Address" and
// "Your Email" are one column, not four. Matched after toFieldKey (lowercase, underscores).
const SYNONYMS: Record<string, string[]> = {
  email: ["e_mail", "email_address", "emailaddress", "email_id", "emailid", "your_email", "your_email_address", "mail", "mail_id"],
  phone: [
    "phone_number", "phonenumber", "phone_no", "mobile", "mobile_number", "mobilenumber", "mobile_no", "mobileno",
    "contact_number", "contact_no", "whatsapp", "whatsapp_number", "whatsapp_no", "tel", "telephone", "cell",
    "cell_phone", "your_phone", "your_mobile", "your_phone_number", "your_mobile_number",
  ],
  name: ["full_name", "fullname", "your_name", "your_full_name"],
  first_name: ["firstname", "fname", "given_name"],
  last_name: ["lastname", "lname", "surname", "family_name"],
  city: ["your_city", "town"],
  message: ["your_message", "msg", "comments", "comment"],
  company: ["company_name", "business_name", "organisation", "organization"],
};
const CANONICAL = new Map(Object.entries(SYNONYMS).flatMap(([key, alts]) => alts.map((a) => [a, key] as const)));

/** The shared key for a normalised field key ("email_address" -> "email"). */
export const canonicalFieldKey = (key: string) => CANONICAL.get(key) ?? key;

/** Normalises keys (incl. common synonyms) and suffixes duplicates within one submission: q, q_2, q_3. */
export function assignFieldKeys(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((name) => {
    const base = canonicalFieldKey(toFieldKey(name));
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    if (count === 1) return base;
    const suffix = `_${count}`;
    return base.slice(0, MAX_KEY_LENGTH - suffix.length) + suffix;
  });
}

/** Form version = hash of the sorted key:type pairs. */
export function formVersionHash(fields: { key: string; type: string }[]): string {
  const sig = fields.map((f) => `${f.key}:${f.type}`).sort().join("|");
  return createHash("sha256").update(sig).digest("hex").slice(0, 16);
}
