"use client";

import { Pencil, Plus, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import { addNoteAction, clearJunkAction, editLeadAction, setLeadTagsAction, type ActionState } from "@/app/actions";
import { LeadInlineSelect } from "@/components/LeadInlineSelect";
import { Button, Field, Input, Label } from "@/components/ui";

type Option = { id: string; name: string };
type Lead = { id: string; statusId: string | null; ownerId: string | null; ownerName: string | null; tags: string[]; name: string | null; phone: string | null; email: string | null };

/** Right-hand panel on a lead: status, owner, tags, edit contact details, add a note. */
export function LeadManage({ lead, stages, owners, suggestions }: { lead: Lead; stages: Option[]; owners: Option[] | null; suggestions: string[] }) {
  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-1">
        <div>
          <Label>Status</Label>
          <LeadInlineSelect leadId={lead.id} kind="status" value={lead.statusId} options={stages} className="-ml-1" />
        </div>
        <div>
          <Label>Owner</Label>
          {owners ? (
            <LeadInlineSelect leadId={lead.id} kind="owner" value={lead.ownerId} options={owners} className="-ml-1" />
          ) : (
            <p className="text-sm">{lead.ownerName ?? <span className="text-ink-muted">Unassigned</span>}</p>
          )}
        </div>
      </div>
      <TagEditor leadId={lead.id} tags={lead.tags} suggestions={suggestions} />
      <EditDetails lead={lead} />
      <NoteForm leadId={lead.id} />
    </div>
  );
}

/** "Not junk" on a flagged lead. */
export function NotJunkButton({ id }: { id: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <Button type="button" variant="secondary" size="sm" disabled={pending} onClick={() => startTransition(async () => {
      const r = await clearJunkAction(id);
      if (r.error) alert(r.error);
      router.refresh();
    })}>
      It&apos;s a real lead
    </Button>
  );
}

function TagEditor({ leadId, tags, suggestions }: { leadId: string; tags: string[]; suggestions: string[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [draft, setDraft] = useState("");
  const save = (next: string[]) =>
    startTransition(async () => {
      const r = await setLeadTagsAction(leadId, next);
      if (r.error) alert(r.error);
      router.refresh();
    });
  const add = () => {
    const t = draft.trim();
    setDraft("");
    if (t && !tags.some((x) => x.toLowerCase() === t.toLowerCase())) save([...tags, t]);
  };
  const listId = `tags-${leadId}`;
  return (
    <div className={pending ? "opacity-60" : undefined}>
      <Label htmlFor={`tag-input-${leadId}`}>Tags</Label>
      <div className="flex flex-wrap items-center gap-1.5">
        {tags.map((t) => (
          <span key={t} className="inline-flex items-center gap-1 rounded-full bg-brand-50 py-0.5 pl-2.5 pr-1 text-xs font-medium text-brand-800 ring-1 ring-inset ring-brand-200">
            {t}
            <button type="button" aria-label={`Remove tag ${t}`} disabled={pending} onClick={() => save(tags.filter((x) => x !== t))} className="rounded-full p-0.5 hover:bg-brand-100">
              <X aria-hidden className="size-3" />
            </button>
          </span>
        ))}
        <span className="inline-flex items-center gap-1">
          <input
            id={`tag-input-${leadId}`}
            list={listId}
            value={draft}
            maxLength={40}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
            placeholder={tags.length ? "Add tag" : "VIP, Paid, No answer…"}
            className="h-7 w-36 rounded-md border border-line bg-surface px-2 text-xs text-ink placeholder:text-slate-400 focus:border-brand-600 focus:outline-none"
          />
          <button type="button" aria-label="Add tag" disabled={pending || !draft.trim()} onClick={add} className="rounded-md p-1 text-ink-muted hover:bg-slate-100 hover:text-ink disabled:opacity-40">
            <Plus aria-hidden className="size-4" />
          </button>
        </span>
        <datalist id={listId}>{suggestions.filter((s) => !tags.includes(s)).map((s) => <option key={s} value={s} />)}</datalist>
      </div>
    </div>
  );
}

function EditDetails({ lead }: { lead: Lead }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [state, action, pending] = useActionState<ActionState, FormData>(editLeadAction, undefined);
  const [formKey, setFormKey] = useState(0);
  useEffect(() => {
    if (state?.ok) dialog.current?.close();
  }, [state]);
  return (
    <>
      <Button type="button" variant="secondary" size="sm" className="w-full" onClick={() => { setFormKey((k) => k + 1); dialog.current?.showModal(); }}>
        <Pencil aria-hidden /> Edit name, phone or email
      </Button>
      <dialog
        ref={dialog}
        className="m-auto w-[min(440px,calc(100vw-32px))] rounded-lg border border-line p-0 text-left shadow-xl backdrop:bg-slate-900/40"
        onClick={(e) => e.target === dialog.current && dialog.current?.close()}
      >
        <form action={action} key={formKey} className="space-y-4 p-5">
          <h2 className="text-base font-semibold">Edit lead details</h2>
          <input type="hidden" name="id" value={lead.id} />
          <Field label="Name" htmlFor={`e-name-${lead.id}`}><Input id={`e-name-${lead.id}`} name="name" defaultValue={lead.name ?? ""} maxLength={200} /></Field>
          <Field label="Mobile" htmlFor={`e-phone-${lead.id}`} hint="With country code if not Indian, e.g. +44 7700 900123.">
            <Input id={`e-phone-${lead.id}`} name="phone" defaultValue={lead.phone ?? ""} inputMode="tel" />
          </Field>
          <Field label="Email" htmlFor={`e-email-${lead.id}`}><Input id={`e-email-${lead.id}`} name="email" type="email" defaultValue={lead.email ?? ""} /></Field>
          <p className="text-xs text-ink-muted">The original form answers stay as they were; the change is noted on the timeline.</p>
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

function NoteForm({ leadId }: { leadId: string }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(addNoteAction, undefined);
  return (
    <form action={action} key={state?.ok ? `${state.ok}-${Date.now()}` : "note"} className="space-y-2">
      <input type="hidden" name="id" value={leadId} />
      <Label htmlFor={`note-${leadId}`}>Add a note</Label>
      <textarea
        id={`note-${leadId}`}
        name="text"
        rows={3}
        maxLength={5000}
        required
        placeholder="Called, will join the webinar on Sunday…"
        className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink shadow-sm placeholder:text-slate-400 focus:border-brand-600 focus:outline-none focus:ring-3 focus:ring-brand-100"
      />
      {state?.error && <p className="text-sm text-red-600">{state.error}</p>}
      <Button type="submit" size="sm" disabled={pending} className="w-full">{pending ? "Saving…" : "Add note"}</Button>
    </form>
  );
}
