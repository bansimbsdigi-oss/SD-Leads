"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui";
import { ALWAYS_SHOWN, readHiddenColumns, writeHiddenColumns } from "@/lib/hiddenColumns";
import { OPS, type Condition, type FieldMeta, type Op } from "@/lib/leadFilterSpec";

type Value = { value: string; label: string; count: number };

/**
 * Google Sheets-style column menu: sort A→Z / Z→A, filter by condition, filter by values.
 * `field` is null for sort-only columns (Created).
 */
export function ColumnHeader({
  columnId,
  label,
  field,
  sortDir,
  numeric = false,
  conditions = [],
}: {
  columnId: string;
  label: string;
  field: FieldMeta | null;
  sortDir: "asc" | "desc" | null;
  numeric?: boolean;
  conditions?: Condition[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [, startTransition] = useTransition();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; maxHeight: number } | null>(null);

  const own = useMemo(() => conditions.filter((c) => c.field === columnId), [conditions, columnId]);
  const ownIn = own.find((c) => c.op === "in");
  const ownCond = own.find((c) => c.op !== "in");
  const filtered = own.length > 0;

  // Menu state, reset each time it opens.
  const [values, setValues] = useState<Value[] | null>(null);
  const [meta, setMeta] = useState({ truncated: false, sampled: false });
  const [loadError, setLoadError] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [condOp, setCondOp] = useState<Op | "">("");
  const [condValue, setCondValue] = useState("");

  function open() {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const width = 300;
    setPos({
      top: r.bottom + 4,
      left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)),
      maxHeight: Math.max(240, window.innerHeight - r.bottom - 16),
    });
    setSearch("");
    setCondOp(ownCond?.op ?? "");
    setCondValue(ownCond?.value ?? "");
    setValues(null);
    setLoadError(false);
    if (!field) return;
    const qs = new URLSearchParams(params.toString());
    qs.set("field", columnId);
    fetch(`/api/leads/values?${qs}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((data: { values: Value[]; truncated: boolean; sampled: boolean }) => {
        setValues(data.values);
        setMeta({ truncated: data.truncated, sampled: data.sampled });
        setSelected(new Set(ownIn?.values ?? data.values.map((v) => v.value)));
      })
      .catch(() => setLoadError(true));
  }
  const close = () => setPos(null);

  useEffect(() => {
    if (!pos) return;
    const menu = () => document.getElementById(`colmenu-${columnId}`);
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node) && !menu()?.contains(e.target as Node)) setPos(null);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setPos(null);
    // The menu is fixed-position (the table scrolls sideways), so close it when anything else scrolls.
    const onScroll = (e: Event) => {
      if (!menu()?.contains(e.target as Node)) setPos(null);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [pos, columnId]);

  function navigate(changes: Record<string, string | null>) {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(changes)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    next.delete("page");
    close();
    startTransition(() => router.push(next.size ? `${pathname}?${next}` : pathname));
  }

  function hideColumn() {
    writeHiddenColumns([...readHiddenColumns(), columnId]);
    close();
    startTransition(() => router.refresh());
  }

  const withFilters = (list: Condition[]) => ({ f: list.length ? JSON.stringify(list) : null });

  function apply() {
    const others = conditions.filter((c) => c.field !== columnId);
    const mine: Condition[] = [];
    const opInfo = field && condOp ? OPS[field.kind].find((o) => o.op === condOp) : undefined;
    if (opInfo && (!opInfo.needsValue || condValue.trim())) mine.push({ field: columnId, op: opInfo.op, value: condValue.trim() || undefined });
    if (values) {
      const allTicked = values.every((v) => selected.has(v.value));
      if (!allTicked) mine.push({ field: columnId, op: "in", values: values.filter((v) => selected.has(v.value)).map((v) => v.value) });
    } else if (ownIn) {
      mine.push(ownIn); // list didn't load; keep the existing values filter
    }
    navigate(withFilters([...others, ...mine]));
  }

  const shown = values?.filter((v) => v.label.toLowerCase().includes(search.trim().toLowerCase())) ?? [];
  const toggle = (v: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(v)) n.delete(v);
      else n.add(v);
      return n;
    });
  const ops = field ? OPS[field.kind] : [];
  const needsValue = ops.find((o) => o.op === condOp)?.needsValue ?? false;
  const [asc, desc] = numeric ? ["Sort low → high", "Sort high → low"] : ["Sort A → Z", "Sort Z → A"];
  const menuItem = "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-slate-700 hover:bg-slate-100";

  return (
    <div ref={ref} className="inline-flex items-center">
      <button
        type="button"
        onClick={() => (pos ? close() : open())}
        aria-haspopup="dialog"
        aria-expanded={Boolean(pos)}
        className={`inline-flex items-center gap-1 rounded px-1 py-0.5 hover:bg-slate-100 ${sortDir || filtered ? "text-brand-700" : ""}`}
      >
        {label}
        {sortDir && <span aria-label={sortDir === "asc" ? "sorted ascending" : "sorted descending"} className="text-[10px]">{sortDir === "asc" ? "▲" : "▼"}</span>}
        <svg aria-hidden viewBox="0 0 16 16" className={`h-3.5 w-3.5 ${filtered ? "fill-brand-600" : "fill-slate-400"}`}>
          {filtered ? <path d="M1.5 2h13l-5 6.2V14l-3-1.6V8.2z" /> : <path d="M4 6l4 4 4-4z" />}
        </svg>
      </button>

      {/* Rendered on <body>: the sticky, blurred header cell would otherwise become the fixed menu's
          containing block and push it away from the column. */}
      {pos &&
        createPortal(
        <div
          id={`colmenu-${columnId}`}
          role="dialog"
          aria-label={`${label} sort and filter`}
          style={{ top: pos.top, left: pos.left, maxHeight: pos.maxHeight }}
          className="fixed z-30 flex w-[300px] flex-col overflow-hidden rounded-lg border border-slate-200 bg-white text-left font-normal normal-case text-slate-700 shadow-xl"
        >
          <div className="border-b border-slate-100 py-1">
            <button type="button" className={menuItem} onClick={() => navigate({ sort: columnId, dir: "asc" })}>
              {asc} {sortDir === "asc" && <span className="ml-auto text-brand-700">✓</span>}
            </button>
            <button type="button" className={menuItem} onClick={() => navigate({ sort: columnId, dir: "desc" })}>
              {desc} {sortDir === "desc" && <span className="ml-auto text-brand-700">✓</span>}
            </button>
            {sortDir && (
              <button type="button" className={`${menuItem} text-slate-500`} onClick={() => navigate({ sort: null, dir: null })}>Remove sort</button>
            )}
            {!ALWAYS_SHOWN.has(columnId) && (
              <button type="button" className={menuItem} onClick={hideColumn}>Hide column</button>
            )}
          </div>

          {field && (
            <>
              <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
                <details open={Boolean(ownCond)} className="mb-2">
                  <summary className="cursor-pointer py-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Filter by condition</summary>
                  <div className="mt-1 space-y-2">
                    <select
                      aria-label="Condition"
                      value={condOp}
                      onChange={(e) => setCondOp(e.target.value as Op | "")}
                      className="h-8 w-full rounded-md border border-slate-300 bg-white px-2 text-sm"
                    >
                      <option value="">None</option>
                      {ops.map((o) => <option key={o.op} value={o.op}>{o.label}</option>)}
                    </select>
                    {condOp && needsValue && (
                      <input
                        aria-label="Condition value"
                        type={field.kind === "number" ? "number" : "text"}
                        value={condValue}
                        onChange={(e) => setCondValue(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && apply()}
                        placeholder="Value"
                        className="h-8 w-full rounded-md border border-slate-300 px-2 text-sm"
                      />
                    )}
                  </div>
                </details>

                <details open>
                  <summary className="cursor-pointer py-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Filter by values</summary>
                  {loadError ? (
                    <p className="py-2 text-sm text-red-600">Couldn’t load values.</p>
                  ) : !values ? (
                    <p className="py-2 text-sm text-slate-500">Loading values…</p>
                  ) : (
                    <div className="mt-1">
                      <div className="mb-1 flex items-center gap-3 text-xs">
                        <button type="button" className="text-brand-700 hover:underline" onClick={() => setSelected(new Set([...selected, ...shown.map((v) => v.value)]))}>
                          Select all{search ? " shown" : ""}
                        </button>
                        <button
                          type="button"
                          className="text-brand-700 hover:underline"
                          onClick={() => setSelected((s) => new Set([...s].filter((v) => !shown.some((x) => x.value === v))))}
                        >
                          Clear{search ? " shown" : ""}
                        </button>
                        <span className="ml-auto text-slate-400">{values.filter((v) => selected.has(v.value)).length}/{values.length}</span>
                      </div>
                      <input
                        type="search"
                        aria-label="Search values"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="Search values"
                        className="mb-1 h-8 w-full rounded-md border border-slate-300 px-2 text-sm"
                      />
                      <ul className="max-h-56 overflow-y-auto rounded border border-slate-100">
                        {shown.length === 0 && <li className="px-2 py-2 text-sm text-slate-500">No values</li>}
                        {shown.map((v) => (
                          <li key={v.value}>
                            <label className="flex cursor-pointer items-center gap-2 px-2 py-1 text-sm hover:bg-slate-50">
                              <input type="checkbox" className="h-4 w-4" checked={selected.has(v.value)} onChange={() => toggle(v.value)} />
                              <span className={`min-w-0 flex-1 truncate ${v.value === "" ? "italic text-slate-500" : ""}`} title={v.label}>{v.label}</span>
                              <span className="text-xs text-slate-400">{v.count.toLocaleString("en-IN")}</span>
                            </label>
                          </li>
                        ))}
                      </ul>
                      {(meta.truncated || meta.sampled) && (
                        <p className="mt-1 text-xs text-slate-400">
                          {meta.truncated ? "Showing the first 500 values. " : ""}
                          {meta.sampled ? "Counts from the newest 50,000 matching leads." : ""}
                        </p>
                      )}
                    </div>
                  )}
                </details>
              </div>

              <div className="flex items-center gap-2 border-t border-slate-100 px-3 py-2">
                {filtered && (
                  <button type="button" className="text-sm text-slate-500 hover:underline" onClick={() => navigate(withFilters(conditions.filter((c) => c.field !== columnId)))}>
                    Clear filter
                  </button>
                )}
                <span className="flex-1" />
                <Button type="button" variant="ghost" size="sm" onClick={close}>Cancel</Button>
                <Button type="button" size="sm" onClick={apply}>OK</Button>
              </div>
            </>
          )}
        </div>,
          document.body,
        )}
    </div>
  );
}
