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

/** "Delete selected" bar; the row checkboxes belong to this form. */
export function BulkDeleteBar() {
  const { selected } = useSelection();
  return (
    <form
      id={FORM_ID}
      action={deleteLeadsAction}
      onSubmit={(e) => {
        if (!confirm(`Delete ${selected} lead${selected === 1 ? "" : "s"}? This cannot be undone.`)) e.preventDefault();
      }}
      className={selected ? "mb-3 flex items-center gap-3 rounded-md bg-red-50 px-3 py-2 text-sm" : "hidden"}
    >
      <span className="font-medium text-red-800">{selected} selected</span>
      <Button type="submit" variant="danger" size="sm">Delete selected</Button>
      <button
        type="button"
        className="text-slate-600 hover:underline"
        onClick={() => {
          boxes().forEach((b) => (b.checked = false));
          window.dispatchEvent(new Event(CHANGED));
        }}
      >
        Cancel
      </button>
    </form>
  );
}
