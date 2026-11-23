import { ArrowDownToLine, ArrowUpFromLine, FileSpreadsheet, Search, Table2 } from "lucide-react";
import { notFound } from "next/navigation";
import { rotateLookupTokenAction, saveLookupConfigAction } from "@/app/actions";
import { ActionForm } from "@/components/ActionForm";
import { CopyBox } from "@/components/CopyBox";
import { LookupCheck, LookupSheets, ResendLookupButton } from "@/components/LeadLookupPanel";
import { Badge, Button, Card, Empty, Field, Input, PageHeader, tableClass, type Tone } from "@/components/ui";
import { formatDateTime } from "@/lib/leadColumns";
import { getLookupSetup, recentLookups, sheetStatus } from "@/lib/lookup";
import { LEAD_TYPE_LABEL, type LeadType } from "@/lib/lookupLabels";
import { requireCtx } from "@/lib/session";

const TYPE_TONE: Record<string, Tone> = { mentor: "green", sub_mentor: "violet", none: "slate" };
const STATUS: Record<string, { label: string; tone: Tone }> = {
  sent: { label: "Sent", tone: "green" },
  failed: { label: "Failed", tone: "red" },
  not_sent: { label: "Not sent", tone: "amber" },
  off: { label: "No webhook", tone: "slate" },
};
const SOURCE: Record<string, string> = { webhook: "Webhook", panel: "Checked by hand" };

const SAMPLE = `{
  "event": "lead_lookup",
  "lead_type": "sub_mentor",
  "lead_type_label": "Sub-mentor's lead",
  "is_mentor_lead": false,
  "is_sub_mentor_lead": true,
  "is_none_of_above": false,
  "name": "Sameer Khan",
  "email": "sameer@example.com",
  "phone": "+91-7000000002",
  "mentor_name": "Anil Kapoor",
  "sub_mentor_name": "Vikram Singh",
  "matched_by": "phone",
  "checked_at": "2026-11-23T17:31:11+05:30"
}`;

export default async function LeadLookupPage() {
  const ctx = await requireCtx();
  if (ctx.role !== "SUPER_ADMIN") notFound();
  const [{ cfg, outboundUrl }, lookups] = await Promise.all([getLookupSetup(ctx), recentLookups(ctx)]);
  const sheets = sheetStatus(cfg).map((s) => ({ ...s, readAt: s.readAt?.toISOString() ?? null }));
  const inboundUrl = `${(process.env.INGEST_URL || process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "")}/api/lookup/${cfg.apiToken}`;

  return (
    <>
      <PageHeader
        title="Lead lookup"
        subtitle="Send a lead to your webhook below. It's checked against the Mentor and Sub-mentor sheets, and the result (Mentor's lead, Sub-mentor's lead or None of the above) is sent to your webhook."
      />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_420px]">
        <div className="min-w-0 space-y-6">
          <Card title={<span className="flex items-center gap-2"><ArrowDownToLine aria-hidden className="size-4 text-brand-700" /> 1. Your lookup webhook (send leads here)</span>} description="POST name, email and phone as JSON or form fields. Email or phone is enough.">
            <CopyBox value={inboundUrl} />
            <ul className="mt-3 space-y-1 text-xs text-ink-muted">
              <li>In Pabbly: <strong className="text-ink">API (Make a request)</strong> → <strong className="text-ink">POST</strong> → this URL → body <code className="font-mono">{`{ "name": …, "email": …, "phone": … }`}</code>. Also accepted: full_name, mobile, phone_number, whatsapp.</li>
              <li>The reply has the result straight away, so the same Pabbly step can use it too.</li>
              <li>Wrong URL → 401. No email and no phone → 422. Keep the URL private.</li>
            </ul>
            <form action={rotateLookupTokenAction} className="mt-3">
              <Button type="submit" variant="ghost" size="sm">Make a new URL (the old one stops working)</Button>
            </form>
          </Card>

          <Card title={<span className="flex items-center gap-2"><FileSpreadsheet aria-hidden className="size-4 text-brand-700" /> 2. Sheets</span>} description={`Read live, at most every ${cfg.refreshMinutes} min. If Google can't be reached, the last good copy is used.`}>
            <LookupSheets sheets={sheets} />
          </Card>

          <Card title={<span className="flex items-center gap-2"><Search aria-hidden className="size-4 text-brand-700" /> Check a lead</span>} description="Email is tried first, then the last 10 digits of the phone. Mentor sheet first.">
            <LookupCheck hasOutbound={Boolean(outboundUrl)} />
          </Card>

          <Card flush title={<span className="flex items-center gap-2"><Table2 aria-hidden className="size-4 text-brand-700" /> Recent lookups</span>} description="The last 50, newest first.">
            {lookups.length === 0 ? (
              <Empty icon={<Table2 />} title="No lookups yet">Leads sent to your webhook and hand checks show up here.</Empty>
            ) : (
              <div className="overflow-x-auto">
                <table className={tableClass}>
                  <thead><tr><th>When</th><th>Lead</th><th>Result</th><th>Mentor</th><th>Sub-mentor</th><th>From</th><th>Your webhook</th><th><span className="sr-only">Send</span></th></tr></thead>
                  <tbody>
                    {lookups.map((l) => (
                      <tr key={l.id}>
                        <td className="whitespace-nowrap text-xs text-ink-muted">{formatDateTime(l.createdAt)}</td>
                        <td className="max-w-56">
                          <span className="block truncate font-medium">{l.name || "(no name)"}</span>
                          <span className="block truncate text-xs text-ink-muted">{[l.email, l.phone].filter(Boolean).join(" · ")}</span>
                        </td>
                        <td><Badge tone={TYPE_TONE[l.leadType] ?? "slate"}>{LEAD_TYPE_LABEL[l.leadType as LeadType] ?? l.leadType}</Badge></td>
                        <td className="whitespace-nowrap">{l.mentorName || <span className="text-slate-300">—</span>}</td>
                        <td className="whitespace-nowrap">{l.subMentorName || <span className="text-slate-300">—</span>}</td>
                        <td className="whitespace-nowrap text-xs text-ink-muted">{SOURCE[l.source] ?? l.source}</td>
                        <td><span title={l.webhookError ?? undefined}><Badge tone={STATUS[l.webhookStatus]?.tone ?? "slate"}>{STATUS[l.webhookStatus]?.label ?? l.webhookStatus}</Badge></span></td>
                        <td>{(l.webhookStatus === "failed" || l.webhookStatus === "not_sent") && outboundUrl && <ResendLookupButton id={l.id} />}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>

        <div className="space-y-6">
          <Card title="Settings" description="Share each sheet as “Anyone with the link can view” (or publish to the web as CSV), then paste its link.">
            <ActionForm action={saveLookupConfigAction} className="space-y-4">
              <Field label="Mentor sheet link" htmlFor="lk-mentor" hint="Needs Email and/or Phone, and Mentor Name.">
                <Input id="lk-mentor" name="mentorSheetUrl" defaultValue={cfg.mentorSheetUrl ?? ""} placeholder="https://docs.google.com/spreadsheets/d/…" />
              </Field>
              <Field label="Sub-mentor sheet link" htmlFor="lk-sub" hint="Needs Email and/or Phone, Sub Mentor Name, and optionally Mentor Name.">
                <Input id="lk-sub" name="subMentorSheetUrl" defaultValue={cfg.subMentorSheetUrl ?? ""} placeholder="https://docs.google.com/spreadsheets/d/…" />
              </Field>
              <Field label="3. Your webhook (results are sent here)" htmlFor="lk-out" hint="E.g. your Pabbly webhook URL. Every lookup from the webhook above is sent here with event = lead_lookup.">
                <Input id="lk-out" name="outboundUrl" defaultValue={outboundUrl ?? ""} placeholder="https://connect.pabbly.com/workflow/sendwebhookdata/…" />
              </Field>
              <div className="grid grid-cols-2 gap-4">
                <Field label="Re-read sheets every (min)" htmlFor="lk-refresh">
                  <Input id="lk-refresh" name="refreshMinutes" type="number" min={1} max={60} defaultValue={cfg.refreshMinutes} />
                </Field>
                <label className="flex items-end gap-2 pb-2 text-sm">
                  <input type="checkbox" name="enabled" defaultChecked={cfg.enabled} className="size-4" /> Lookup on
                </label>
              </div>
              <Button type="submit" className="w-full">Save and read sheets</Button>
            </ActionForm>
          </Card>

          <Card title={<span className="flex items-center gap-2"><ArrowUpFromLine aria-hidden className="size-4 text-brand-700" /> What your webhook receives</span>} description="Same fields every time. In Pabbly, route on lead_type: mentor, sub_mentor or none.">
            <pre className="overflow-x-auto rounded-lg bg-slate-900 p-3 font-mono text-[11px] leading-relaxed text-[#cfe3f5]">{SAMPLE}</pre>
          </Card>
        </div>
      </div>
    </>
  );
}
