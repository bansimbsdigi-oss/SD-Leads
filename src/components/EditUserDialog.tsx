"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { updateUserAction, type ActionState } from "@/app/actions";
import { Button, Input, Label, Select } from "@/components/ui";

export type EditableUser = {
  id: string;
  name: string;
  email: string;
  role: string;
  status: "active" | "disabled";
  managedClientIds: string[];
  lpIds: string[];
};

/** "Edit" button in a users table: name, email, role, access, active/disabled and an optional new password. */
export function EditUserDialog({
  user,
  roles,
  clients = [],
  lps = [],
  isSelf = false,
}: {
  user: EditableUser;
  roles: { value: string; label: string }[];
  /** Staff logins: clients an account manager can be assigned to. */
  clients?: { id: string; name: string }[];
  /** Client logins: landing pages a member can be given. */
  lps?: { id: string; name: string }[];
  isSelf?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [state, action, pending] = useActionState<ActionState, FormData>(updateUserAction, undefined);
  const [role, setRole] = useState(user.role);
  const [formKey, setFormKey] = useState(0);

  useEffect(() => {
    if (state?.ok) dialog.current?.close();
  }, [state]);

  function open() {
    setRole(user.role);
    setFormKey((k) => k + 1); // fresh form with the saved values each time
    dialog.current?.showModal();
  }

  const id = (name: string) => `${name}-${user.id}`;
  const checkList = "max-h-40 space-y-0.5 overflow-y-auto rounded-md border border-line p-1.5 text-sm";
  const checkRow = "flex items-center gap-2 rounded px-1.5 py-1 hover:bg-slate-50";

  return (
    <>
      <Button type="button" variant="secondary" size="sm" onClick={open}>Edit</Button>
      <dialog
        ref={dialog}
        className="m-auto w-[min(460px,calc(100vw-32px))] rounded-lg border border-slate-200 p-0 text-left shadow-xl backdrop:bg-slate-900/40"
        onClick={(e) => e.target === dialog.current && dialog.current?.close()} // click outside closes
      >
        <form action={action} className="max-h-[85vh] space-y-4 overflow-y-auto p-5" key={formKey}>
          <h2 className="text-base font-semibold">Edit {user.name}</h2>
          <input type="hidden" name="id" value={user.id} />
          <div><Label htmlFor={id("name")}>Name</Label><Input id={id("name")} name="name" defaultValue={user.name} required minLength={2} maxLength={100} /></div>
          <div><Label htmlFor={id("email")}>Email</Label><Input id={id("email")} name="email" type="email" defaultValue={user.email} required /></div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor={id("role")}>Role</Label>
              {/* Your own role can't change: a disabled select isn't submitted, so send it hidden. */}
              {isSelf && <input type="hidden" name="role" value={user.role} />}
              <Select id={id("role")} name={isSelf ? undefined : "role"} value={role} onChange={(e) => setRole(e.target.value)} disabled={isSelf}>
                {roles.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
              </Select>
            </div>
            <div>
              <Label htmlFor={id("status")}>Login</Label>
              {isSelf && <input type="hidden" name="status" value="active" />}
              <Select id={id("status")} name={isSelf ? undefined : "status"} defaultValue={user.status} disabled={isSelf}>
                <option value="active">Active</option>
                <option value="disabled">Disabled: can&apos;t sign in</option>
              </Select>
            </div>
          </div>
          {isSelf && <p className="-mt-2 text-xs text-ink-muted">You can&apos;t change your own role or disable yourself.</p>}

          {role === "ACCOUNT_MANAGER" && clients.length > 0 && (
            <div>
              <Label>Assigned clients</Label>
              <div className={checkList}>
                {clients.map((c) => (
                  <label key={c.id} className={checkRow}>
                    <input className="size-4" type="checkbox" name="managedClientIds" value={c.id} defaultChecked={user.managedClientIds.includes(c.id)} /> {c.name}
                  </label>
                ))}
              </div>
            </div>
          )}
          {role === "CLIENT_MEMBER" && lps.length > 0 && (
            <div>
              <Label>LP access (leave empty for own leads only)</Label>
              <div className={checkList}>
                {lps.map((lp) => (
                  <label key={lp.id} className={checkRow}>
                    <input className="size-4" type="checkbox" name="lpIds" value={lp.id} defaultChecked={user.lpIds.includes(lp.id)} /> {lp.name}
                  </label>
                ))}
              </div>
            </div>
          )}

          <div>
            <Label htmlFor={id("password")}>New password</Label>
            <Input id={id("password")} name="password" type="text" minLength={10} autoComplete="off" placeholder="Leave blank to keep the current one" />
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
