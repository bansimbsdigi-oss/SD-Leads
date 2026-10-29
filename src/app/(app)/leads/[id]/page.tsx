import { CheckCircle2, Copy, FileInput, MousePointerClick, UserRound, XCircle } from "lucide-react";
import Link from "next/link";
import { DeleteLeadButton } from "@/components/LeadDelete";
import { Avatar, Badge, Card, PageHeader, Stat, StatusBadge } from "@/components/ui";
import { getLead, listFields } from "@/lib/data";
import { formatAnswer, formatDateTime } from "@/lib/leadColumns";
import { orNotFound, requireCtx } from "@/lib/session";
import { can, isSabhiStaff } from "@/lib/tenant";

const SOURCE_LABEL: Record<string, string> = { lp: "LP snippet", webhook: "Webhook", meta_instant_form: "Meta form" };

const EVENT_LABEL: Record<string, { label: string; icon: typeof FileInput }> = {
  created: { label: "Lead received", icon: FileInput },
  duplicate_of: { label: "Marked as duplicate", icon: Copy },
  status_changed: { label: "Status changed", icon: MousePointerClick },
  assigned: { label: "Assigned", icon: UserRound },
};

export default async function LeadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireCtx();
  const lead = await orNotFound(getLead(ctx, id));
  const fields = lead.lpId ? await listFields(ctx, lead.lpId) : [];
  const answers = lead.answers as Record<string, unknown>;
  const scores = lead.scores as Record<string, number>;
  const known = new Set(fields.map((f) => f.fieldKey));
  const rows = [
    ...fields.filter((f) => f.fieldKey in answers).map((f) => ({ key: f.fieldKey, label: f.displayName, value: answers[f.fieldKey] })),
    ...Object.keys(answers).filter((k) => !known.has(k)).map((k) => ({ key: k, label: k, value: answers[k] })),
  ];
  const tracking = Object.entries(lead.tracking as Record<string, string>);
  const consent = lead.consent as { given?: boolean; text?: string; at?: string };
  const name = lead.name || "(no name)";

  return (
    <>
      <PageHeader
        crumbs={[
          { label: "Leads", href: isSabhiStaff(ctx) ? `/leads?client=${lead.client.id}` : "/leads" },
          ...(isSabhiStaff(ctx) ? [{ label: lead.client.name, href: `/clients/${lead.client.id}` }] : []),
          { label: name },
        ]}
        icon={<Avatar name={name} size="lg" />}
        title={<span className="flex items-center gap-2">{name} {lead.isDuplicate && <Badge tone="amber">Duplicate</Badge>}</span>}
        subtitle={[lead.phoneNormalised, lead.emailNormalised].filter(Boolean).join(" · ") || "No contact details"}
        actions={can.deleteLeads(ctx, lead.clientId) && <DeleteLeadButton id={lead.id} name={lead.name ?? ""} />}
      />

      <Card className="mb-6">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-4 md:grid-cols-5">
          <Stat label="Status"><StatusBadge name={lead.status?.name} /></Stat>
          <Stat label="Landing page">
            {lead.lp ? <Link href={`/lps/${lead.lp.id}`} className="text-brand-700 hover:underline">{lead.lp.name}</Link> : "—"}
          </Stat>
          <Stat label="Received">{formatDateTime(lead.createdAt)}</Stat>
          <Stat label="Source">{SOURCE_LABEL[lead.source] ?? lead.source}</Stat>
          <Stat label="Owner">{lead.owner?.name ?? <span className="text-ink-muted">Unassigned</span>}</Stat>
        </dl>
      </Card>

      <div className="grid gap-6 xl:grid-cols-[1fr_380px]">
        <div className="min-w-0 space-y-6">
          <Card flush title="Answers" description={`${rows.length} field${rows.length === 1 ? "" : "s"} from the form`}>
            <dl className="divide-y divide-slate-100">
              {rows.map((r) => (
                <div key={r.key} className="grid gap-1 px-5 py-3 sm:grid-cols-[minmax(160px,1fr)_2fr] sm:gap-4">
                  <dt className="text-sm text-ink-muted">{r.label}</dt>
                  <dd className="whitespace-pre-wrap break-words text-sm text-ink">
                    {formatAnswer(r.value) || <span className="text-slate-300">—</span>}
                    {r.key in scores && <span className="ml-2 align-middle"><Badge tone="violet">{scores[r.key]} pts</Badge></span>}
                  </dd>
                </div>
              ))}
              {lead.totalScore !== null && (
                <div className="grid gap-1 bg-slate-50 px-5 py-3 sm:grid-cols-[minmax(160px,1fr)_2fr] sm:gap-4">
                  <dt className="text-sm font-semibold">Total quiz score</dt>
                  <dd className="text-sm font-semibold">{lead.totalScore}</dd>
                </div>
              )}
            </dl>
          </Card>

          <Card title="Tracking" description="Where the lead came from">
            {tracking.length === 0 ? (
              <p className="text-sm text-ink-muted">No tracking data was sent with this lead.</p>
            ) : (
              <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[160px_1fr]">
                {tracking.map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="font-mono text-xs text-ink-muted sm:pt-0.5">{k}</dt>
                    <dd className="mb-2 break-all sm:mb-0">{v}</dd>
                  </div>
                ))}
              </dl>
            )}
            {consent.given !== undefined && (
              <p className="mt-4 flex items-start gap-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-ink-muted">
                {consent.given
                  ? <CheckCircle2 aria-hidden className="mt-0.5 size-4 shrink-0 text-emerald-600" />
                  : <XCircle aria-hidden className="mt-0.5 size-4 shrink-0 text-red-500" />}
                <span>
                  Consent {consent.given ? "given" : "not given"}
                  {consent.text ? ` — “${consent.text}”` : ""}
                  {consent.at ? ` · ${formatDateTime(new Date(consent.at))}` : ""}
                </span>
              </p>
            )}
          </Card>
        </div>

        <Card title="Timeline" className="self-start">
          <ol className="relative space-y-5 before:absolute before:bottom-2 before:left-[13px] before:top-2 before:w-px before:bg-line">
            {lead.events.map((e) => {
              const meta = EVENT_LABEL[e.type] ?? { label: e.type.replace(/_/g, " "), icon: FileInput };
              const Icon = meta.icon;
              return (
                <li key={e.id} className="relative flex gap-3">
                  <span className="relative z-10 flex size-7 shrink-0 items-center justify-center rounded-full border border-line bg-surface text-ink-muted">
                    <Icon aria-hidden className="size-3.5" />
                  </span>
                  <div className="min-w-0 pt-0.5">
                    <p className="text-sm font-medium">{meta.label}</p>
                    {e.type === "duplicate_of" && (
                      <Link className="text-xs text-brand-700 hover:underline" href={`/leads/${(e.payload as { leadId: string }).leadId}`}>View original lead</Link>
                    )}
                    <p className="text-xs text-ink-muted">{formatDateTime(e.createdAt)}{e.actor ? ` · ${e.actor.name}` : ""}</p>
                  </div>
                </li>
              );
            })}
          </ol>
        </Card>
      </div>
    </>
  );
}
