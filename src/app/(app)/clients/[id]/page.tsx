import { ArrowRight, FileText, RefreshCw, UserPlus, Users, Webhook } from "lucide-react";
import Link from "next/link";
import { rotateWebhookAction } from "@/app/actions";
import { CopyBox } from "@/components/CopyBox";
import { DeleteClientDialog } from "@/components/DeleteClientDialog";
import { EditLpDialog } from "@/components/EditLpDialog";
import { Avatar, Badge, Button, buttonClass, Card, Empty, PageHeader, tableClass } from "@/components/ui";
import { UserForm } from "@/components/UserForm";
import { WebhooksCard } from "@/components/WebhooksCard";
import { getClient, listLps, listUsers } from "@/lib/data";
import { leadFieldDefs, toFieldMeta } from "@/lib/leadQuery";
import { listWebhookRules } from "@/lib/outbound/webhooks";
import { formatDateTime } from "@/lib/leadColumns";
import { orNotFound, requireCtx } from "@/lib/session";
import { can, isSabhiStaff } from "@/lib/tenant";

export default async function ClientPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireCtx();
  const client = await orNotFound(getClient(ctx, id));
  const canManageUsers = can.manageUsers(ctx, client.id);
  const canManageLps = can.manageLps(ctx, client.id);
  const [lps, users, webhooks, fieldDefs] = await Promise.all([
    listLps(ctx, client.id),
    canManageUsers ? listUsers(ctx, client.id) : Promise.resolve([]),
    canManageLps ? listWebhookRules(ctx, client.id) : Promise.resolve([]),
    canManageLps ? leadFieldDefs(ctx, { clientId: client.id }) : Promise.resolve([]),
  ]);

  const webhookUrl = `${(process.env.INGEST_URL || process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "")}/api/hook/${client.webhookToken}`;
  const leadCount = lps.reduce((n, lp) => n + lp._count.leads, 0);
  const stats = [
    { label: "Landing pages", value: lps.length },
    { label: "Leads", value: leadCount },
    { label: "Active pages", value: lps.filter((lp) => lp.status === "active").length },
    ...(canManageUsers ? [{ label: "Users", value: users.length }] : []),
  ];

  return (
    <>
      <PageHeader
        crumbs={isSabhiStaff(ctx) ? [{ label: "Clients", href: "/clients" }, { label: client.name }] : undefined}
        icon={<Avatar name={client.name} size="lg" />}
        title={client.name}
        subtitle={<code className="font-mono text-xs">{client.slug}</code>}
        actions={
          <Link href={`/leads?client=${client.id}`} className={buttonClass("primary", "sm")}>
            View leads <ArrowRight aria-hidden />
          </Link>
        }
      />

      <dl className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {stats.map((s) => (
          <div key={s.label} className="rounded-xl border border-line bg-surface px-4 py-3">
            <dt className="text-xs font-medium text-ink-muted">{s.label}</dt>
            <dd className="mt-1 text-2xl font-semibold tracking-tight">{s.value.toLocaleString("en-IN")}</dd>
          </div>
        ))}
      </dl>

      <div className="grid gap-6 xl:grid-cols-[1fr_340px]">
        <div className="min-w-0 space-y-6">
          {can.editFields(ctx, client.id) && (
            <Card
              title={<span className="flex items-center gap-2"><Webhook aria-hidden className="size-4 text-brand-700" /> Client webhook</span>}
              description="One URL for every landing page of this client."
              actions={
                canManageLps && (
                  <form action={rotateWebhookAction}>
                    <input type="hidden" name="clientId" value={client.id} />
                    <Button variant="ghost" size="sm" title="The old URL stops working immediately">
                      <RefreshCw aria-hidden /> Regenerate
                    </Button>
                  </form>
                )
              }
            >
              <CopyBox value={webhookUrl} />
              <ol className="mt-4 grid gap-3 text-sm text-ink-muted sm:grid-cols-2">
                {[
                  <>Paste it into the webhook action of every form (Elementor <em>Actions After Submit → Webhook</em>, WPForms, Pabbly, Zapier).</>,
                  <>Leads are filed by the page URL the form sends. A new page becomes a landing page marked <Badge tone="blue">Auto</Badge>.</>,
                  <>Add <code className="rounded bg-slate-100 px-1 font-mono text-xs text-ink">?lp=LP_KEY</code> to the URL to send to one landing page.</>,
                  <>Keep it private: anyone with the URL can send leads to this client.</>,
                ].map((text, i) => (
                  <li key={i} className="flex gap-2.5">
                    <span aria-hidden className="flex size-5 shrink-0 items-center justify-center rounded-full bg-brand-50 text-[11px] font-semibold text-brand-700">{i + 1}</span>
                    <span>{text}</span>
                  </li>
                ))}
              </ol>
            </Card>
          )}

          <Card flush title="Landing pages" description={`${lps.length} page${lps.length === 1 ? "" : "s"}`}>
            {lps.length === 0 ? (
              <Empty icon={<FileText />} title="No landing pages yet">
                Send a lead to the client webhook above and its landing page appears here automatically.
              </Empty>
            ) : (
              <div className="overflow-x-auto">
                <table className={tableClass}>
                  <thead><tr><th>Name</th><th>LP key</th><th>Domains</th><th>Fields</th><th>Leads</th><th>Status</th>{canManageLps && <th />}</tr></thead>
                  <tbody>
                    {lps.map((lp) => (
                      <tr key={lp.id}>
                        <td className="max-w-72">
                          <span className="flex items-center gap-2">
                            <Link href={`/lps/${lp.id}`} className="truncate font-medium text-ink hover:text-brand-700 hover:underline">{lp.name}</Link>
                            {lp.autoCreated && <Badge tone="blue">Auto</Badge>}
                          </span>
                          {lp.sourceUrl && <span className="mt-0.5 block truncate text-xs text-ink-muted" title={lp.sourceUrl}>{lp.sourceUrl}</span>}
                        </td>
                        <td className="whitespace-nowrap font-mono text-xs text-ink-muted">{lp.lpKey}</td>
                        <td className="max-w-48 truncate text-xs text-ink-muted" title={lp.allowedDomains.join(", ")}>
                          {lp.allowedDomains.length ? lp.allowedDomains.join(", ") : <span className="text-slate-300">—</span>}
                        </td>
                        <td>{lp._count.fields}</td>
                        <td className="font-medium">{lp._count.leads.toLocaleString("en-IN")}</td>
                        <td><Badge tone={lp.status === "active" ? "green" : "amber"} dot>{lp.status === "active" ? "Active" : "Paused"}</Badge></td>
                        {canManageLps && (
                          <td className="text-right">
                            <EditLpDialog lp={{ id: lp.id, name: lp.name, lpKey: lp.lpKey, allowedDomains: lp.allowedDomains, status: lp.status }} />
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {canManageLps && <WebhooksCard clientId={client.id} rules={webhooks} fields={toFieldMeta(fieldDefs)} />}

          {canManageUsers && (
            <Card flush title="Users" description="People at this client who can log in.">
              {users.length === 0 ? (
                <Empty icon={<Users />} title="No client users yet">Add the client&apos;s team on the right when they should see their own leads.</Empty>
              ) : (
                <div className="overflow-x-auto">
                  <table className={tableClass}>
                    <thead><tr><th>Name</th><th>Role</th><th>Last login</th></tr></thead>
                    <tbody>
                      {users.map((u) => (
                        <tr key={u.id}>
                          <td>
                            <span className="flex items-center gap-3">
                              <Avatar name={u.name} size="sm" />
                              <span className="min-w-0">
                                <span className="block font-medium">{u.name}</span>
                                <span className="block truncate text-xs text-ink-muted">{u.email}</span>
                              </span>
                            </span>
                          </td>
                          <td><Badge tone={u.role === "CLIENT_ADMIN" ? "violet" : "slate"}>{u.role === "CLIENT_ADMIN" ? "Admin" : "Member"}</Badge></td>
                          <td className="whitespace-nowrap text-xs text-ink-muted">{u.lastLoginAt ? formatDateTime(u.lastLoginAt) : "Never"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          )}

          {can.manageClients(ctx) && (
            <section className="rounded-xl border border-red-200 bg-surface">
              <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
                <div>
                  <h2 className="text-sm font-semibold text-red-700">Danger zone</h2>
                  <p className="mt-0.5 text-xs text-ink-muted">Delete this client and all of its landing pages, leads, logins and webhooks.</p>
                </div>
                <DeleteClientDialog
                  id={client.id}
                  name={client.name}
                  counts={{ landingPages: lps.length, leads: leadCount, users: users.length, webhooks: webhooks.length }}
                />
              </div>
            </section>
          )}
        </div>

        <div className="space-y-6">
          {canManageUsers && (
            <Card title={<span className="flex items-center gap-2"><UserPlus aria-hidden className="size-4 text-brand-700" /> Add user</span>}>
              <UserForm
                clientId={client.id}
                roles={[{ value: "CLIENT_MEMBER", label: "Client member" }, { value: "CLIENT_ADMIN", label: "Client admin" }]}
                lps={lps.map((lp) => ({ id: lp.id, name: lp.name }))}
              />
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
