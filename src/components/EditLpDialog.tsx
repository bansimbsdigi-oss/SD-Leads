"use client";

import { useActionState, useEffect, useRef } from "react";
import { updateLpAction, type ActionState } from "@/app/actions";
import { Button, Input, Label, Select } from "@/components/ui";

type Lp = { id: string; name: string; lpKey: string; allowedDomains: string[]; status: "active" | "paused" };

/** "Edit" button in the landing pages table; opens a dialog to rename, change domains or pause. */
export function EditLpDialog({ lp }: { lp: Lp }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [state, action, pending] = useActionState<ActionState, FormData>(updateLpAction, undefined);

  useEffect(() => {
    if (state?.ok) dialog.current?.close();
  }, [state]);

  return (
    <>
      <Button type="button" variant="secondary" size="sm" onClick={() => dialog.current?.showModal()}>Edit</Button>
      <dialog
        ref={dialog}
        className="m-auto w-[min(440px,calc(100vw-32px))] rounded-lg text-left border border-slate-200 p-0 shadow-xl backdrop:bg-slate-900/40"
        onClick={(e) => e.target === dialog.current && dialog.current?.close()} // click outside closes
      >
        <form action={action} className="space-y-4 p-5" key={lp.id + lp.name + lp.status + lp.allowedDomains.join()}>
          <h2 className="text-base font-semibold">Edit landing page</h2>
          <input type="hidden" name="id" value={lp.id} />
          <div>
            <Label htmlFor={`name-${lp.id}`}>Name</Label>
            <Input id={`name-${lp.id}`} name="name" defaultValue={lp.name} required minLength={2} maxLength={120} />
          </div>
          <div>
            <Label htmlFor={`domains-${lp.id}`}>Allowed domains</Label>
            <Input id={`domains-${lp.id}`} name="domains" defaultValue={lp.allowedDomains.join(", ")} placeholder="ritu.com, www.ritu.com" />
            <p className="mt-1 text-xs text-slate-500">
              Needed for the lead.js snippet (other sites get 403). Webhook leads don&apos;t use this.
            </p>
          </div>
          <div>
            <Label htmlFor={`status-${lp.id}`}>Status</Label>
            <Select id={`status-${lp.id}`} name="status" defaultValue={lp.status}>
              <option value="active">Active: accepting leads</option>
              <option value="paused">Paused: new leads are rejected</option>
            </Select>
          </div>
          <div>
            <Label>LP key</Label>
            <p className="font-mono text-sm">{lp.lpKey}</p>
            <p className="mt-1 text-xs text-slate-500">Can&apos;t be changed: it&apos;s in the snippet and webhook links already on live pages.</p>
          </div>
          {state?.error && <p className="text-sm text-red-600">{state.error}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={() => dialog.current?.close()}>Cancel</Button>
            <Button type="submit" disabled={pending}>{pending ? "Saving…" : "Save"}</Button>
          </div>
        </form>
      </dialog>
    </>
  );
}
