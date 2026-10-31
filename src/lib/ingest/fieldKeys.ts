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
    "contact_number", "contact_no", "tel", "telephone", "cell",
    "cell_phone", "your_phone", "your_mobile", "your_phone_number", "your_mobile_number",
  ],
  // Its own field: fills "Formatted WhatsApp Number", and stands in for the phone only when there's no Mobile.
  whatsapp: ["whatsapp_number", "whatsapp_no", "whatsappno", "whatsapp_num", "whatsapp_mobile", "wa_number", "your_whatsapp", "your_whatsapp_number"],
  name: ["full_name", "fullname", "your_name", "your_full_name"],
  first_name: ["firstname", "fname", "given_name"],
  last_name: ["lastname", "lname", "surname", "family_name"],
  city: ["your_city", "town"],
  message: ["your_message", "msg", "comments", "comment"],
  company: ["company_name", "business_name", "organisation", "organization"],
};
const CANONICAL = new Map(Object.entries(SYNONYMS).flatMap(([key, alts]) => alts.map((a) => [a, key] as const)));

// Any other field named after WhatsApp ("WhatsApp Mobile No.", "Whats App No", "WhatsApp Number (with
// country code)") is the WhatsApp number too, unless it's clearly not a number.
const WHATSAPP_NAME = /(^|_)whats_?app(_|$)/;
const NOT_A_NUMBER = /formatted|opt|consent|link|button|group|community|channel|message|msg|status|chat|updates/;

/** The shared key for a normalised field key ("email_address" -> "email", "whatsapp_mobile_no" -> "whatsapp"). */
export function canonicalFieldKey(key: string): string {
  const known = CANONICAL.get(key);
  if (known) return known;
  if (WHATSAPP_NAME.test(key) && !NOT_A_NUMBER.test(key)) return "whatsapp";
  return key;
}

/**
 * Normalised keys (incl. common synonyms). The same field sent twice in one submission ("utm_placement"
 * and "UTM_Placement") gets the same key and is merged by the caller: never a second "_2" column.
 */
export function assignFieldKeys(names: string[]): string[] {
  return names.map((name) => canonicalFieldKey(toFieldKey(name)));
}

/** Form version = hash of the sorted key:type pairs. */
export function formVersionHash(fields: { key: string; type: string }[]): string {
  const sig = fields.map((f) => `${f.key}:${f.type}`).sort().join("|");
  return createHash("sha256").update(sig).digest("hex").slice(0, 16);
}
