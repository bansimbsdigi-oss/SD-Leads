import { notFound } from "next/navigation";
import { ScrollText } from "lucide-react";
import { Avatar, Badge, Card, Empty, PageHeader, tableClass, type Tone } from "@/components/ui";
import { formatDateTime } from "@/lib/leadColumns";
import { prisma } from "@/lib/db";
import { requireCtx } from "@/lib/session";
import { can } from "@/lib/tenant";

export default async function AuditPage() {
  const ctx = await requireCtx();
  if (!can.viewAudit(ctx)) notFound();
  const entries = await prisma.auditLog.findMany({ orderBy: { createdAt: "desc" }, take: 300 });
  const actorIds = [...new Set(entries.map((e) => e.actorId).filter(Boolean))] as string[];
  const actors = new Map((await prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  return (
    <>
      <PageHeader title="Audit log" subtitle="Who changed what, newest first (latest 300 entries)" />
      <Card flush>
        {entries.length === 0 ? (
          <Empty icon={<ScrollText />} title="Nothing logged yet" />
        ) : (
          <div className="max-h-[calc(100vh-200px)] overflow-auto">
            <table className={tableClass}>
              <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Target</th></tr></thead>
              <tbody>
                {entries.map((e) => {
                  const who = e.actorId ? actors.get(e.actorId) ?? "Deleted user" : "System";
                  const [area] = e.action.split(".");
                  return (
                    <tr key={e.id}>
                      <td className="whitespace-nowrap text-xs text-ink-muted">{formatDateTime(e.createdAt)}</td>
                      <td className="whitespace-nowrap">
                        <span className="flex items-center gap-2"><Avatar name={who} size="sm" />{who}</span>
                      </td>
                      <td>
                        <Badge tone={e.action.endsWith("delete") ? "red" : AREA_TONE[area] ?? "slate"}>{ACTION_LABEL[e.action] ?? e.action}</Badge>
                      </td>
                      <td className="max-w-md truncate font-mono text-xs text-ink-muted" title={e.target ?? undefined}>{e.target}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

const ACTION_LABEL: Record<string, string> = {
  "client.create": "Client created",
  "client.webhook_rotated": "Webhook URL regenerated",
  "lp.create": "Landing page created",
  "lp.update": "Landing page edited",
  "lp.active": "Landing page activated",
  "lp.paused": "Landing page paused",
  "user.create": "User added",
  "field.update": "Field edited",
  "lead.delete": "Lead deleted",
  "leads.export": "Leads exported",
};

const AREA_TONE: Record<string, Tone> = { client: "blue", lp: "violet", user: "green", field: "slate", leads: "amber" };
