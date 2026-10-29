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

/** Normalises keys and suffixes duplicates within one submission: q, q_2, q_3. */
export function assignFieldKeys(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((name) => {
    const base = toFieldKey(name);
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
