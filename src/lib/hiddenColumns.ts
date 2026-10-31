// Columns a user has hidden from the leads table, kept in a cookie so the server renders the table
// without them (no flash). Hidden fields still show on the lead's own page; CSV export keeps every column.

export const HIDDEN_COLUMNS_COOKIE = "sl_hidden_cols";

/** Always shown: the name links to the lead. */
export const ALWAYS_SHOWN = new Set(["name"]);

const MAX_HIDDEN = 150; // keeps the cookie well under the browser's 4 KB limit

export function parseHiddenColumns(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  try {
    const list: unknown = JSON.parse(decodeURIComponent(raw));
    return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === "string" && x.length <= 200).slice(0, MAX_HIDDEN) : []);
  } catch {
    return new Set();
  }
}

/** Browser only: the current hidden list. */
export function readHiddenColumns(): Set<string> {
  const raw = document.cookie.split("; ").find((c) => c.startsWith(`${HIDDEN_COLUMNS_COOKIE}=`));
  return parseHiddenColumns(raw?.slice(HIDDEN_COLUMNS_COOKIE.length + 1));
}

/** Browser only: saves the hidden list for a year. */
export function writeHiddenColumns(ids: Iterable<string>) {
  const list = [...new Set(ids)].filter((id) => !ALWAYS_SHOWN.has(id)).slice(0, MAX_HIDDEN);
  document.cookie = `${HIDDEN_COLUMNS_COOKIE}=${encodeURIComponent(JSON.stringify(list))}; path=/; max-age=31536000; samesite=lax`;
}
