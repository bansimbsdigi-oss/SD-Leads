"use client";

import { AlertTriangle, Trash2 } from "lucide-react";
import { useActionState, useRef, useState } from "react";
import { deleteClientAction, type ActionState } from "@/app/actions";
import { Button, Input, Label } from "@/components/ui";

/** Permanent client delete; the button only unlocks once the client's name is typed. */
export function DeleteClientDialog({
  id,
  name,
  counts,
}: {
  id: string;
  name: string;
  counts: { landingPages: number; leads: number; users: number; webhooks: number };
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [typed, setTyped] = useState("");
  const [state, action, pending] = useActionState<ActionState, FormData>(deleteClientAction, undefined);
  const matches = typed.trim().toLowerCase() === name.trim().toLowerCase();
  const n = (v: number, one: string, many: string) => `${v.toLocaleString("en-IN")} ${v === 1 ? one : many}`;

  return (
    <>
      <Button type="button" variant="danger" size="sm" onClick={() => { setTyped(""); dialog.current?.showModal(); }}>
        <Trash2 aria-hidden /> Delete client
      </Button>
      <dialog
        ref={dialog}
        className="m-auto w-[min(480px,calc(100vw-32px))] rounded-xl border border-line p-0 text-left shadow-xl backdrop:bg-slate-900/40"
        onClick={(e) => e.target === dialog.current && !pending && dialog.current?.close()}
      >
        <form action={action} className="space-y-4 p-5">
          <input type="hidden" name="id" value={id} />
          <div className="flex gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-red-50 text-red-600">
              <AlertTriangle aria-hidden className="size-5" />
            </span>
            <div>
              <h2 className="text-base font-semibold">Delete {name}?</h2>
              <p className="mt-1 text-sm text-ink-muted">This permanently deletes the client and everything under it. It can&apos;t be undone.</p>
            </div>
          </div>
          <ul className="space-y-1 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-900">
            <li>• {n(counts.leads, "lead", "leads")} and their history</li>
            <li>• {n(counts.landingPages, "landing page", "landing pages")} and their form fields</li>
            <li>• {n(counts.users, "client login", "client logins")}</li>
            <li>• {n(counts.webhooks, "Pabbly / webhook rule", "Pabbly / webhook rules")}, and the client&apos;s webhook URL stops working</li>
          </ul>
          <p className="text-xs text-ink-muted">Need the leads? Export them as CSV from Leads first.</p>
          <div>
            <Label htmlFor={`confirm-${id}`}>Type <strong className="text-ink">{name}</strong> to confirm</Label>
            <Input id={`confirm-${id}`} name="confirmName" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
          </div>
          {state?.error && <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-inset ring-red-200">{state.error}</p>}
          <div className="flex justify-end gap-2 border-t border-line pt-4">
            <Button type="button" variant="ghost" disabled={pending} onClick={() => dialog.current?.close()}>Cancel</Button>
            <Button type="submit" variant="danger" disabled={!matches || pending}>{pending ? "Deleting…" : "Delete permanently"}</Button>
          </div>
        </form>
      </dialog>
    </>
  );
}
