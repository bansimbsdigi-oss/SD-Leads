// Content of leads.search_text: one lowercased string per lead, trigram-indexed, so search is
// a single indexed LIKE instead of scanning every answer. Keep in sync with the backfill in
// prisma/migrations/20261029090000_scale_indexes_search.
const MAX = 4000;

export function buildSearchText(lead: {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  answers: Record<string, unknown>;
}): string {
  const parts: string[] = [];
  for (const v of [lead.name, lead.email, lead.phone?.replace(/^\+/, "")]) if (v) parts.push(v);
  for (const v of Object.values(lead.answers)) {
    if (Array.isArray(v)) parts.push(v.join(" "));
    else if (v !== null && v !== undefined && v !== "") parts.push(String(v));
  }
  return parts.join(" ").toLowerCase().slice(0, MAX);
}
