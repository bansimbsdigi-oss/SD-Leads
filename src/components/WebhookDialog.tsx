"use client";

import { Plus, Trash2 } from "lucide-react";
import { useActionState, useEffect, useRef, useState } from "react";
import { saveWebhookAction, testWebhookAction, type ActionState } from "@/app/actions";
import { Button, Hint, Input, Label, Select } from "@/components/ui";
import { OPS, type Condition, type FieldMeta, type Op } from "@/lib/leadFilterSpec";

type Rule = { id: string; name: string; url: string; conditions: Condition[] };

/** Rows of field / condition / value, saved as JSON in a hidden input. */
function ConditionsEditor({ fields, initial }: { fields: FieldMeta[]; initial: Condition[] }) {
  const byId = new Map(fields.map((f) => [f.id, f]));
  const [rows, setRows] = useState<Condition[]>(initial.filter((c) => c.op !== "in" && byId.has(c.field)));
  const set = (i: number, patch: Partial<Condition>) => setRows((r) => r.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const add = () => {
    const f = fields[0];
    if (f) setRows((r) => [...r, { field: f.id, op: OPS[f.kind][0].op, value: "" }]);
  };
  const valid = rows.filter((c) => {
    const op = byId.get(c.field) && OPS[byId.get(c.field)!.kind].find((o) => o.op === c.op);
    return op && (!op.needsValue || (c.value ?? "").trim());
  });

  return (
    <div>
      <input type="hidden" name="conditions" value={JSON.stringify(valid)} />
      {rows.length === 0 ? (
        <p className="rounded-md bg-slate-50 px-3 py-2 text-sm text-ink-muted">Every new lead is sent. Add a condition to send only some.</p>
      ) : (
        <div className="space-y-2">
          {rows.map((c, i) => {
            const f = byId.get(c.field);
            const ops = f ? OPS[f.kind] : [];
            const needsValue = ops.find((o) => o.op === c.op)?.needsValue ?? false;
            return (
              <div key={i} className="flex flex-wrap items-center gap-2 rounded-md border border-line p-2">
                {i > 0 && <span className="w-full text-[11px] font-semibold uppercase tracking-wide text-ink-muted">and</span>}
                <Select
                  aria-label="Field"
                  className="min-w-0 flex-1 basis-40"
                  value={c.field}
                  onChange={(e) => {
                    const nf = byId.get(e.target.value);
                    set(i, { field: e.target.value, op: nf ? OPS[nf.kind][0].op : "contains", value: "" });
                  }}
                >
                  {(["Lead", "Form", "Tracking"] as const).map((g) => {
                    const inGroup = fields.filter((x) => x.group === g);
                    return inGroup.length ? (
                      <optgroup key={g} label={g === "Form" ? "Form fields" : g}>
                        {inGroup.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
                      </optgroup>
                    ) : null;
                  })}
                </Select>
                <Select aria-label="Condition" className="w-36" value={c.op} onChange={(e) => set(i, { op: e.target.value as Op })}>
                  {ops.map((o) => <option key={o.op} value={o.op}>{o.label}</option>)}
                </Select>
                {needsValue &&
                  (f?.options?.length && (c.op === "is" || c.op === "is_not") ? (
                    <Select aria-label="Value" className="min-w-0 flex-1 basis-32" value={c.value ?? ""} onChange={(e) => set(i, { value: e.target.value })}>
                      <option value="">Choose…</option>
                      {f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </Select>
                  ) : (
                    <Input
                      aria-label="Value"
                      className="min-w-0 flex-1 basis-32"
                      type={f?.kind === "number" ? "number" : "text"}
                      value={c.value ?? ""}
                      onChange={(e) => set(i, { value: e.target.value })}
                    />
                  ))}
                <button type="button" aria-label="Remove condition" onClick={() => setRows((r) => r.filter((_, j) => j !== i))} className="rounded-md p-2 text-ink-muted hover:bg-slate-100">
                  <Trash2 aria-hidden className="size-4" />
                </button>
              </div>
            );
          })}
        </div>
      )}
      <Button type="button" variant="ghost" size="sm" className="mt-2" onClick={add}><Plus aria-hidden /> Add condition</Button>
    </div>
  );
}

/** Add / edit dialog for one webhook rule. */
export function WebhookDialog({ clientId, fields, rule }: { clientId: string; fields: FieldMeta[]; rule?: Rule }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [state, action, pending] = useActionState<ActionState, FormData>(saveWebhookAction, undefined);
  const [openCount, setOpenCount] = useState(0);
  useEffect(() => {
    if (state?.ok) dialog.current?.close();
  }, [state]);

  return (
    <>
      <Button
        type="button"
        variant={rule ? "secondary" : "primary"}
        size="sm"
        onClick={() => {
          setOpenCount((n) => n + 1); // fresh form each time it opens
          dialog.current?.showModal();
        }}
      >
        {rule ? "Edit" : <><Plus aria-hidden /> Add webhook</>}
      </Button>
      <dialog
        ref={dialog}
        className="m-auto w-[min(600px,calc(100vw-32px))] rounded-xl border border-line p-0 text-left shadow-xl backdrop:bg-slate-900/40"
        onClick={(e) => e.target === dialog.current && dialog.current?.close()}
      >
        <form action={action} key={openCount} className="space-y-4 p-5">
          <div>
            <h2 className="text-base font-semibold">{rule ? "Edit webhook" : "Send leads to a webhook"}</h2>
            <p className="mt-0.5 text-sm text-ink-muted">In Pabbly, start a workflow with the <em>Webhook</em> trigger and paste its URL here.</p>
          </div>
          <input type="hidden" name="clientId" value={clientId} />
          <input type="hidden" name="id" value={rule?.id ?? ""} />
          <div>
            <Label htmlFor={`wh-name-${rule?.id ?? "new"}`}>Name</Label>
            <Input id={`wh-name-${rule?.id ?? "new"}`} name="name" defaultValue={rule?.name} placeholder="Pabbly – webinar leads" required minLength={2} maxLength={100} />
          </div>
          <div>
            <Label htmlFor={`wh-url-${rule?.id ?? "new"}`}>Webhook URL</Label>
            <Input id={`wh-url-${rule?.id ?? "new"}`} name="url" defaultValue={rule?.url} placeholder="https://connect.pabbly.com/workflow/sendwebhookdata/…" required type="url" className="font-mono text-[13px]" />
            <Hint>Stored encrypted. Must be a public https address.</Hint>
          </div>
          <div>
            <Label>Send a lead when it matches all of these</Label>
            <ConditionsEditor fields={fields} initial={rule?.conditions ?? []} />
          </div>
          {state?.error && <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-inset ring-red-200">{state.error}</p>}
          <div className="flex justify-end gap-2 border-t border-line pt-4">
            <Button type="button" variant="ghost" onClick={() => dialog.current?.close()}>Cancel</Button>
            <Button type="submit" disabled={pending}>{pending ? "Saving…" : rule ? "Save" : "Add webhook"}</Button>
          </div>
        </form>
      </dialog>
    </>
  );
}

/** Sends one test payload and shows what the webhook answered. */
export function TestWebhookButton({ id }: { id: string }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(testWebhookAction, undefined);
  return (
    <form action={action} className="contents">
      <input type="hidden" name="id" value={id} />
      <Button type="submit" variant="secondary" size="sm" disabled={pending}>{pending ? "Sending…" : "Send test"}</Button>
      {(state?.ok || state?.error) && (
        <p role="status" className={`w-full rounded-md px-3 py-2 text-xs ring-1 ring-inset ${state.ok ? "bg-emerald-50 text-emerald-800 ring-emerald-200" : "bg-red-50 text-red-700 ring-red-200"}`}>
          {state.ok ?? state.error}
        </p>
      )}
    </form>
  );
}

/** Delete with a confirmation, since the delivery log goes too. */
export function DeleteWebhookButton({ id, clientId, name, action }: { id: string; clientId: string; name: string; action: (fd: FormData) => Promise<void> }) {
  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (!confirm(`Delete the webhook “${name}”? Leads stop being sent to it and its delivery log is removed.`)) e.preventDefault();
      }}
    >
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="clientId" value={clientId} />
      <button type="submit" aria-label={`Delete ${name}`} title="Delete" className="rounded-md p-2 text-ink-muted hover:bg-red-50 hover:text-red-700">
        <Trash2 aria-hidden className="size-4" />
      </button>
    </form>
  );
}
