// Column definitions shared by the leads table and CSV export, so the CSV always matches the screen.
// Column ids match leadQuery field ids, so every column can be sorted.
import { answerFields, trackingKeys, trackingLabel, type LeadRow } from "@/lib/leadQuery";
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

const SOURCE_LABEL: Record<string, string> = { lp: "LP snippet", webhook: "Webhook", meta_instant_form: "Meta form" };

export async function leadColumns(ctx: Ctx, scope: { clientId?: string; lpId?: string }): Promise<Column[]> {
  const singleClient = Boolean(scope.clientId) || !isSabhiStaff(ctx);
  const [answers, tracking] = await Promise.all([
    answerFields(ctx, scope),
    trackingKeys(ctx, { clientId: scope.clientId ?? (isSabhiStaff(ctx) ? undefined : ctx.clientId ?? undefined), lpId: scope.lpId }),
  ]);
  const track = (k: string) => (l: LeadRow) => formatAnswer((l.tracking as Record<string, unknown>)[k]);
  return [
    { id: "created_at", header: "Created", value: (l) => formatDateTime(l.createdAt) },
    { id: "name", header: "Name", value: (l) => l.name ?? "" },
    { id: "phone", header: "Phone", value: (l) => l.phoneNormalised ?? "" },
    { id: "email", header: "Email", value: (l) => l.emailNormalised ?? "" },
    { id: "status", header: "Status", value: (l) => l.status?.name ?? "" },
    { id: "owner", header: "Owner", value: (l) => l.owner?.name ?? "" },
    ...(scope.lpId ? [] : [{ id: "lp", header: "Landing page", value: (l: LeadRow) => l.lp?.name ?? "" }]),
    ...(singleClient ? [] : [{ id: "client", header: "Client", value: (l: LeadRow) => l.client.name }]),
    { id: "source", header: "Source", value: (l) => SOURCE_LABEL[l.source] ?? l.source },
    ...answers.map<Column>((f) => ({
      id: `a:${f.key}`,
      header: f.label,
      value: (l) => {
        const answers = l.answers as Record<string, unknown>;
        return formatAnswer(f.keys.map((k) => answers[k]).find((v) => v !== undefined && v !== null && v !== "") ?? "");
      },
    })),
    { id: "score", header: "Score", value: (l) => (l.totalScore ?? "").toString() },
    ...tracking.map<Column>((k) => ({ id: `t:${k}`, header: trackingLabel(k), value: track(k) })),
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
