import { Archive, Download, Inbox, SearchX, Trash2 } from "lucide-react";
import Link from "next/link";
import { ColumnHeader } from "@/components/ColumnHeader";
import { ColumnPicker } from "@/components/ColumnPicker";
import { BulkDeleteBar, EmptyTrashButton, RowCheckbox, SelectAllCheckbox } from "@/components/LeadDelete";
import { LeadInlineSelect } from "@/components/LeadInlineSelect";
import { LeadToolbar } from "@/components/LeadToolbar";
import { Pagination } from "@/components/Pagination";
import { Avatar, Badge, buttonClass, Card, cx, Empty, PageHeader, tableClass } from "@/components/ui";
import { columnScope, getHiddenColumns } from "@/lib/columnPrefs";
import { leadBinCounts, listClientOptions } from "@/lib/data";
import { ALWAYS_SHOWN } from "@/lib/hiddenColumns";
import { leadColumns } from "@/lib/leadColumns";
import { editOptions } from "@/lib/leadEdit";
import { DEFAULT_PAGE_SIZE, leadFieldDefs, PAGE_SIZES, parseLeadQuery, queryLeads, queryToParams, toFieldMeta } from "@/lib/leadQuery";
import { requireCtx } from "@/lib/session";
import { can, isSabhiStaff } from "@/lib/tenant";

type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function LeadsPage({ searchParams }: { searchParams: SP }) {
  const ctx = await requireCtx();
  const query = parseLeadQuery(await searchParams);
  const scope = { clientId: query.clientId };

  // Column choices are remembered per client (or for "all clients").
  const colScope = columnScope(query.clientId ?? (isSabhiStaff(ctx) ? null : ctx.clientId));

  const [clients, defs, allColumns, hidden, bins] = await Promise.all([
    isSabhiStaff(ctx) ? listClientOptions(ctx) : Promise.resolve([]),
    leadFieldDefs(ctx, scope),
    leadColumns(ctx, scope),
    getHiddenColumns(ctx.userId, colScope),
    leadBinCounts(ctx, query.clientId),
  ]);
  const view = query.view;
  const { rows: leads, total, totalCapped } = await queryLeads(ctx, query, defs);
  const columns = allColumns.filter((c) => ALWAYS_SHOWN.has(c.id) || !hidden.has(c.id));
  // Status / owner dropdowns: options per client on this page. Bulk changes need one client in view.
  const pageClients = [...new Set(leads.map((l) => l.clientId))];
  const edit = await editOptions(ctx, pageClients);
  const bulkClient = pageClients.length === 1 ? pageClients[0] : null;

  const selectedClient = clients.find((c) => c.id === query.clientId);
  const filtered = Boolean(query.q || query.range || query.hideDuplicates || query.conditions.length);
  const exportParams = queryToParams(query, { page: undefined, size: undefined });
  // Super admins, and client admins for their own client, can delete. Rows of other clients get no checkbox.
  const canDelete = (clientId: string) => can.deleteLeads(ctx, clientId);
  // Everyone who sees a lead can work on it (status, tags); deleting is for admins.
  const showSelect = leads.length > 0;
  const deletable = leads.some((l) => canDelete(l.clientId));
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
            <ColumnPicker columns={allColumns.map((c) => ({ id: c.id, header: c.header }))} hidden={[...hidden]} scope={colScope} />
            <a className={buttonClass("secondary", "sm")} href={`/api/leads/export?${exportParams}`}>
              <Download aria-hidden /> Export CSV
            </a>
          </>
        }
      />
      <nav aria-label="Lead lists" className="mb-4 flex flex-wrap items-center gap-1 border-b border-line">
        {[
          { id: undefined, label: "Leads", icon: <Inbox aria-hidden className="size-4" /> },
          { id: "archived" as const, label: `Archived${bins.archived ? ` (${bins.archived.toLocaleString("en-IN")})` : ""}`, icon: <Archive aria-hidden className="size-4" /> },
          { id: "trash" as const, label: `Trash${bins.trash ? ` (${bins.trash.toLocaleString("en-IN")})` : ""}`, icon: <Trash2 aria-hidden className="size-4" /> },
        ].map((t) => {
          const p = new URLSearchParams();
          if (query.clientId) p.set("client", query.clientId);
          if (t.id) p.set("view", t.id);
          const active = view === t.id;
          return (
            <Link
              key={t.label}
              href={p.size ? `/leads?${p}` : "/leads"}
              aria-current={active ? "page" : undefined}
              className={cx(
                "-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors",
                active ? "border-brand-600 text-ink" : "border-transparent text-ink-muted hover:text-ink",
              )}
            >
              {t.icon} {t.label}
            </Link>
          );
        })}
        {view === "trash" && bins.trash > 0 && deletable && (
          <span className="ml-auto pb-1.5"><EmptyTrashButton clientId={query.clientId ?? null} count={bins.trash} /></span>
        )}
      </nav>
      {view === "trash" && (
        <p className="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 ring-1 ring-inset ring-amber-200">
          Deleted leads stay here until you restore them or delete them for good. They don&apos;t appear in lists, dashboards or duplicate checks.
        </p>
      )}
      {view === "archived" && (
        <p className="mb-4 rounded-lg bg-slate-50 px-3 py-2 text-sm text-ink-muted ring-1 ring-inset ring-line">
          Archived leads are hidden from the main list but still count in the dashboard. Tick them to bring them back.
        </p>
      )}
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
            <Empty icon={view === "trash" ? <Trash2 /> : view === "archived" ? <Archive /> : <Inbox />} title={view === "trash" ? "Trash is empty" : view === "archived" ? "Nothing archived" : "No leads yet"}>
              {view === "trash"
                ? "Leads you delete land here first, so they can be restored."
                : view === "archived"
                  ? "Tick leads in the main list and choose Archive to tidy it up without deleting anything."
                  : "Leads appear here as soon as a landing page form or the client webhook sends one."}
            </Empty>
          )
        ) : (
          <>
            {showSelect && (
              <div className="px-4 pt-3 has-[form.hidden]:hidden">
                <BulkDeleteBar
                  key={`${query.page}-${leads.map((l) => l.id).join()}`}
                  stages={bulkClient ? edit.stages[bulkClient] ?? [] : null}
                  owners={bulkClient && edit.canAssign ? edit.owners[bulkClient] ?? [] : null}
                  canDelete={deletable}
                  view={view ?? null}
                  canArchive={ctx.role !== "CLIENT_MEMBER"}
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
                          scope={colScope}
                        />
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {leads.map((lead) => (
                    <tr key={lead.id}>
                      {showSelect && <td className="!pr-0"><RowCheckbox id={lead.id} label={lead.name ?? "lead"} /></td>}
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
                            return (
                              <td key={c.id} className="whitespace-nowrap">
                                <LeadInlineSelect leadId={lead.id} kind="status" value={lead.statusId} options={edit.stages[lead.clientId] ?? []} />
                              </td>
                            );
                          case "owner":
                            return (
                              <td key={c.id} className="whitespace-nowrap">
                                {edit.canAssign
                                  ? <LeadInlineSelect leadId={lead.id} kind="owner" value={lead.ownerId} options={edit.owners[lead.clientId] ?? []} />
                                  : v || <Dash />}
                              </td>
                            );
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
