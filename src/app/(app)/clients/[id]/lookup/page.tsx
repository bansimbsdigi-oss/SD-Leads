import { FileSpreadsheet, KeyRound, Search, Table2 } from "lucide-react";
import { notFound } from "next/navigation";
import { rotateLookupTokenAction, saveLookupConfigAction } from "@/app/actions";
import { ActionForm } from "@/components/ActionForm";
import { ClientLogo } from "@/components/ClientLogo";
import { CopyBox } from "@/components/CopyBox";
import { LookupCheck, LookupSheets, ResendLookupButton } from "@/components/LeadLookupPanel";
import { Badge, Button, Card, Empty, Field, Input, PageHeader, Select, tableClass, type Tone } from "@/components/ui";
import { logoUrl } from "@/lib/branding";
import { getClient } from "@/lib/data";
import { formatDateTime } from "@/lib/leadColumns";
import { getLookupConfig, recentLookups, sheetStatus } from "@/lib/lookup";
import { LEAD_TYPE_LABEL, type LeadType } from "@/lib/lookupLabels";
import { listWebhookRules } from "@/lib/outbound/webhooks";
import { orNotFound, requireCtx } from "@/lib/session";
import { can, isSabhiStaff } from "@/lib/tenant";

const TYPE_TONE: Record<string, Tone> = { mentor: "green", sub_mentor: "violet", none: "slate" };
const STATUS: Record<string, { label: string; tone: Tone }> = {
  sent: { label: "Sent", tone: "green" },
  failed: { label: "Failed", tone: "red" },
  not_sent: { label: "Not sent", tone: "amber" },
  off: { label: "No webhook", tone: "slate" },
  with_lead: { label: "In lead webhook", tone: "blue" },
};
const SOURCE: Record<string, string> = { lead: "New lead", api: "API (Pabbly)", panel: "Checked by hand" };

export default async function LeadLookupPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireCtx();
  const client = await orNotFound(getClient(ctx, id));
  if (!can.editFields(ctx, client.id)) notFound();
  const canManage = can.manageLps(ctx, client.id);
  const [cfg, lookups, webhooks] = await Promise.all([
    getLookupConfig(ctx, client.id),
    recentLookups(ctx, client.id),
    canManage ? listWebhookRules(ctx, client.id) : Promise.resolve([]),
  ]);
  const sheets = sheetStatus(cfg).map((s) => ({ ...s, readAt: s.readAt?.toISOString() ?? null }));
  const apiUrl = cfg ? `${(process.env.INGEST_URL || process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "")}/api/lookup/${cfg.apiToken}` : null;

  return (
    <>
      <PageHeader
        crumbs={[...(isSabhiStaff(ctx) ? [{ label: "Clients", href: "/clients" }] : []), { label: client.name, href: `/clients/${client.id}` }, { label: "Lead lookup" }]}
        icon={<ClientLogo name={client.name} logo={logoUrl(client)} size="lg" />}
        title="Lead lookup"
        subtitle="Checks every new lead against the Mentor and Sub-mentor Google Sheets: Mentor's lead, Sub-mentor's lead, or None of the above."
      />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_400px]">
        <div className="min-w-0 space-y-6">
          <Card title={<span className="flex items-center gap-2"><FileSpreadsheet aria-hidden className="size-4 text-brand-700" /> Sheets</span>} description={cfg ? `Read live, at most every ${cfg.refreshMinutes} min. If Google can't be reached, the last good copy is used.` : "Not set up yet."}>
            <LookupSheets clientId={client.id} sheets={sheets} canManage={canManage} />
          </Card>

          <Card title={<span className="flex items-center gap-2"><Search aria-hidden className="size-4 text-brand-700" /> Check a lead</span>} description="Email or phone is enough. Email is tried first, then the last 10 digits of the phone.">
            {cfg ? <LookupCheck clientId={client.id} hasWebhook={Boolean(cfg.webhookId)} /> : <p className="text-sm text-ink-muted">Add the sheet links in the settings first.</p>}
          </Card>

          <Card flush title={<span className="flex items-center gap-2"><Table2 aria-hidden className="size-4 text-brand-700" /> Recent lookups</span>} description="The last 50, newest first.">
            {lookups.length === 0 ? (
              <Empty icon={<Table2 />} title="No lookups yet">New leads, API calls and hand checks show up here.</Empty>
            ) : (
              <div className="overflow-x-auto">
                <table className={tableClass}>
                  <thead><tr><th>When</th><th>Lead</th><th>Result</th><th>Mentor</th><th>Sub-mentor</th><th>From</th><th>Pabbly</th><th><span className="sr-only">Send</span></th></tr></thead>
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
                        <td>
                          <span title={l.webhookError ?? undefined}><Badge tone={STATUS[l.webhookStatus]?.tone ?? "slate"}>{STATUS[l.webhookStatus]?.label ?? l.webhookStatus}</Badge></span>
                        </td>
                        <td>{(l.webhookStatus === "failed" || l.webhookStatus === "not_sent") && cfg?.webhookId && <ResendLookupButton clientId={client.id} id={l.id} />}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>

        <div className="space-y-6">
          {canManage && (
            <Card title="Settings" description="Share each sheet as “Anyone with the link can view” (or publish to the web as CSV), then paste its link.">
              <ActionForm action={saveLookupConfigAction} className="space-y-4">
                <input type="hidden" name="clientId" value={client.id} />
                <Field label="Mentor sheet link" htmlFor="lk-mentor" hint="Needs Email and/or Phone, and Mentor Name.">
                  <Input id="lk-mentor" name="mentorSheetUrl" defaultValue={cfg?.mentorSheetUrl ?? ""} placeholder="https://docs.google.com/spreadsheets/d/…" />
                </Field>
                <Field label="Sub-mentor sheet link" htmlFor="lk-sub" hint="Needs Email and/or Phone, Sub Mentor Name, and optionally Mentor Name.">
                  <Input id="lk-sub" name="subMentorSheetUrl" defaultValue={cfg?.subMentorSheetUrl ?? ""} placeholder="https://docs.google.com/spreadsheets/d/…" />
                </Field>
                <Field label="Send API and hand-checked results to" htmlFor="lk-hook" hint="Results go there with event = lead_lookup. New leads already carry the result in their own webhooks.">
                  <Select id="lk-hook" name="webhookId" defaultValue={cfg?.webhookId ?? ""}>
                    <option value="">Don&apos;t send</option>
                    {webhooks.map((w) => <option key={w.id} value={w.id}>{w.name}{w.status === "paused" ? " (paused)" : ""}</option>)}
                  </Select>
                </Field>
                <div className="grid grid-cols-2 gap-4">
                  <Field label="Re-read every (min)" htmlFor="lk-refresh">
                    <Input id="lk-refresh" name="refreshMinutes" type="number" min={1} max={60} defaultValue={cfg?.refreshMinutes ?? 2} />
                  </Field>
                  <label className="flex items-end gap-2 pb-2 text-sm">
                    <input type="checkbox" name="enabled" defaultChecked={cfg?.enabled ?? true} className="size-4" /> Check new leads
                  </label>
                </div>
                <Button type="submit" className="w-full">Save and read sheets</Button>
              </ActionForm>
            </Card>
          )}

          {apiUrl && (
            <Card title={<span className="flex items-center gap-2"><KeyRound aria-hidden className="size-4 text-brand-700" /> Lookup API for Pabbly</span>} description="For leads that don't come through SD-Leads.">
              <CopyBox value={apiUrl} />
              <ol className="mt-3 list-decimal space-y-1 pl-5 text-xs text-ink-muted">
                <li>In Pabbly, after the lead trigger add <strong className="text-ink">API (Make a request)</strong> → <strong className="text-ink">POST</strong> → this URL.</li>
                <li>JSON body: <code className="font-mono">name</code>, <code className="font-mono">email</code>, <code className="font-mono">phone</code> (mobile, whatsapp, full_name also work).</li>
                <li>The answer has <code className="font-mono">lead_type</code> (mentor, sub_mentor, none), <code className="font-mono">mentor_name</code>, <code className="font-mono">sub_mentor_name</code>: route on <code className="font-mono">lead_type</code>.</li>
              </ol>
              <p className="mt-3 text-xs text-ink-muted">Keep it private. Wrong URL → 401; no email and no phone → 422.</p>
              {canManage && (
                <form action={rotateLookupTokenAction.bind(null, client.id)} className="mt-3">
                  <Button type="submit" variant="ghost" size="sm">New secret URL (the old one stops working)</Button>
                </form>
              )}
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
