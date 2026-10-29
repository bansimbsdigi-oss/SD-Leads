"use client";

import { Loader2, Search, SlidersHorizontal, X } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { Button, Input, Select } from "@/components/ui";
import { describeCondition, OPS, RANGES, type Condition, type FieldMeta, type Op } from "@/lib/leadFilterSpec";

type Props = {
  clients: { id: string; name: string }[];
  fields: FieldMeta[];
  conditions: Condition[];
};

const chip = (active: boolean) =>
  `h-8 whitespace-nowrap rounded-md px-3 text-sm font-medium transition-colors duration-150 ${
    active ? "bg-surface text-brand-700 shadow-sm ring-1 ring-line" : "text-ink-muted hover:text-ink"
  }`;

export function LeadToolbar({ clients, fields, conditions }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [q, setQ] = useState(params.get("q") ?? "");
  const [open, setOpen] = useState(false);
  const rowConditions = (list: Condition[]) => list.filter((c) => c.op !== "in");
  const columnValueFilters = conditions.filter((c) => c.op === "in");
  const [draft, setDraft] = useState<Condition[]>(rowConditions(conditions));
  const [pending, startTransition] = useTransition();

  useEffect(() => setQ(params.get("q") ?? ""), [params]);
  useEffect(() => setDraft(rowConditions(conditions)), [conditions]);

  /** Updates some URL params and always goes back to page 1. */
  function go(changes: Record<string, string | null>) {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(changes)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    next.delete("page");
    startTransition(() => router.push(next.size ? `${pathname}?${next}` : pathname));
  }

  const fieldById = new Map(fields.map((f) => [f.id, f]));
  const range = params.get("range");
  const hasFilters = ["q", "range", "f", "sort"].some((k) => params.has(k));

  /** Removes search, date range, advanced conditions and sorting; keeps the selected client. */
  function clearFilters() {
    setQ("");
    setDraft([]);
    setOpen(false);
    go({ q: null, range: null, f: null, sort: null, dir: null });
  }

  function setCondition(i: number, patch: Partial<Condition>) {
    setDraft((d) => d.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  }

  function changeField(i: number, fieldId: string) {
    const f = fieldById.get(fieldId);
    setCondition(i, { field: fieldId, op: f ? OPS[f.kind][0].op : "contains", value: "" });
  }

  /** Saves advanced-panel rows; column "filter by values" conditions are kept unless removed. */
  function apply(list: Condition[], keep: Condition[] = columnValueFilters) {
    const valid = list.filter((c) => {
      if (c.op === "in") return true;
      const f = fieldById.get(c.field);
      const op = f && OPS[f.kind].find((o) => o.op === c.op);
      return op && (!op.needsValue || (c.value ?? "").trim());
    });
    const all = [...valid.filter((c) => c.op !== "in"), ...keep];
    go({ f: all.length ? JSON.stringify(all) : null });
    setOpen(false);
  }

  const addRow = () => {
    const first = fields[0];
    if (first) setDraft((d) => [...d, { field: first.id, op: OPS[first.kind][0].op, value: "" }]);
  };

  const groups = ["Lead", "Form", "Tracking"] as const;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {clients.length > 0 && (
          <div className="w-full sm:w-56">
            <Select
              aria-label="Client"
              value={params.get("client") ?? ""}
              // Fields differ per client, so advanced conditions and sorting reset when the client changes.
              onChange={(e) => go({ client: e.target.value || null, f: null, sort: null, dir: null })}
            >
              <option value="">All clients</option>
              {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </div>
        )}
        <form
          role="search"
          className="relative w-full sm:w-80"
          onSubmit={(e) => {
            e.preventDefault();
            go({ q: q.trim() || null });
          }}
        >
          <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
          <Input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name, phone, email, answers…"
            aria-label="Search leads"
            className="pl-9"
            enterKeyHint="search"
          />
        </form>
        <Button
          type="button"
          variant={conditions.length ? "primary" : "secondary"}
          size="sm"
          className="h-9"
          onClick={() => {
            if (!open && draft.length === 0) addRow();
            setOpen(!open);
          }}
          aria-expanded={open}
        >
          <SlidersHorizontal aria-hidden /> Advanced filter{conditions.length ? ` (${conditions.length})` : ""}
        </Button>
        {hasFilters && (
          <Button type="button" variant="ghost" size="sm" className="h-9" onClick={clearFilters}>
            <X aria-hidden /> Clear filters
          </Button>
        )}
        {pending && (
          <span className="flex items-center gap-1.5 text-sm text-ink-muted" role="status">
            <Loader2 aria-hidden className="size-4 animate-spin" /> Updating…
          </span>
        )}
      </div>

      <div className="inline-flex max-w-full gap-0.5 overflow-x-auto rounded-lg bg-slate-100 p-1 [scrollbar-width:none]" role="group" aria-label="Date range">
        <button type="button" aria-pressed={!range} className={chip(!range)} onClick={() => go({ range: null })}>All time</button>
        {RANGES.map((r) => (
          <button key={r.id} type="button" aria-pressed={range === r.id} className={chip(range === r.id)} onClick={() => go({ range: r.id })}>
            {r.label}
          </button>
        ))}
      </div>

      {conditions.length > 0 && !open && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {conditions.map((c, i) => {
            const d = describeCondition(c, fieldById.get(c.field));
            const rest = conditions.filter((_, j) => j !== i);
            return (
              <span key={i} className="inline-flex max-w-full items-center gap-1 rounded-full bg-brand-50 px-3 py-1 text-brand-700">
                <strong className="font-medium">{d.field}</strong> {d.op} {d.value && <em className="truncate not-italic">{d.value}</em>}
                <button
                  type="button"
                  aria-label="Remove condition"
                  className="ml-1 text-brand-700/70 hover:text-brand-700"
                  onClick={() => apply(rowConditions(rest), rest.filter((x) => x.op === "in"))}
                >
                  ×
                </button>
              </span>
            );
          })}
          <button type="button" className="text-slate-500 hover:underline" onClick={() => apply([], [])}>Clear all</button>
        </div>
      )}

      {open && (
        <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
          <p className="mb-2 text-xs text-slate-500">
            Leads must match all conditions.
            {!fields.some((f) => f.group === "Form") && " Pick a client to filter by form fields too."}
          </p>
          <div className="space-y-2">
            {draft.map((c, i) => {
              const f = fieldById.get(c.field);
              const ops = f ? OPS[f.kind] : [];
              const needsValue = ops.find((o) => o.op === c.op)?.needsValue ?? false;
              return (
                <div key={i} className="flex flex-wrap items-center gap-2">
                  <div className="w-full sm:w-56">
                    <Select aria-label="Field" value={c.field} onChange={(e) => changeField(i, e.target.value)}>
                      {groups.map((g) => {
                        const inGroup = fields.filter((x) => x.group === g);
                        return inGroup.length ? (
                          <optgroup key={g} label={g === "Form" ? "Form fields" : g}>
                            {inGroup.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
                          </optgroup>
                        ) : null;
                      })}
                    </Select>
                  </div>
                  <div className="w-full sm:w-40">
                    <Select aria-label="Condition" value={c.op} onChange={(e) => setCondition(i, { op: e.target.value as Op })}>
                      {ops.map((o) => <option key={o.op} value={o.op}>{o.label}</option>)}
                    </Select>
                  </div>
                  {needsValue && (
                    <div className="w-full sm:w-56">
                      {f?.options?.length && (c.op === "is" || c.op === "is_not") ? (
                        <Select aria-label="Value" value={c.value ?? ""} onChange={(e) => setCondition(i, { value: e.target.value })}>
                          <option value="">Choose…</option>
                          {f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </Select>
                      ) : (
                        <Input
                          aria-label="Value"
                          type={f?.kind === "number" ? "number" : "text"}
                          value={c.value ?? ""}
                          onChange={(e) => setCondition(i, { value: e.target.value })}
                          onKeyDown={(e) => e.key === "Enter" && apply(draft)}
                        />
                      )}
                    </div>
                  )}
                  <button
                    type="button"
                    aria-label="Remove condition"
                    className="h-9 rounded-md px-2 text-slate-500 hover:bg-slate-200"
                    onClick={() => setDraft((d) => d.filter((_, j) => j !== i))}
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={addRow}>+ Add condition</Button>
            <span className="flex-1" />
            <Button type="button" variant="ghost" size="sm" onClick={() => { setDraft([]); apply([]); }}>Clear</Button>
            <Button type="button" size="sm" onClick={() => apply(draft)}>Apply</Button>
          </div>
        </div>
      )}
    </div>
  );
}
