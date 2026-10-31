import { Download, Inbox, SearchX } from "lucide-react";
import { cookies } from "next/headers";
import Link from "next/link";
import { ColumnHeader } from "@/components/ColumnHeader";
import { ColumnPicker } from "@/components/ColumnPicker";
import { BulkDeleteBar, RowCheckbox, SelectAllCheckbox } from "@/components/LeadDelete";
import { LeadToolbar } from "@/components/LeadToolbar";
import { Pagination } from "@/components/Pagination";
import { Avatar, Badge, buttonClass, Card, Empty, PageHeader, StatusBadge, tableClass } from "@/components/ui";
import { listClientOptions } from "@/lib/data";
import { ALWAYS_SHOWN, HIDDEN_COLUMNS_COOKIE, parseHiddenColumns } from "@/lib/hiddenColumns";
import { leadColumns } from "@/lib/leadColumns";
import { DEFAULT_PAGE_SIZE, leadFieldDefs, PAGE_SIZES, parseLeadQuery, queryLeads, queryToParams, toFieldMeta } from "@/lib/leadQuery";
import { requireCtx } from "@/lib/session";
import { can, isSabhiStaff } from "@/lib/tenant";

type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function LeadsPage({ searchParams }: { searchParams: SP }) {
  const ctx = await requireCtx();
  const query = parseLeadQuery(await searchParams);
  const scope = { clientId: query.clientId };

  const hidden = parseHiddenColumns((await cookies()).get(HIDDEN_COLUMNS_COOKIE)?.value);

  const [clients, defs, allColumns] = await Promise.all([
    isSabhiStaff(ctx) ? listClientOptions(ctx) : Promise.resolve([]),
    leadFieldDefs(ctx, scope),
    leadColumns(ctx, scope),
  ]);
  const { rows: leads, total, totalCapped } = await queryLeads(ctx, query, defs);
  const columns = allColumns.filter((c) => ALWAYS_SHOWN.has(c.id) || !hidden.has(c.id));

  const selectedClient = clients.find((c) => c.id === query.clientId);
  const filtered = Boolean(query.q || query.range || query.conditions.length);
  const exportParams = queryToParams(query, { page: undefined, size: undefined });
  // Super admins, and client admins for their own client, can delete. Rows of other clients get no checkbox.
  const canDelete = (clientId: string) => can.deleteLeads(ctx, clientId);
  const showSelect = leads.some((l) => canDelete(l.clientId));
  const fieldMeta = toFieldMeta(defs);
  const numeric = new Set(defs.filter((d) => d.kind === "number" || d.kind === "bool").map((d) => d.id));

  const clearHref = query.clientId ? `/leads?client=${query.clientId}` : "/leads";
  const countLabel = `${total.toLocaleString("en-IN")}${totalCapped ? "+" : ""} lead${total === 1 && !totalCapped ? "" : "s"}`;

  return (
    <>
      <PageHeader
        title="Leads"
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-ink">{countLabel}</span>
            <span aria-hidden className="text-slate-300">·</span>
            <span>{selectedClient ? selectedClient.name : clients.length ? "All clients" : "Your leads"}</span>
            {filtered && <Badge tone="blue">Filtered</Badge>}
          </span>
        }
        actions={
          <>
            <ColumnPicker columns={allColumns.map((c) => ({ id: c.id, header: c.header }))} hidden={[...hidden]} />
            <a className={buttonClass("secondary", "sm")} href={`/api/leads/export?${exportParams}`}>
              <Download aria-hidden /> Export CSV
            </a>
          </>
        }
      />
      <Card className="mb-4">
        <LeadToolbar clients={clients} fields={fieldMeta} conditions={query.conditions} />
      </Card>
      <Card flush>
        {leads.length === 0 ? (
          filtered ? (
            <Empty
              icon={<SearchX />}
              title="No leads match these filters"
              action={<Link href={clearHref} className={buttonClass("secondary", "sm")}>Clear filters</Link>}
            >
              Try a wider date range or remove a column filter.
            </Empty>
          ) : (
            <Empty icon={<Inbox />} title="No leads yet">
              Leads appear here as soon as a landing page form or the client webhook sends one.
            </Empty>
          )
        ) : (
          <>
            {showSelect && (
              <div className="px-4 pt-3 has-[form.hidden]:hidden">
                <BulkDeleteBar
                  key={`${query.page}-${leads.map((l) => l.id).join()}`}
                  total={total}
                  capped={totalCapped}
                  query={queryToParams(query, { page: undefined, size: undefined, sort: undefined, dir: undefined }).toString()}
                  upto={new Date().toISOString()}
                />
              </div>
            )}
            {/* Own scroll box so the header row stays visible while scrolling long pages. */}
            <div className="max-h-[calc(100vh-300px)] min-h-64 overflow-auto">
              <table className={tableClass}>
                <thead>
                  <tr>
                    {showSelect && <th className="w-10 !pr-0"><SelectAllCheckbox /></th>}
                    {columns.map((c) => (
                      <th key={c.id}>
                        <ColumnHeader
                          columnId={c.id}
                          label={c.header}
                          field={fieldMeta.find((f) => f.id === c.id) ?? null}
                          sortDir={query.sort === c.id ? query.dir : null}
                          numeric={numeric.has(c.id) || c.id === "created_at"}
                          conditions={query.conditions}
                        />
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {leads.map((lead) => (
                    <tr key={lead.id}>
                      {showSelect && <td className="!pr-0">{canDelete(lead.clientId) && <RowCheckbox id={lead.id} label={lead.name ?? "lead"} />}</td>}
                      {columns.map((c) => {
                        const v = c.value(lead);
                        switch (c.id) {
                          case "name":
                            return (
                              <td key={c.id} className="whitespace-nowrap">
                                <span className="flex items-center gap-2.5">
                                  <Avatar name={v || "?"} size="sm" />
                                  <Link href={`/leads/${lead.id}`} className="font-medium text-ink hover:text-brand-700 hover:underline">{v || "(no name)"}</Link>
                                  {lead.isDuplicate && <Badge tone="amber">Duplicate</Badge>}
                                </span>
                              </td>
                            );
                          case "status":
                            return <td key={c.id}><StatusBadge name={v} /></td>;
                          case "source":
                            return <td key={c.id}><Badge>{v}</Badge></td>;
                          case "created_at":
                            return <td key={c.id} className="whitespace-nowrap text-xs text-ink-muted">{v}</td>;
                          case "phone":
                            return <td key={c.id} className="whitespace-nowrap font-mono text-[13px]">{v || <Dash />}</td>;
                          default:
                            return (
                              <td key={c.id} className="max-w-60 whitespace-nowrap">
                                {v ? <span className="block truncate" title={v}>{v}</span> : <Dash />}
                              </td>
                            );
                        }
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="border-t border-line px-4 pb-3">
              <Pagination page={query.page} pageSize={query.pageSize} total={total} capped={totalCapped} sizes={PAGE_SIZES} defaultSize={DEFAULT_PAGE_SIZE} />
            </div>
          </>
        )}
      </Card>
    </>
  );
}

function Dash() {
  return <span className="text-slate-300">—</span>;
}
