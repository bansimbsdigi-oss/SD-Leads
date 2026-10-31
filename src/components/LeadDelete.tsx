"use client";

import { useEffect, useState } from "react";
import { deleteLeadAction, deleteLeadsAction } from "@/app/actions";
import { Button } from "@/components/ui";

const FORM_ID = "bulk-delete";
const boxes = () => [...document.querySelectorAll<HTMLInputElement>(`input[name="ids"][form="${FORM_ID}"]`)];
const CHANGED = "lead-selection";

/** Delete button on the lead page. */
export function DeleteLeadButton({ id, name }: { id: string; name: string }) {
  return (
    <form
      action={deleteLeadAction}
      onSubmit={(e) => {
        if (!confirm(`Delete ${name || "this lead"}? This cannot be undone.`)) e.preventDefault();
      }}
    >
      <input type="hidden" name="id" value={id} />
      <Button type="submit" variant="danger" size="sm">Delete lead</Button>
    </form>
  );
}

/** Row checkbox in the leads table. */
export function RowCheckbox({ id, label }: { id: string; label: string }) {
  return (
    <input
      type="checkbox"
      name="ids"
      value={id}
      form={FORM_ID}
      aria-label={`Select ${label}`}
      className="h-4 w-4 align-middle"
      onChange={() => window.dispatchEvent(new Event(CHANGED))}
    />
  );
}

function useSelection() {
  const [state, setState] = useState({ selected: 0, total: 0 });
  useEffect(() => {
    // Re-counted after every render (rows change on navigation); only set state when the count changed.
    const update = () => {
      const all = boxes();
      const next = { selected: all.filter((b) => b.checked).length, total: all.length };
      setState((prev) => (prev.selected === next.selected && prev.total === next.total ? prev : next));
    };
    update();
    window.addEventListener(CHANGED, update);
    return () => window.removeEventListener(CHANGED, update);
  });
  return state;
}

/** Header checkbox: select / clear every row on this page. */
export function SelectAllCheckbox() {
  const { selected, total } = useSelection();
  return (
    <input
      type="checkbox"
      aria-label="Select all on this page"
      className="h-4 w-4 align-middle"
      checked={total > 0 && selected === total}
      ref={(el) => {
        if (el) el.indeterminate = selected > 0 && selected < total;
      }}
      onChange={(e) => {
        boxes().forEach((b) => (b.checked = e.target.checked));
        window.dispatchEvent(new Event(CHANGED));
      }}
    />
  );
}

/**
 * "Delete selected" bar; the row checkboxes belong to this form. With every row on the page ticked it
 * offers to select all `total` leads matching the filters, on every page (`query` is the list's filters,
 * `upto` when the list was loaded).
 */
export function BulkDeleteBar({ total, capped, query, upto }: { total: number; capped: boolean; query: string; upto: string }) {
  const { selected, total: onPage } = useSelection();
  const [allPages, setAllPages] = useState(false);
  const pageFull = onPage > 0 && selected === onPage;
  const all = allPages && pageFull; // unticking a row goes back to "this page only"
  const totalLabel = `${total.toLocaleString("en-IN")}${capped ? "+" : ""}`;
  const count = all ? totalLabel : String(selected);

  function clear() {
    boxes().forEach((b) => (b.checked = false));
    setAllPages(false);
    window.dispatchEvent(new Event(CHANGED));
  }

  return (
    <form
      id={FORM_ID}
      action={deleteLeadsAction}
      onSubmit={(e) => {
        const ok = all
          ? prompt(`Delete ALL ${totalLabel} leads matching the current filters, on every page? This cannot be undone.\n\nType DELETE to confirm.`)?.trim().toUpperCase() === "DELETE"
          : confirm(`Delete ${selected} lead${selected === 1 ? "" : "s"}? This cannot be undone.`);
        if (!ok) e.preventDefault();
      }}
      className={selected ? "mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-red-50 px-3 py-2 text-sm" : "hidden"}
    >
      {all && (
        <>
          <input type="hidden" name="all" value="1" />
          <input type="hidden" name="query" value={query} />
          <input type="hidden" name="upto" value={upto} />
        </>
      )}
      <span className="font-medium text-red-800">{count} selected</span>
      <Button type="submit" variant="danger" size="sm">{all ? `Delete all ${totalLabel}` : "Delete selected"}</Button>
      <button type="button" className="text-slate-600 hover:underline" onClick={clear}>Cancel</button>
      {pageFull && total > onPage && (
        <span className="text-slate-700">
          {all ? `All ${totalLabel} leads matching these filters are selected.` : `All ${onPage} leads on this page are selected.`}{" "}
          <button type="button" className="font-medium text-brand-700 hover:underline" onClick={() => setAllPages(!all)}>
            {all ? "Select only this page" : `Select all ${totalLabel} leads`}
          </button>
        </span>
      )}
    </form>
  );
}
