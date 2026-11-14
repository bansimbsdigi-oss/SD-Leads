import { ListTree } from "lucide-react";
import { notFound } from "next/navigation";
import { FieldManager } from "@/components/FieldManager";
import { ClientLogo } from "@/components/ClientLogo";
import { Card, Empty, PageHeader } from "@/components/ui";
import { logoUrl } from "@/lib/branding";
import { getClient } from "@/lib/data";
import { fieldColumns, mergeTargets } from "@/lib/fieldManager";
import { orNotFound, requireCtx } from "@/lib/session";
import { can, isSabhiStaff } from "@/lib/tenant";

export default async function FieldsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireCtx();
  const client = await orNotFound(getClient(ctx, id));
  if (!can.editFields(ctx, client.id)) notFound();
  const [columns, targets] = await Promise.all([fieldColumns(ctx, client.id), mergeTargets(ctx, client.id)]);

  return (
    <>
      <PageHeader
        crumbs={[...(isSabhiStaff(ctx) ? [{ label: "Clients", href: "/clients" }] : []), { label: client.name, href: `/clients/${client.id}` }, { label: "Fields" }]}
        icon={<ClientLogo name={client.name} logo={logoUrl(client)} size="lg" />}
        title="Manage fields"
        subtitle="Every form column from all of this client's landing pages. Changes apply to the leads table and CSV export."
      />
      <Card flush>
        {columns.length === 0 ? (
          <Empty icon={<ListTree />} title="No form fields yet">Fields appear here once leads arrive with answers beyond name, mobile and email.</Empty>
        ) : (
          <>
            <p className="border-b border-line px-5 py-3 text-xs text-ink-muted">
              <strong className="font-semibold text-ink">Rename</strong>: click a name and type. <strong className="font-semibold text-ink">Hide</strong>: removes the column from the table (answers stay on each lead).{" "}
              <strong className="font-semibold text-ink">Merge</strong>: shows one column inside another, e.g. “Goal” and “Your goal”. Nothing in the leads themselves changes.
            </p>
            <FieldManager clientId={client.id} columns={columns} targets={targets} />
          </>
        )}
      </Card>
    </>
  );
}
