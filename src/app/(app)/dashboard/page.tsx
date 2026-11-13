import { ArrowLeft, ArrowRight, BarChart3, Building2, CalendarDays, CopyX, ExternalLink, Inbox, Sun } from "lucide-react";
import Link from "next/link";
import { DashboardClientPicker } from "@/components/DashboardClientPicker";
import { LeadsBarChart } from "@/components/LeadsBarChart";
import { LeadsTrendChart } from "@/components/LeadsTrendChart";
import { Avatar, buttonClass, Card, cx, Empty, PageHeader, StatTile, tableClass, type Tone } from "@/components/ui";
import { dashboardCounts, dashboardTrend } from "@/lib/dashboard";
import { listClientOptions } from "@/lib/data";
import { RANGES, type RangeId } from "@/lib/leadFilterSpec";
import { orNotFound, requireCtx } from "@/lib/session";
import { isSabhiStaff } from "@/lib/tenant";

type SP = Promise<Record<string, string | string[] | undefined>>;

const fmt = (n: number) => n.toLocaleString("en-IN");
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;

export default async function DashboardPage({ searchParams }: { searchParams: SP }) {
  const ctx = await requireCtx();
  const sp = await searchParams;
  const range = RANGES.find((r) => r.id === first(sp.range))?.id as RangeId | undefined;
  const rangeLabel = range ? RANGES.find((r) => r.id === range)!.label : "All time";
  const staff = isSabhiStaff(ctx);
  const picked = staff ? first(sp.client) : undefined;
  const hideDupes = first(sp.dupes) === "hide";

  const [clients, { groupBy, clientId, rows, totals }, trend] = await Promise.all([
    staff ? listClientOptions(ctx) : Promise.resolve([]),
    orNotFound(dashboardCounts(ctx, range, picked, { hideDuplicates: hideDupes })),
    orNotFound(dashboardTrend(ctx, range, picked, { hideDuplicates: hideDupes })),
  ]);
  const client = clients.find((c) => c.id === picked);
  const oneClient = groupBy === "lp";
  const noun = oneClient ? "landing page" : "client";

  /** Dashboard URL keeping the other parameters. */
  const dashHref = (o: { client?: string | null; range?: RangeId | null; dupes?: boolean }) => {
    const p = new URLSearchParams();
    const c = o.client === undefined ? picked : o.client;
    const r = o.range === undefined ? range : o.range;
    const d = o.dupes === undefined ? hideDupes : o.dupes;
    if (c) p.set("client", c);
    if (r) p.set("range", r);
    if (d) p.set("dupes", "hide");
    return p.size ? `/dashboard?${p}` : "/dashboard";
  };
  const leadsHref = (forClient?: string | null, lpId?: string) => {
    const p = new URLSearchParams();
    if (staff && forClient) p.set("client", forClient);
    if (range) p.set("range", range);
    if (hideDupes) p.set("dupes", "hide");
    // Same "filter by values" the Landing page column uses.
    if (lpId) p.set("f", JSON.stringify([{ field: "lp", op: "in", values: [lpId] }]));
    return p.size ? `/leads?${p}` : "/leads";
  };
  // All clients: a bar opens that client's dashboard. One client: a bar opens that page's leads.
  const rowHref = (id: string) => (oneClient ? leadsHref(clientId, id || undefined) : dashHref({ client: id }));

  const withLeads = rows.filter((r) => r.inRange > 0).length;
  const top = rows[0]?.inRange ? rows[0] : null;
  const tiles: { label: string; value: string; hint: string; icon: React.ReactNode; tone: Tone }[] = [
    {
      icon: <Inbox />,
      tone: "blue",
      label: `Leads · ${rangeLabel}`,
      value: fmt(totals.inRange),
      hint: hideDupes
        ? `${fmt(totals.duplicates)} duplicate${totals.duplicates === 1 ? "" : "s"} left out`
        : range ? `${fmt(totals.allTime)} all time` : `Across ${rows.length} ${noun}${rows.length === 1 ? "" : "s"}`,
    },
    { icon: <Sun />, tone: "amber", label: "Today", value: fmt(totals.today), hint: "Since midnight IST" },
    { icon: <CalendarDays />, tone: "violet", label: "Last 7 days", value: fmt(totals.last7), hint: `${fmt(totals.last30)} in 30 days` },
    { icon: <Building2 />, tone: "green", label: oneClient ? "Pages with leads" : "Clients with leads", value: `${withLeads} / ${rows.length}`, hint: top ? `Most: ${top.name}` : `None · ${rangeLabel.toLowerCase()}` },
  ];

  // IST time of day for the greeting.
  const istHour = Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hourCycle: "h23", timeZone: "Asia/Kolkata" }).format(new Date()));
  const greeting = istHour < 12 ? "Good morning" : istHour < 17 ? "Good afternoon" : "Good evening";
  const todayLabel = new Intl.DateTimeFormat("en-IN", { weekday: "long", day: "numeric", month: "long", timeZone: "Asia/Kolkata" }).format(new Date());

  return (
    <>
      {!client && (
        <section className="mb-6 flex flex-wrap items-end justify-between gap-5 rounded-xl border border-line bg-surface px-6 py-5 shadow-card">
          <div className="min-w-0">
            <p className="text-[13px] text-ink-muted">{todayLabel}</p>
            <h1 className="mt-0.5 text-2xl font-semibold tracking-tight text-ink">{greeting}, {ctx.name.split(" ")[0]}</h1>
            <p className="mt-1.5 text-sm text-ink-muted">
              <span className="font-semibold text-ink">{fmt(totals.today)}</span> new lead{totals.today === 1 ? "" : "s"} today
              <span aria-hidden className="mx-2 text-stone-300">/</span>
              <span className="font-semibold text-ink">{fmt(totals.last7)}</span> this week
              <span aria-hidden className="mx-2 text-stone-300">/</span>
              <span className="font-semibold text-ink">{fmt(totals.allTime)}</span> {hideDupes ? "unique " : ""}all time
            </p>
          </div>
          <Link href={leadsHref(clientId)} className={buttonClass("primary", "sm")}>
            Open leads <ArrowRight aria-hidden />
          </Link>
        </section>
      )}
      {client && <PageHeader
        crumbs={client ? [{ label: "Dashboard", href: dashHref({ client: null }) }, { label: client.name }] : undefined}
        icon={client ? <Avatar name={client.name} size="lg" /> : undefined}
        title={client ? client.name : "Dashboard"}
        subtitle={oneClient ? "Leads by landing page and over time" : "How many leads each client is getting"}
        actions={
          <>
            {client && (
              <Link href={dashHref({ client: null })} className={buttonClass("ghost", "sm")}>
                <ArrowLeft aria-hidden /> All clients
              </Link>
            )}
            <Link href={leadsHref(clientId)} className={buttonClass("secondary", "sm")}>
              Open leads <ArrowRight aria-hidden />
            </Link>
          </>
        }
      />}

      {/* Filters in one row, above everything they affect */}
      <div className="mb-6 flex flex-wrap items-center gap-3">
        {staff && <DashboardClientPicker clients={clients} value={picked ?? ""} />}
        <nav aria-label="Date range" className="inline-flex max-w-full gap-0.5 overflow-x-auto rounded-lg bg-slate-100 p-1 [scrollbar-width:none]">
          {[{ id: undefined, label: "All time" }, ...RANGES].map((r) => {
            const active = r.id === range;
            return (
              <Link
                key={r.label}
                href={dashHref({ range: r.id ?? null })}
                aria-current={active ? "page" : undefined}
                className={cx(
                  "h-8 whitespace-nowrap rounded-md px-3 text-sm font-medium leading-8 transition-colors duration-150",
                  active ? "bg-surface text-brand-700 shadow-sm ring-1 ring-line" : "text-ink-muted hover:text-ink",
                )}
              >
                {r.label}
              </Link>
            );
          })}
        </nav>
        <Link
          href={dashHref({ dupes: !hideDupes })}
          aria-pressed={hideDupes}
          title="Duplicates are repeat leads from the same phone or email within 30 days; the first one stays."
          className={buttonClass(hideDupes ? "primary" : "secondary", "sm")}
        >
          <CopyX aria-hidden /> {hideDupes ? "Duplicates hidden" : "Hide duplicates"}
        </Link>
      </div>

      <dl className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {tiles.map((t) => (
          <StatTile key={t.label} label={t.label} value={t.value} hint={t.hint} icon={t.icon} tone={t.tone} />
        ))}
      </dl>

      <Card className="mb-6" title={trend.title} description={client ? `${client.name} only` : oneClient ? undefined : "All clients combined"}>
        <LeadsTrendChart points={trend.points} />
      </Card>

      {rows.length === 0 ? (
        <Card>
          <Empty icon={<BarChart3 />} title={`No ${noun}s yet`}>Leads per {noun} appear here once there is data.</Empty>
        </Card>
      ) : (
        <div className="grid gap-6 2xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <Card
            title={`Leads by ${noun} · ${rangeLabel}`}
            description={oneClient ? "Hover a bar for details; click to open the leads." : "Hover a bar for details; click a client to see its own dashboard."}
          >
            {totals.inRange === 0 ? (
              <Empty icon={<BarChart3 />} title="No leads in this period">Try a longer date range.</Empty>
            ) : (
              <LeadsBarChart
                total={totals.inRange}
                valueLabel={range ? `leads · ${rangeLabel.toLowerCase()}` : "leads"}
                bars={rows.map((r) => ({ id: r.id, name: r.name, value: r.inRange, today: r.today, last7: r.last7, href: rowHref(r.id) }))}
              />
            )}
          </Card>

          <Card flush title={`All ${noun}s`} description="The same numbers as a table, plus fixed time windows.">
            <div className="overflow-x-auto">
              <table className={tableClass}>
                <thead>
                  <tr>
                    <th>{oneClient ? "Landing page" : "Client"}</th>
                    <th className="text-right">{range ? rangeLabel : "Leads"}</th>
                    <th className="text-right">Share</th>
                    <th className="text-right">Today</th>
                    <th className="text-right">7 days</th>
                    <th className="text-right">30 days</th>
                    {range && <th className="text-right">All time</th>}
                    <th className="text-right" title={hideDupes ? "Left out of the other numbers" : undefined}>
                      Duplicates{range ? ` · ${rangeLabel}` : ""}
                    </th>
                    {!oneClient && <th className="w-8"><span className="sr-only">Leads</span></th>}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id || r.name}>
                      <td className="max-w-56">
                        <Link href={rowHref(r.id)} className="flex items-center gap-2.5 font-medium text-ink hover:text-brand-700 hover:underline">
                          {!oneClient && <Avatar name={r.name} size="sm" />}
                          <span className="truncate">{r.name}</span>
                        </Link>
                      </td>
                      <td className="text-right font-semibold tabular-nums">{fmt(r.inRange)}</td>
                      <td className="text-right tabular-nums text-ink-muted">{totals.inRange ? `${Math.round((r.inRange / totals.inRange) * 1000) / 10}%` : "—"}</td>
                      <td className="text-right tabular-nums">{fmt(r.today)}</td>
                      <td className="text-right tabular-nums">{fmt(r.last7)}</td>
                      <td className="text-right tabular-nums">{fmt(r.last30)}</td>
                      {range && <td className="text-right tabular-nums">{fmt(r.allTime)}</td>}
                      <td className="text-right tabular-nums text-ink-muted">{fmt(r.duplicates)}</td>
                      {!oneClient && (
                        <td>
                          <Link href={leadsHref(r.id)} aria-label={`Open ${r.name} leads`} title="Open leads" className="inline-flex rounded p-1 text-ink-muted hover:bg-slate-100 hover:text-brand-700">
                            <ExternalLink aria-hidden className="size-4" />
                          </Link>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="[&_td]:border-t [&_td]:border-line [&_td]:bg-slate-50 [&_td]:px-4 [&_td]:py-3 [&_td]:font-semibold">
                    <td>Total</td>
                    <td className="text-right tabular-nums">{fmt(totals.inRange)}</td>
                    <td className="text-right tabular-nums text-ink-muted">{totals.inRange ? "100%" : "—"}</td>
                    <td className="text-right tabular-nums">{fmt(totals.today)}</td>
                    <td className="text-right tabular-nums">{fmt(totals.last7)}</td>
                    <td className="text-right tabular-nums">{fmt(totals.last30)}</td>
                    {range && <td className="text-right tabular-nums">{fmt(totals.allTime)}</td>}
                    <td className="text-right tabular-nums text-ink-muted">{fmt(totals.duplicates)}</td>
                    {!oneClient && <td />}
                  </tr>
                </tfoot>
              </table>
            </div>
          </Card>
        </div>
      )}
    </>
  );
}
