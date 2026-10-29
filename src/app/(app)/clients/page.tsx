import { Building2, ChevronRight } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { createClientAction } from "@/app/actions";
import { ActionForm } from "@/components/ActionForm";
import { Avatar, Badge, Button, Card, Empty, Hint, Input, Label, PageHeader, tableClass } from "@/components/ui";
import { listClients } from "@/lib/data";
import { requireCtx } from "@/lib/session";
import { can, isSabhiStaff } from "@/lib/tenant";

export default async function ClientsPage() {
  const ctx = await requireCtx();
  if (!isSabhiStaff(ctx) && ctx.clientId) redirect(`/clients/${ctx.clientId}`);
  const clients = await listClients(ctx);
  const totalLeads = clients.reduce((n, c) => n + c._count.leads, 0);
  return (
    <>
      <PageHeader
        title="Clients"
        subtitle={`${clients.length} client${clients.length === 1 ? "" : "s"} · ${totalLeads.toLocaleString("en-IN")} leads in total`}
      />
      <div className="grid gap-6 xl:grid-cols-[1fr_340px]">
        <Card flush className="min-w-0">
          {clients.length === 0 ? (
            <Empty icon={<Building2 />} title="No clients yet">Create the first client to get its webhook URL and landing pages.</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className={tableClass}>
                <thead><tr><th>Client</th><th>Landing pages</th><th>Leads</th><th>Users</th><th>Status</th><th className="w-8" /></tr></thead>
                <tbody>
                  {clients.map((c) => (
                    <tr key={c.id} className="group">
                      <td>
                        <Link href={`/clients/${c.id}`} className="flex items-center gap-3">
                          <Avatar name={c.name} />
                          <span className="min-w-0">
                            <span className="block font-medium text-ink group-hover:text-brand-700">{c.name}</span>
                            <span className="block font-mono text-xs text-ink-muted">{c.slug}</span>
                          </span>
                        </Link>
                      </td>
                      <td>{c._count.landingPages}</td>
                      <td className="font-medium">{c._count.leads.toLocaleString("en-IN")}</td>
                      <td>{c._count.users}</td>
                      <td><Badge tone={c.status === "active" ? "green" : "slate"} dot>{c.status === "active" ? "Active" : "Disabled"}</Badge></td>
                      <td><ChevronRight aria-hidden className="size-4 text-slate-300 group-hover:text-ink-muted" /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        {can.manageClients(ctx) && (
          <Card title="New client" description="Gets a default pipeline and its own webhook URL." className="self-start">
            <ActionForm action={createClientAction} className="space-y-4">
              <div><Label htmlFor="name">Name</Label><Input id="name" name="name" required placeholder="Ritu Agarwal" /></div>
              <div>
                <Label htmlFor="slug">Slug</Label>
                <Input id="slug" name="slug" placeholder="ritu-agarwal" />
                <Hint>Optional. Used in snippet URLs; generated from the name if empty.</Hint>
              </div>
              <Button type="submit" className="w-full">Create client</Button>
            </ActionForm>
          </Card>
        )}
      </div>
    </>
  );
}
