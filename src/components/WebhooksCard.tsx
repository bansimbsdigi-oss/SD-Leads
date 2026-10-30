import { Pause, Play, RotateCw, Send } from "lucide-react";
import Link from "next/link";
import { deleteWebhookAction, retryDeliveryAction, toggleWebhookAction } from "@/app/actions";
import { Badge, Button, Card, Empty, tableClass } from "@/components/ui";
import { DeleteWebhookButton, TestWebhookButton, WebhookDialog } from "@/components/WebhookDialog";
import { formatDateTime } from "@/lib/leadColumns";
import { describeCondition, type FieldMeta } from "@/lib/leadFilterSpec";
import { maskUrl, type listWebhookRules } from "@/lib/outbound/webhooks";

type Rules = Awaited<ReturnType<typeof listWebhookRules>>;

export function WebhooksCard({ clientId, rules, fields }: { clientId: string; rules: Rules; fields: FieldMeta[] }) {
  const byId = new Map(fields.map((f) => [f.id, f]));
  return (
    <Card
      flush
      title={<span className="flex items-center gap-2"><Send aria-hidden className="size-4 text-brand-700" /> Send leads to Pabbly / webhooks</span>}
      description="Forward new leads that match your conditions to Pabbly, Zapier or any webhook URL."
      actions={<WebhookDialog clientId={clientId} fields={fields} />}
    >
      {rules.length === 0 ? (
        <Empty icon={<Send />} title="No webhooks yet">
          In Pabbly, create a workflow with the Webhook trigger, copy its URL, then click “Add webhook”.
        </Empty>
      ) : (
        <ul className="divide-y divide-line">
          {rules.map((r) => {
            const last = r.deliveries[0];
            const failed24 = r.deliveries.filter((d) => d.status === "failed" && Date.now() - d.createdAt.getTime() < 86_400_000).length;
            return (
              <li key={r.id} className="space-y-3 px-5 py-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 font-medium">
                      {r.name}
                      <Badge tone={r.status === "active" ? "green" : "amber"} dot>{r.status === "active" ? "On" : "Paused"}</Badge>
                      {failed24 > 0 && <Badge tone="red">{failed24} failed today</Badge>}
                    </p>
                    <p className="mt-0.5 truncate font-mono text-xs text-ink-muted" title="URL hidden for safety; open Edit to see it">{maskUrl(r.url)}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <TestWebhookButton id={r.id} />
                    <WebhookDialog clientId={clientId} fields={fields} rule={{ id: r.id, name: r.name, url: r.url, conditions: r.conditions }} />
                    <form action={toggleWebhookAction}>
                      <input type="hidden" name="id" value={r.id} />
                      <input type="hidden" name="clientId" value={clientId} />
                      <input type="hidden" name="status" value={r.status === "active" ? "paused" : "active"} />
                      <Button variant="secondary" size="sm" title={r.status === "active" ? "Stop sending" : "Start sending"}>
                        {r.status === "active" ? <><Pause aria-hidden /> Pause</> : <><Play aria-hidden /> Resume</>}
                      </Button>
                    </form>
                    <DeleteWebhookButton id={r.id} clientId={clientId} name={r.name} action={deleteWebhookAction} />
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-1.5 text-xs">
                  <span className="text-ink-muted">Sends:</span>
                  {r.conditions.length === 0 ? (
                    <Badge>Every new lead</Badge>
                  ) : (
                    r.conditions.map((c, i) => {
                      const d = describeCondition(c, byId.get(c.field));
                      return <Badge key={i} tone="blue">{d.field} {d.op} {d.value}</Badge>;
                    })
                  )}
                </div>

                <details className="group rounded-lg border border-line">
                  <summary className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs text-ink-muted">
                    <span className="font-medium text-ink">Delivery log</span>
                    {last ? (
                      <span>
                        · last {last.status === "sent" ? "sent" : "failed"} {formatDateTime(last.createdAt)}
                        {last.responseCode ? ` (HTTP ${last.responseCode})` : ""}
                      </span>
                    ) : (
                      <span>· nothing sent yet</span>
                    )}
                  </summary>
                  {r.deliveries.length > 0 && (
                    <div className="max-h-72 overflow-auto border-t border-line">
                      <table className={tableClass}>
                        <thead><tr><th>When</th><th>Lead</th><th>Result</th><th>Attempt</th><th>Time</th><th /></tr></thead>
                        <tbody>
                          {r.deliveries.map((d) => (
                            <tr key={d.id}>
                              <td className="whitespace-nowrap text-xs text-ink-muted">{formatDateTime(d.createdAt)}</td>
                              <td className="max-w-40 truncate"><Link href={`/leads/${d.lead.id}`} className="hover:text-brand-700 hover:underline">{d.lead.name || "(no name)"}</Link></td>
                              <td>
                                {d.status === "sent" ? (
                                  <Badge tone="green">Sent{d.responseCode ? ` · ${d.responseCode}` : ""}</Badge>
                                ) : (
                                  <span title={d.error ?? undefined}><Badge tone="red">Failed{d.responseCode ? ` · ${d.responseCode}` : ""}</Badge></span>
                                )}
                                {d.status !== "sent" && d.error && <span className="ml-2 text-xs text-ink-muted">{d.error}</span>}
                              </td>
                              <td className="text-xs">{d.attempt}</td>
                              <td className="whitespace-nowrap text-xs text-ink-muted">{d.durationMs != null ? `${d.durationMs} ms` : "—"}</td>
                              <td>
                                {d.status !== "sent" && (
                                  <form action={retryDeliveryAction}>
                                    <input type="hidden" name="id" value={d.id} />
                                    <input type="hidden" name="clientId" value={clientId} />
                                    <button type="submit" title="Send again" className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-xs text-brand-700 hover:bg-brand-50">
                                      <RotateCw aria-hidden className="size-3.5" /> Retry
                                    </button>
                                  </form>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </details>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
