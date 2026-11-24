import { ArrowDownToLine, ArrowUpFromLine, FileSpreadsheet, History, Search, Send, Table2, Users } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { rotateLookupTokenAction, saveLookupConfigAction, sendLookupTestAction } from "@/app/actions";
import { ActionForm } from "@/components/ActionForm";
import { CopyBox } from "@/components/CopyBox";
import { LookupCheck, LookupDirectory, LookupSheets, ResendLookupButton } from "@/components/LeadLookupPanel";
import { Badge, Button, buttonClass, Card, Empty, Field, Input, PageHeader, Select, tableClass, type Tone } from "@/components/ui";
import { formatDateTime } from "@/lib/leadColumns";
import { directoryOf, getLookupSetup, LOG_FILTERS, recentLookups, sheetStatus, webhookHistory, type LogFilter } from "@/lib/lookup";
import { LEAD_TYPE_LABEL, type LeadType } from "@/lib/lookupLabels";
import { requireCtx } from "@/lib/session";

const TYPE_TONE: Record<string, Tone> = { mentor: "green", sub_mentor: "violet", none: "slate" };
const STATUS: Record<string, { label: string; tone: Tone }> = {
  sent: { label: "Sent", tone: "green" },
  failed: { label: "Failed", tone: "red" },
  not_sent: { label: "Not sent", tone: "amber" },
  off: { label: "No webhook", tone: "slate" },
};
const SOURCE: Record<string, string> = { webhook: "Webhook", panel: "Checked by hand", lead: "New SD-Leads lead" };

const LOG_TAB: Record<LogFilter, string> = { all: "All", received: "Received", rejected: "Rejected", sent: "Sent", failed: "Failed" };
const LOG_STATUS: Record<string, { label: string; tone: Tone; dir: string }> = {
  received: { label: "Received", tone: "blue", dir: "From Pabbly → lookup webhook" },
  rejected: { label: "Rejected", tone: "amber", dir: "From Pabbly → lookup webhook" },
  sent: { label: "Sent", tone: "green", dir: "To your webhook" },
  failed: { label: "Failed", tone: "red", dir: "To your webhook" },
};

/** A one-line summary of a logged body: who, and what result. */
function logSummary(body: unknown) {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const pick = (...k: string[]) => k.map((x) => b[x]).find((v) => (typeof v === "string" && v.trim()) || typeof v === "number");
  return [pick("name", "full_name", "Name"), pick("email", "Email"), pick("phone", "mobile", "Phone", "phone_number", "whatsapp")].filter(Boolean).join(" · ") || null;
}

type SP = Promise<Record<string, string | string[] | undefined>>;

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
  "mentor_name": "Anupa",
  "mentor_team": "A",
  "mentor_phone": "0000000000",
  "mentor_email": "",
  "sub_mentor_name": "Sudeshna Chatterjee",
  "sub_mentor_phone": "98000 00000",
  "sub_mentor_email": "mentor.sudeshna@example.com",
  "matched_by": "phone",
  "checked_at": "2026-11-23T17:31:11+05:30",
  "type": "…whatever you sent in type"
}`;

export default async function LeadLookupPage({ searchParams }: { searchParams: SP }) {
  const ctx = await requireCtx();
  if (ctx.role !== "SUPER_ADMIN") notFound();
  const sp = await searchParams;
  const logFilter = (LOG_FILTERS as readonly string[]).includes(String(sp.log)) ? (sp.log as LogFilter) : "all";
  const logPage = Math.max(1, Number(sp.logPage) || 1);
  const [{ cfg, outboundUrl }, lookups, history] = await Promise.all([getLookupSetup(ctx), recentLookups(ctx), webhookHistory(ctx, logFilter, logPage)]);
  const logHref = (f: LogFilter, p = 1) => `/lookup?log=${f}${p > 1 ? `&logPage=${p}` : ""}#history`;
  const sheets = sheetStatus(cfg);
  const inboundUrl = `${(process.env.INGEST_URL || process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "")}/api/lookup/${cfg.apiToken}`;

  return (
    <>
      <PageHeader
        title="Lead lookup"
        subtitle="Every lead sent to the webhook below is checked automatically: Mentor sheet first (found → Mentor's lead, sent right away), then the Sub-mentor sheet, otherwise None of the above. The result goes to your webhook."
      />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_420px]">
        <div className="min-w-0 space-y-6">
          <Card title={<span className="flex items-center gap-2"><ArrowDownToLine aria-hidden className="size-4 text-brand-700" /> 1. Your lookup webhook (send leads here)</span>} description="POST name, email and phone as JSON or form fields. Email or phone is enough.">
            <CopyBox value={inboundUrl} />
            <ul className="mt-3 space-y-1 text-xs text-ink-muted">
              <li>In Pabbly: <strong className="text-ink">API (Make a request)</strong> → <strong className="text-ink">POST</strong> → this URL → body <code className="font-mono">{`{ "name": …, "email": …, "phone": … }`}</code>. Also accepted: full_name, mobile, phone_number, whatsapp.</li>
              <li>Any other field you send (e.g. <code className="font-mono">type</code>) is passed on to your webhook unchanged, next to the result.</li>
              <li>The reply has the result straight away, so the same Pabbly step can use it too.</li>
              <li>Wrong URL → 401. No email and no phone → 422. Keep the URL private.</li>
            </ul>
            <form action={rotateLookupTokenAction} className="mt-3">
              <Button type="submit" variant="ghost" size="sm">Make a new URL (the old one stops working)</Button>
            </form>
          </Card>

          <Card title={<span className="flex items-center gap-2"><FileSpreadsheet aria-hidden className="size-4 text-brand-700" /> 2. Sheets</span>} description="Add each Google Sheet to its list, e.g. two Mentor sheets and one Sub-mentor sheet. All sheets of a list are searched together, and they are re-read automatically, so changes in Google Sheets are picked up within a few minutes.">
            <LookupSheets sheets={sheets} />
          </Card>

          <Card title={<span className="flex items-center gap-2"><Users aria-hidden className="size-4 text-brand-700" /> Teams and sub-mentors</span>} description="Who each team letter is, and each sub-mentor's team. Their phone and email are sent with every result (mentor_phone, mentor_email, sub_mentor_phone, sub_mentor_email). Sub-mentors are matched to the Sub-mentor sheet by name.">
            <LookupDirectory initial={directoryOf(cfg)} />
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

          <Card flush title={<span id="history" className="flex scroll-mt-20 items-center gap-2"><History aria-hidden className="size-4 text-brand-700" /> Webhook history</span>} description="Everything received on your lookup webhook and everything sent to your webhook (including failures and tests). Kept for 30 days. Click a row to see the data.">
            <div className="flex flex-wrap gap-1.5 border-b border-line px-4 py-3">
              {LOG_FILTERS.map((f) => (
                <Link key={f} href={logHref(f)} scroll={false} className={`rounded-full px-3 py-1 text-xs font-medium ring-1 ring-inset ${f === logFilter ? "bg-brand-700 text-white ring-brand-700" : "text-ink-muted ring-line hover:bg-slate-100"}`}>
                  {LOG_TAB[f]} <span className="tabular-nums opacity-75">{(history.counts[f] ?? 0).toLocaleString("en-IN")}</span>
                </Link>
              ))}
            </div>
            {history.rows.length === 0 ? (
              <Empty icon={<History />} title="Nothing here yet">Requests from Pabbly and results sent to your webhook will show up here.</Empty>
            ) : (
              <ul className="divide-y divide-line">
                {history.rows.map((h) => {
                  const st = LOG_STATUS[h.status] ?? { label: h.status, tone: "slate" as Tone, dir: "" };
                  const summary = logSummary(h.body);
                  return (
                    <li key={h.id}>
                      <details className="group">
                        <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm hover:bg-slate-50">
                          <span className="w-36 shrink-0 whitespace-nowrap text-xs text-ink-muted">{formatDateTime(h.createdAt)}</span>
                          <Badge tone={st.tone}>{st.label}</Badge>
                          {h.test && <Badge tone="violet">Test</Badge>}
                          <span className="text-xs text-ink-muted">{st.dir}{h.attempt && h.attempt > 1 ? ` · try ${h.attempt}` : ""}</span>
                          <span className="min-w-0 flex-1 truncate">{summary ?? <span className="text-ink-muted">{h.error ?? "—"}</span>}</span>
                          {h.httpStatus !== null && <span className={`font-mono text-xs ${h.httpStatus >= 200 && h.httpStatus < 300 ? "text-emerald-700" : "text-red-700"}`}>HTTP {h.httpStatus}</span>}
                        </summary>
                        <div className="space-y-2 bg-slate-50 px-4 pb-4 pt-1 text-xs">
                          {h.error && <p className="text-red-700"><strong>Problem:</strong> {h.error}</p>}
                          {h.durationMs !== null && <p className="text-ink-muted">Took {h.durationMs} ms</p>}
                          <div className="grid gap-2 lg:grid-cols-2">
                            <div>
                              <p className="mb-1 font-medium">{h.direction === "in" ? "Data received" : "Data sent"}</p>
                              <pre className="max-h-72 overflow-auto rounded-lg bg-slate-900 p-3 font-mono text-[11px] leading-relaxed text-[#cfe3f5]">{h.body ? JSON.stringify(h.body, null, 2) : "(not kept)"}</pre>
                            </div>
                            <div>
                              <p className="mb-1 font-medium">{h.direction === "in" ? "Result" : "Your webhook answered"}</p>
                              <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-slate-900 p-3 font-mono text-[11px] leading-relaxed text-[#cfe3f5]">{h.response ?? (h.direction === "out" && !h.httpStatus ? "(no answer)" : "—")}</pre>
                            </div>
                          </div>
                        </div>
                      </details>
                    </li>
                  );
                })}
              </ul>
            )}
            {history.pages > 1 && (
              <div className="flex items-center justify-between gap-2 border-t border-line px-4 py-3 text-xs text-ink-muted">
                <span>Page {logPage} of {history.pages} · {history.total.toLocaleString("en-IN")} entries</span>
                <span className="flex gap-2">
                  {logPage > 1 && <Link href={logHref(logFilter, logPage - 1)} scroll={false} className={buttonClass("secondary", "sm")}>Newer</Link>}
                  {logPage < history.pages && <Link href={logHref(logFilter, logPage + 1)} scroll={false} className={buttonClass("secondary", "sm")}>Older</Link>}
                </span>
              </div>
            )}
          </Card>
        </div>

        <div className="space-y-6">
          <Card title="Settings">
            <ActionForm action={saveLookupConfigAction} className="space-y-4">
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
              <label className="flex items-start gap-2 rounded-lg bg-slate-50 p-3 text-sm ring-1 ring-inset ring-line">
                <input type="checkbox" name="autoCheckLeads" defaultChecked={cfg.autoCheckLeads} className="mt-0.5 size-4" />
                <span>
                  <span className="font-medium">Also check every new lead that comes into SD-Leads</span>
                  <span className="block text-xs text-ink-muted">Leads from all clients&apos; landing pages and webhooks are looked up and sent to your webhook automatically, with no Pabbly step.</span>
                </span>
              </label>
              <Button type="submit" className="w-full">Save settings</Button>
            </ActionForm>
          </Card>

          <Card title={<span className="flex items-center gap-2"><Send aria-hidden className="size-4 text-brand-700" /> Send a test</span>} description="Sends a sample result to your saved webhook now, with “test”: true, so you can map the fields in Pabbly. It shows up in the webhook history.">
            <ActionForm action={sendLookupTestAction} className="space-y-3">
              <p className="truncate rounded-lg bg-slate-50 px-3 py-2 text-xs ring-1 ring-inset ring-line" title={outboundUrl ?? undefined}>
                <span className="text-ink-muted">Sends to: </span>
                {outboundUrl ? <span className="font-mono">{outboundUrl.replace(/^https?:\/\//, "").slice(0, 48)}…</span> : <span className="text-red-700">no webhook saved yet. Add it in Settings above.</span>}
              </p>
              <Field label="Result to send" htmlFor="lk-test-type">
                <Select id="lk-test-type" name="leadType" defaultValue="mentor" className="w-full">
                  <option value="mentor">Mentor&apos;s lead</option>
                  <option value="sub_mentor">Sub-mentor&apos;s lead</option>
                  <option value="none">None of the above</option>
                </Select>
              </Field>
              <Button type="submit" variant="secondary" className="w-full" disabled={!outboundUrl}><Send aria-hidden /> Send test</Button>
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
