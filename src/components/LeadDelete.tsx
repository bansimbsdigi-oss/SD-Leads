"use client";

import { Archive, ArchiveRestore, RotateCcw, Tag, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import {
  archiveLeadsAction,
  assignLeadsAction,
  bulkTagAction,
  deleteLeadAction,
  deleteLeadsAction,
  emptyTrashAction,
  purgeLeadAction,
  restoreLeadsAction,
  setLeadStatusAction,
} from "@/app/actions";
import { Button } from "@/components/ui";

const FORM_ID = "bulk-delete";
const boxes = () => [...document.querySelectorAll<HTMLInputElement>(`input[name="ids"][form="${FORM_ID}"]`)];
const CHANGED = "lead-selection";

/** Delete button on the lead page: moves the lead to Trash (restorable). */
export function DeleteLeadButton({ id }: { id: string }) {
  return (
    <form action={deleteLeadAction}>
      <input type="hidden" name="id" value={id} />
      <Button type="submit" variant="danger" size="sm"><Trash2 aria-hidden /> Move to trash</Button>
    </form>
  );
}

/** On a lead that's in Trash or Archived: put it back, or (Trash) delete it for good. */
export function LeadBinActions({ id, state, canDelete }: { id: string; state: "trash" | "archived"; canDelete: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const go = (act: () => Promise<{ error?: string }>) =>
    startTransition(async () => {
      const r = await act();
      if (r?.error) alert(r.error);
      router.refresh();
    });
  return (
    <span className="flex flex-wrap gap-2">
      {state === "trash" ? (
        <>
          {canDelete && <Button size="sm" disabled={pending} onClick={() => go(() => restoreLeadsAction([id]))}><RotateCcw aria-hidden /> Restore</Button>}
          {canDelete && (
            <Button size="sm" variant="danger" disabled={pending} onClick={() => {
              if (confirm("Delete this lead for good? It can't be brought back.")) go(() => purgeLeadAction(id));
            }}>
              <Trash2 aria-hidden /> Delete forever
            </Button>
          )}
        </>
      ) : (
        <Button size="sm" disabled={pending} onClick={() => go(() => archiveLeadsAction([id], false))}><ArchiveRestore aria-hidden /> Unarchive</Button>
      )}
    </span>
  );
}

/** "Empty trash" on the Trash tab: deletes every lead in it for good. */
export function EmptyTrashButton({ clientId, count }: { clientId: string | null; count: number }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <Button size="sm" variant="danger" disabled={pending} onClick={() => {
      const typed = prompt(`Delete all ${count.toLocaleString("en-IN")} leads in Trash for good? They can't be brought back.\n\nType DELETE to confirm.`);
      if (typed?.trim().toUpperCase() !== "DELETE") return;
      startTransition(async () => {
        const r = await emptyTrashAction(clientId);
        if (r.error) alert(r.error);
        router.refresh();
      });
    }}>
      <Trash2 aria-hidden /> {pending ? "Emptying…" : "Empty trash"}
    </Button>
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

type Option = { id: string; name: string };

/**
 * Bar for the ticked leads: set status, assign, tag, delete. The row checkboxes belong to its form.
 * With every row on the page ticked it offers to select all `total` leads matching the filters, on every
 * page, for deleting (`query` is the list's filters, `upto` when the list was loaded). `stages` / `owners`
 * are set when the page shows one client (statuses and people differ per client).
 */
export function BulkDeleteBar({
  total,
  capped,
  query,
  upto,
  stages,
  owners,
  canDelete,
  view,
  canArchive,
}: {
  total: number;
  capped: boolean;
  query: string;
  upto: string;
  stages: Option[] | null;
  owners: Option[] | null;
  canDelete: boolean;
  /** Which list the bar is on: the main list (null), Archived or Trash. */
  view: "archived" | "trash" | null;
  canArchive: boolean;
}) {
  const router = useRouter();
  const { selected, total: onPage } = useSelection();
  const [allPages, setAllPages] = useState(false);
  const [tag, setTag] = useState("");
  const [pending, startTransition] = useTransition();
  const [note, setNote] = useState<string | null>(null);
  const pageFull = onPage > 0 && selected === onPage;
  const all = allPages && pageFull; // unticking a row goes back to "this page only"
  const totalLabel = `${total.toLocaleString("en-IN")}${capped ? "+" : ""}`;
  const count = all ? totalLabel : String(selected);

  function clear() {
    boxes().forEach((b) => (b.checked = false));
    setAllPages(false);
    window.dispatchEvent(new Event(CHANGED));
  }

  /** Runs a change on the ticked leads, then reloads the list. */
  function run(label: string, act: (ids: string[]) => Promise<{ error?: string; count?: number }>) {
    const ids = boxes().filter((b) => b.checked).map((b) => b.value);
    if (!ids.length) return;
    startTransition(async () => {
      const r = await act(ids);
      if (r.error) {
        alert(r.error);
        return;
      }
      setNote(`${label}: ${r.count ?? 0} lead${r.count === 1 ? "" : "s"} updated.`);
      clear();
      router.refresh();
    });
  }
  const select = "h-8 rounded-md border border-line bg-surface px-2 text-sm text-ink";

  return (
    <form
      id={FORM_ID}
      action={deleteLeadsAction}
      onSubmit={(e) => {
        const ok = view === "trash"
          ? confirm(`Delete ${selected} lead${selected === 1 ? "" : "s"} for good? They can't be brought back.`)
          : all
          ? prompt(`Move ALL ${totalLabel} leads matching the current filters, on every page, to Trash? You can restore them from Trash.\n\nType DELETE to confirm.`)?.trim().toUpperCase() === "DELETE"
          : confirm(`Move ${selected} lead${selected === 1 ? "" : "s"} to Trash? You can restore ${selected === 1 ? "it" : "them"} from Trash.`);
        if (!ok) e.preventDefault();
      }}
      className={selected ? "mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-brand-50 px-3 py-2 text-sm ring-1 ring-brand-200" : note ? "mb-3 block" : "hidden"}
    >
      {!selected && note && <p role="status" className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800 ring-1 ring-emerald-200">{note}</p>}
      {all && (
        <>
          <input type="hidden" name="all" value="1" />
          <input type="hidden" name="query" value={query} />
          <input type="hidden" name="upto" value={upto} />
        </>
      )}
      {selected > 0 && <span className="font-semibold text-brand-800">{count} selected</span>}
      {view === "trash" && <input type="hidden" name="mode" value="purge" />}
      {selected > 0 && view === "trash" && canDelete && (
        <Button type="button" size="sm" disabled={pending} onClick={() => run("Restored", (ids) => restoreLeadsAction(ids))}>
          <RotateCcw aria-hidden /> Restore
        </Button>
      )}
      {selected > 0 && view === "archived" && canArchive && (
        <Button type="button" size="sm" disabled={pending} onClick={() => run("Unarchived", (ids) => archiveLeadsAction(ids, false))}>
          <ArchiveRestore aria-hidden /> Unarchive
        </Button>
      )}
      {selected > 0 && !all && view === null && (
        <>
          {stages && (
            <select aria-label="Set status" className={select} value="" disabled={pending} onChange={(e) => {
              const v = e.target.value;
              if (v) run("Status set", (ids) => setLeadStatusAction(ids, v === "__none" ? null : v));
            }}>
              <option value="">Set status…</option>
              {stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              <option value="__none">No status</option>
            </select>
          )}
          {owners && (
            <select aria-label="Assign to" className={select} value="" disabled={pending} onChange={(e) => {
              const v = e.target.value;
              if (v) run("Assigned", (ids) => assignLeadsAction(ids, v === "__none" ? null : v));
            }}>
              <option value="">Assign to…</option>
              {owners.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
              <option value="__none">Unassigned</option>
            </select>
          )}
          <span className="inline-flex items-center gap-1">
            <input
              aria-label="Tag to add"
              value={tag}
              onChange={(e) => setTag(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (tag.trim()) run(`Tagged “${tag.trim()}”`, (ids) => bulkTagAction(ids, tag));
                  setTag("");
                }
              }}
              placeholder="Tag, e.g. VIP"
              maxLength={40}
              className={`${select} w-32`}
            />
            <Button type="button" variant="secondary" size="sm" disabled={pending || !tag.trim()} onClick={() => {
              run(`Tagged “${tag.trim()}”`, (ids) => bulkTagAction(ids, tag));
              setTag("");
            }}>
              <Tag aria-hidden /> Add tag
            </Button>
          </span>
          {canArchive && (
            <Button type="button" variant="secondary" size="sm" disabled={pending} onClick={() => run("Archived", (ids) => archiveLeadsAction(ids, true))}>
              <Archive aria-hidden /> Archive
            </Button>
          )}
          {!stages && <span className="text-xs text-ink-muted">Pick one client to change status or owner in bulk.</span>}
        </>
      )}
      {selected > 0 && canDelete && <Button type="submit" variant="danger" size="sm" disabled={pending}><Trash2 aria-hidden /> {view === "trash" ? "Delete forever" : all ? `Move all ${totalLabel} to trash` : "Delete"}</Button>}
      {selected > 0 && <button type="button" className="text-ink-muted hover:underline" onClick={clear}>Cancel</button>}
      {canDelete && view !== "trash" && pageFull && total > onPage && (
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
