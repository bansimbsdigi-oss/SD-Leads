import { UserPlus, Users } from "lucide-react";
import { notFound } from "next/navigation";
import { Avatar, Badge, Card, Empty, PageHeader, tableClass } from "@/components/ui";
import { EditUserDialog } from "@/components/EditUserDialog";
import { UserForm } from "@/components/UserForm";
import { listClientOptions, listUsers } from "@/lib/data";
import { formatDateTime } from "@/lib/leadColumns";
import { requireCtx } from "@/lib/session";

export default async function StaffPage() {
  const ctx = await requireCtx();
  if (ctx.role !== "SUPER_ADMIN") notFound();
  const [users, clients] = await Promise.all([listUsers(ctx, null), listClientOptions(ctx)]);
  const roles = [{ value: "ACCOUNT_MANAGER", label: "Account manager" }, { value: "SUPER_ADMIN", label: "Super admin" }];
  return (
    <>
      <PageHeader title="Sabhi team" subtitle={`${users.length} member${users.length === 1 ? "" : "s"} · super admins and account managers`} />
      <div className="grid gap-6 xl:grid-cols-[1fr_340px]">
        <Card flush className="min-w-0">
          {users.length === 0 ? (
            <Empty icon={<Users />} title="No team members yet" />
          ) : (
            <div className="overflow-x-auto">
              <table className={tableClass}>
                <thead><tr><th>Member</th><th>Role</th><th>Last login</th><th><span className="sr-only">Actions</span></th></tr></thead>
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
                      <td>
                        <span className="flex flex-wrap gap-1.5">
                          <Badge tone={u.role === "SUPER_ADMIN" ? "blue" : "slate"}>{u.role === "SUPER_ADMIN" ? "Super admin" : "Account manager"}</Badge>
                          {u.status === "disabled" && <Badge tone="red">Disabled</Badge>}
                        </span>
                      </td>
                      <td className="whitespace-nowrap text-xs text-ink-muted">{u.lastLoginAt ? formatDateTime(u.lastLoginAt) : "Never"}</td>
                      <td className="text-right">
                        <EditUserDialog
                          user={{ ...u, managedClientIds: u.managedClients.map((m) => m.clientId), lpIds: [] }}
                          roles={roles}
                          clients={clients}
                          isSelf={u.id === ctx.userId}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <Card title={<span className="flex items-center gap-2"><UserPlus aria-hidden className="size-4 text-brand-700" /> Add team member</span>} className="self-start">
          <UserForm
            clientId={null}
            roles={roles}
            clients={clients}
          />
        </Card>
      </div>
    </>
  );
}
