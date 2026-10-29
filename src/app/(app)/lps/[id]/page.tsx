import { ArrowRight, Code2, ListTree, Pause, Play } from "lucide-react";
import Link from "next/link";
import { toggleLpStatusAction, updateFieldAction, updateLpAction } from "@/app/actions";
import { ActionForm } from "@/components/ActionForm";
import { CopyBox } from "@/components/CopyBox";
import { Badge, Button, buttonClass, Card, Empty, Hint, Input, Label, PageHeader, tableClass } from "@/components/ui";
import { prisma } from "@/lib/db";
import { getLp, listFields } from "@/lib/data";
import { orNotFound, requireCtx } from "@/lib/session";
import { can, isSabhiStaff } from "@/lib/tenant";

const ingestBase = () => (process.env.INGEST_URL || process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "");

function exampleForm() {
  return `<form data-lead-form data-redirect="/thank-you">
  <label for="name">Your name</label>
  <input id="name" name="name" data-role="name" required>

  <label for="phone">Mobile</label>
  <input id="phone" name="phone" type="tel" data-role="phone" required>

  <fieldset>
    <legend>How often do you post?</legend>
    <label><input type="radio" name="q1" value="never" data-score="0"> Never</label>
    <label><input type="radio" name="q1" value="weekly" data-score="2"> Weekly</label>
    <label><input type="radio" name="q1" value="daily" data-score="3"> Daily</label>
  </fieldset>

  <label><input type="checkbox" name="consent" data-consent required> I agree to be contacted</label>
  <button type="submit">Register</button>
</form>`;
}

export default async function LpPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireCtx();
  const lp = await orNotFound(getLp(ctx, id));
  const [fields, versions] = await Promise.all([
    listFields(ctx, lp.id),
    prisma.formVersion.findMany({ where: { lpId: lp.id }, orderBy: { createdAt: "desc" }, include: { _count: { select: { leads: true } } } }),
  ]);
  const manage = can.manageLps(ctx, lp.clientId);
  const editFields = can.editFields(ctx, lp.clientId);
  const snippet = `<script src="${ingestBase()}/lead.js"\n        data-client="${lp.client.slug}"\n        data-lp="${lp.lpKey}"\n        defer></script>`;

  return (
    <>
      <PageHeader
        crumbs={[
          ...(isSabhiStaff(ctx) ? [{ label: "Clients", href: "/clients" }] : []),
          { label: lp.client.name, href: `/clients/${lp.client.id}` },
          { label: lp.name },
        ]}
        title={
          <span className="flex items-center gap-2.5">
            {lp.name}
            <Badge tone={lp.status === "active" ? "green" : "amber"} dot>{lp.status === "active" ? "Active" : "Paused"}</Badge>
            {lp.autoCreated && <Badge tone="blue">Auto</Badge>}
          </span>
        }
        subtitle={<>LP key <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-ink">{lp.lpKey}</code>{lp.sourceUrl && <> · <span className="break-all">{lp.sourceUrl}</span></>}</>}
        actions={
          <>
            {manage && (
              <form action={toggleLpStatusAction}>
                <input type="hidden" name="id" value={lp.id} />
                <Button variant="secondary" size="sm">
                  {lp.status === "active" ? <><Pause aria-hidden /> Pause</> : <><Play aria-hidden /> Activate</>}
                </Button>
              </form>
            )}
            <Link href={`/leads?client=${lp.client.id}`} className={buttonClass("primary", "sm")}>View leads <ArrowRight aria-hidden /></Link>
          </>
        }
      />
      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <div className="min-w-0 space-y-6">
          <Card
            title={<span className="flex items-center gap-2"><Code2 aria-hidden className="size-4 text-brand-700" /> Embed snippet</span>}
            description="For pages that use lead.js instead of the client webhook."
          >
            <p className="mb-3 text-sm text-ink-muted">Paste before <code className="font-mono text-xs">&lt;/body&gt;</code> on the landing page, or set the LP key in the Sabhi Lead Connector plugin.</p>
            <CopyBox value={snippet} />
            <details className="mt-4 text-sm">
              <summary className="font-medium text-brand-700 hover:underline">Show example form markup</summary>
              <div className="mt-2"><CopyBox value={exampleForm()} /></div>
            </details>
          </Card>

          <Card
            flush
            title={<span className="flex items-center gap-2"><ListTree aria-hidden className="size-4 text-brand-700" /> Form fields</span>}
            description={`${fields.length} field${fields.length === 1 ? "" : "s"} · each becomes a column in Leads. Rename a label to change the column title.`}
          >
            {fields.length === 0 ? (
              <Empty icon={<ListTree />} title="No fields yet">Fields register automatically when the first lead arrives.</Empty>
            ) : (
              <div className="overflow-x-auto"><table className={tableClass}>
                <thead><tr><th>Key</th><th>Label</th><th>Type</th><th>Role</th><th>First seen</th><th></th></tr></thead>
                <tbody>
                  {fields.map((f) => (
                    <tr key={f.id} className={f.isHidden ? "opacity-50" : ""}>
                      <td className="font-mono text-xs">
                        {f.fieldKey}
                        <div className="mt-1 flex gap-1">
                          {f.isNew && <Badge tone="blue">New</Badge>}
                          {!f.inCurrentForm && <Badge tone="amber">Not in current form</Badge>}
                          {f.isHidden && <Badge>Hidden</Badge>}
                        </div>
                      </td>
                      <td colSpan={editFields ? 1 : 1}>
                        {editFields ? (
                          <form action={updateFieldAction} id={`f-${f.id}`} className="contents">
                            <input type="hidden" name="id" value={f.id} />
                            <Input name="displayLabel" defaultValue={f.displayLabel ?? ""} placeholder={f.label} className="h-8 min-w-48" />
                          </form>
                        ) : (
                          f.displayName
                        )}
                      </td>
                      <td className="text-xs">{f.inputType}</td>
                      <td>
                        {editFields ? (
                          <select form={`f-${f.id}`} name="role" defaultValue={f.role ?? ""} className="h-8 rounded-md border border-line bg-surface px-1.5 text-xs shadow-sm">
                            <option value="">—</option><option value="name">name</option><option value="phone">phone</option><option value="email">email</option>
                          </select>
                        ) : (f.role ?? "—")}
                      </td>
                      <td className="text-xs text-slate-500">{f.firstSeenAt.toLocaleDateString("en-IN")}</td>
                      <td className="whitespace-nowrap">
                        {editFields && (
                          <span className="flex items-center gap-2">
                            <label className="flex items-center gap-1 text-xs"><input form={`f-${f.id}`} type="checkbox" name="isHidden" defaultChecked={f.isHidden} /> hide</label>
                            <Button form={`f-${f.id}`} size="sm" variant="secondary">Save</Button>
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            )}
          </Card>
        </div>

        <div className="space-y-6">
          {manage && (
            <Card title="Settings">
              <ActionForm action={updateLpAction} className="space-y-3">
                <input type="hidden" name="id" value={lp.id} />
                <div><Label htmlFor="name">Name</Label><Input id="name" name="name" defaultValue={lp.name} /></div>
                <div>
                  <Label htmlFor="domains">Allowed domains</Label>
                  <Input id="domains" name="domains" defaultValue={lp.allowedDomains.join(", ")} />
                  <Hint>Subdomains are allowed automatically. Submissions from other sites get 403.</Hint>
                </div>
                <Button type="submit">Save</Button>
              </ActionForm>
            </Card>
          )}
          <Card title="Form versions">
            {versions.length === 0 ? (
              <Empty>None yet.</Empty>
            ) : (
              <ul className="space-y-3 text-sm">
                {versions.map((v) => (
                  <li key={v.id}>
                    <div className="flex items-center gap-2">
                      <code className="font-mono text-xs">{v.versionHash}</code>
                      {v.id === lp.currentFormVersion && <Badge tone="green">current</Badge>}
                      <span className="text-xs text-slate-500">{v._count.leads} leads</span>
                    </div>
                    <p className="text-xs text-slate-500">{v.fieldKeys.join(", ")}</p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
