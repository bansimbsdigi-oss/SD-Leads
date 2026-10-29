// Shared by the server query and the client-side filter UI. No server imports here.

export type FieldKind = "text" | "number" | "choice" | "bool";

export type FieldMeta = {
  id: string;
  label: string;
  kind: FieldKind;
  group: "Lead" | "Form" | "Tracking";
  options?: { value: string; label: string }[];
};

export type Op = "contains" | "not_contains" | "is" | "is_not" | "starts_with" | "empty" | "not_empty" | "gt" | "lt" | "true" | "false" | "in";

/** `in` (column "filter by values") uses `values`; every other op uses `value`. */
export type Condition = { field: string; op: Op; value?: string; values?: string[] };

/** Stands for "(Blanks)" in a values list. */
export const BLANK = "";
export const MAX_FILTER_VALUES = 500;

/** Human text for a condition chip, e.g. `City is one of "Pune", "Delhi"`. */
export function describeCondition(c: Condition, field?: FieldMeta): { field: string; op: string; value?: string } {
  const label = (v: string) => (v === BLANK ? "(Blanks)" : field?.options?.find((o) => o.value === v)?.label ?? v);
  if (c.op === "in") {
    const vals = c.values ?? [];
    const shown = vals.slice(0, 3).map((v) => `“${label(v)}”`).join(", ");
    return { field: field?.label ?? c.field, op: vals.length === 1 ? "is" : "is one of", value: vals.length > 3 ? `${shown} +${vals.length - 3} more` : shown };
  }
  const op = field ? OPS[field.kind].find((o) => o.op === c.op)?.label ?? c.op : c.op;
  return { field: field?.label ?? c.field, op, value: c.value ? `“${label(c.value)}”` : undefined };
}

export const OPS: Record<FieldKind, { op: Op; label: string; needsValue: boolean }[]> = {
  text: [
    { op: "contains", label: "contains", needsValue: true },
    { op: "not_contains", label: "does not contain", needsValue: true },
    { op: "is", label: "is", needsValue: true },
    { op: "is_not", label: "is not", needsValue: true },
    { op: "starts_with", label: "starts with", needsValue: true },
    { op: "empty", label: "is empty", needsValue: false },
    { op: "not_empty", label: "is not empty", needsValue: false },
  ],
  choice: [
    { op: "is", label: "is", needsValue: true },
    { op: "is_not", label: "is not", needsValue: true },
    { op: "contains", label: "contains", needsValue: true },
    { op: "empty", label: "is empty", needsValue: false },
    { op: "not_empty", label: "is not empty", needsValue: false },
  ],
  number: [
    { op: "is", label: "=", needsValue: true },
    { op: "gt", label: ">", needsValue: true },
    { op: "lt", label: "<", needsValue: true },
    { op: "empty", label: "is empty", needsValue: false },
    { op: "not_empty", label: "is not empty", needsValue: false },
  ],
  bool: [
    { op: "true", label: "yes", needsValue: false },
    { op: "false", label: "no", needsValue: false },
  ],
};

export const RANGES = [
  { id: "today", label: "Today" },
  { id: "yesterday", label: "Yesterday" },
  { id: "7d", label: "1 week" },
  { id: "15d", label: "15 days" },
  { id: "30d", label: "30 days" },
  { id: "6m", label: "6 months" },
] as const;

export type RangeId = (typeof RANGES)[number]["id"];
