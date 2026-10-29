import { parsePhoneNumberFromString } from "libphonenumber-js";

/** E.164 phone, defaulting to India (+91) for national numbers. Null when unparseable. */
export function normalisePhone(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let s = raw.trim().replace(/[^\d+]/g, "");
  if (!s) return null;
  if (s.startsWith("00")) s = `+${s.slice(2)}`;
  if (/^91\d{10}$/.test(s)) s = `+${s}`;
  const parsed = parsePhoneNumberFromString(s, "IN");
  return parsed?.isValid() ? parsed.number : null;
}

export function normaliseEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}
