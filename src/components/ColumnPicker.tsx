"use client";

import { Columns3 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { Button, buttonClass } from "@/components/ui";
import { ALWAYS_SHOWN, writeHiddenColumns } from "@/lib/hiddenColumns";

/** "Columns" button: tick the columns to show in the table. Unticked ones still show on the lead's page. */
export function ColumnPicker({ columns, hidden }: { columns: { id: string; header: string }[]; hidden: string[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [shown, setShown] = useState<Set<string>>(new Set());

  const hiddenCount = columns.filter((c) => hidden.includes(c.id)).length;

  function toggleOpen() {
    if (!open) {
      setShown(new Set(columns.filter((c) => !hidden.includes(c.id)).map((c) => c.id)));
      setSearch("");
    }
    setOpen(!open);
  }

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function apply() {
    // Columns of other clients that aren't in this view keep their setting.
    const inView = new Set(columns.map((c) => c.id));
    const others = hidden.filter((id) => !inView.has(id));
    writeHiddenColumns([...others, ...columns.filter((c) => !shown.has(c.id)).map((c) => c.id)]);
    setOpen(false);
    startTransition(() => router.refresh());
  }

  const toggle = (id: string) =>
    setShown((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const q = search.trim().toLowerCase();
  const list = columns.filter((c) => c.header.toLowerCase().includes(q));

  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={toggleOpen} aria-haspopup="dialog" aria-expanded={open} className={buttonClass("secondary", "sm")} disabled={pending}>
        <Columns3 aria-hidden /> Columns
        {hiddenCount > 0 && <span className="rounded-full bg-brand-50 px-1.5 text-xs font-semibold text-brand-700">{hiddenCount} hidden</span>}
      </button>
      {open && (
        <div role="dialog" aria-label="Choose columns" className="absolute right-0 top-full z-30 mt-1 flex max-h-[70vh] w-80 flex-col overflow-hidden rounded-lg border border-slate-200 bg-white text-sm shadow-xl">
          <div className="border-b border-slate-100 p-3">
            <p className="mb-2 text-xs text-ink-muted">Unticked columns are hidden from the table. You still see them when you open a lead.</p>
            <input
              aria-label="Search columns"
              placeholder="Search columns…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              autoFocus
              className="h-8 w-full rounded-md border border-slate-300 px-2 text-sm"
            />
            <div className="mt-2 flex gap-3 text-xs">
              <button type="button" className="font-medium text-brand-700 hover:underline" onClick={() => setShown(new Set(columns.map((c) => c.id)))}>Show all</button>
              <button type="button" className="font-medium text-brand-700 hover:underline" onClick={() => setShown(new Set(ALWAYS_SHOWN))}>Hide all</button>
              <span className="ml-auto text-ink-muted">{shown.size} of {columns.length} shown</span>
            </div>
          </div>
          <ul className="min-h-0 flex-1 overflow-y-auto py-1">
            {list.map((c) => {
              const locked = ALWAYS_SHOWN.has(c.id);
              return (
                <li key={c.id}>
                  <label className={`flex items-center gap-2 px-3 py-1.5 ${locked ? "text-ink-muted" : "cursor-pointer hover:bg-slate-50"}`}>
                    <input type="checkbox" checked={locked || shown.has(c.id)} disabled={locked} onChange={() => toggle(c.id)} className="h-4 w-4 accent-brand-700" />
                    <span className="truncate">{c.header}</span>
                    {locked && <span className="ml-auto text-xs">always shown</span>}
                  </label>
                </li>
              );
            })}
            {list.length === 0 && <li className="px-3 py-2 text-ink-muted">No column matches “{search}”.</li>}
          </ul>
          <div className="flex justify-end gap-2 border-t border-slate-100 p-2">
            <Button variant="ghost" size="sm" type="button" onClick={() => setOpen(false)}>Cancel</Button>
            <Button size="sm" type="button" onClick={apply}>Apply</Button>
          </div>
        </div>
      )}
    </div>
  );
}
