// Column definitions shared by the leads table and CSV export, so the CSV always matches the screen.
// Column ids match leadQuery field ids, so every column can be sorted.
import { columnKeys, formFieldGroups, trackingAbsorbed, trackingKeys, trackingLabel, type LeadRow } from "@/lib/leadQuery";
import { RECEIVED_VIA_LABEL, STANDARD_COLUMNS, standardValue } from "@/lib/standardColumns";
import { isSabhiStaff, type Ctx } from "@/lib/tenant";

export type Column = { id: string; header: string; value: (lead: LeadRow) => string };

const IST = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
});

/** "2027-01-10 15:30" in IST, used on screen and in CSV. */
export function formatDateTime(d: Date): string {
  return IST.format(d).replace(",", "");
}

export function formatAnswer(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.join("; ");
  return String(v);
}

/**
 * Column order: the fixed layout (lib/standardColumns) shared by every client, then the tool's own
 * columns, then any other form field or tracking detail the leads in view carry.
 */
export async function leadColumns(ctx: Ctx, scope: { clientId?: string; lpId?: string }): Promise<Column[]> {
  const singleClient = Boolean(scope.clientId) || !isSabhiStaff(ctx);
  const trackScope = { clientId: scope.clientId ?? (isSabhiStaff(ctx) ? undefined : ctx.clientId ?? undefined), lpId: scope.lpId };
  const [{ answers, absorbed }, tracking, trackAbsorbed] = await Promise.all([
    formFieldGroups(ctx, scope),
    trackingKeys(ctx, trackScope),
    trackingAbsorbed(ctx, trackScope),
  ]);
  const track = (k: string) => (l: LeadRow) => formatAnswer((l.tracking as Record<string, unknown>)[k]);
  return [
    { id: "created_at", header: "Date of Registration", value: (l) => formatDateTime(l.createdAt) },
    { id: "name", header: "name", value: (l) => l.name ?? "" },
    { id: "phone", header: "Mobile", value: (l) => l.phoneNormalised ?? "" },
    { id: "email", header: "email", value: (l) => l.emailNormalised ?? "" },
    ...STANDARD_COLUMNS.map<Column>((c) => {
      const keys = columnKeys(c, absorbed, trackAbsorbed);
      return { id: c.id, header: c.header, value: (l) => standardValue(c, l, formatAnswer, keys) };
    }),
    { id: "status", header: "Status", value: (l) => l.status?.name ?? "" },
    { id: "owner", header: "Owner", value: (l) => l.owner?.name ?? "" },
    ...(scope.lpId ? [] : [{ id: "lp", header: "Landing page", value: (l: LeadRow) => l.lp?.name ?? "" }]),
    ...(singleClient ? [] : [{ id: "client", header: "Client", value: (l: LeadRow) => l.client.name }]),
    { id: "source", header: "Received via", value: (l) => RECEIVED_VIA_LABEL[l.source] ?? l.source },
    { id: "score", header: "Score", value: (l) => (l.totalScore ?? "").toString() },
    ...answers.map<Column>((f) => ({
      id: `a:${f.key}`,
      header: f.label,
      value: (l) => {
        const answers = l.answers as Record<string, unknown>;
        const tracking = l.tracking as Record<string, unknown>;
        const v = [...f.keys.map((k) => answers[k]), tracking[f.key]].find((x) => x !== undefined && x !== null && x !== "");
        return formatAnswer(v ?? "");
      },
    })),
    // A key that is also a form answer already has that column.
    ...tracking.filter((k) => !answers.some((a) => a.key === k)).map<Column>((k) => ({ id: `t:${k}`, header: trackingLabel(k), value: track(k) })),
  ];
}

export function toCsv(columns: Column[], leads: LeadRow[]): string {
  const esc = (s: string) => {
    // Guard against spreadsheet formula injection (phone numbers like +91… are left alone).
    const safe = /^[=+\-@\t\r]/.test(s) && !/^\+\d+$/.test(s) ? `'${s}` : s;
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const lines = [columns.map((c) => esc(c.header)).join(",")];
  for (const lead of leads) lines.push(columns.map((c) => esc(c.value(lead))).join(","));
  return "﻿" + lines.join("\r\n");
}
