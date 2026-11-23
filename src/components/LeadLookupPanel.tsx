"use client";

import { FileUp, RefreshCw, Search, Send, TriangleAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { checkLeadByHandAction, reloadSheetsAction, resendLookupAction, uploadSheetAction } from "@/app/actions";
import { ActionForm } from "@/components/ActionForm";
import { Badge, Button, Field, Input, type Tone } from "@/components/ui";

const TYPE_TONE: Record<string, Tone> = { mentor: "green", sub_mentor: "violet", none: "slate" };

type SheetCard = { sheet: string; label: string; url: string | null; fileName: string | null; rows: number | null; readAt: string | null; error: string | null };

/** Sheet status cards with Reload. */
export function LookupSheets({ sheets }: { sheets: SheetCard[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        {sheets.map((s) => (
          <div key={s.sheet} className="rounded-xl border border-line p-4">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-semibold">{s.label}</p>
              {!s.url && !s.fileName ? <Badge>Not connected</Badge> : s.error ? <Badge tone="red">Problem</Badge> : <Badge tone="green">{s.fileName ? "Uploaded" : "Google Sheet"}</Badge>}
            </div>
            {s.fileName && <p className="mt-1 truncate text-xs text-ink-muted" title={s.fileName}>File: {s.fileName}</p>}
            {(s.url || s.fileName) && s.rows !== null && <p className="mt-2 text-2xl font-semibold tabular-nums">{s.rows.toLocaleString("en-IN")} <span className="text-sm font-normal text-ink-muted">rows</span></p>}
            {s.readAt && <p className="mt-0.5 text-xs text-ink-muted">Last read {new Date(s.readAt).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</p>}
            {s.error && (
              <p className="mt-2 flex items-start gap-1.5 text-xs text-red-700">
                <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                <span>{s.error}{s.rows ? " Using the last good copy." : ""}</span>
              </p>
            )}
            {!s.url && !s.fileName && <p className="mt-2 text-xs text-ink-muted">Upload the file below, or paste a Google Sheet link in the settings.</p>}
            <ActionForm action={uploadSheetAction} className="mt-3 space-y-2 border-t border-line pt-3" resetOnSuccess>
              <input type="hidden" name="sheet" value={s.sheet} />
              <input
                type="file"
                name="file"
                required
                accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                aria-label={`${s.label} file`}
                className="block w-full text-xs text-ink-muted file:mr-2 file:rounded-md file:border-0 file:bg-slate-100 file:px-2.5 file:py-1.5 file:text-xs file:font-medium file:text-ink hover:file:bg-slate-200"
              />
              <Button type="submit" variant="secondary" size="sm" className="w-full"><FileUp aria-hidden /> {s.fileName ? "Upload a new file" : "Upload CSV or Excel"}</Button>
            </ActionForm>
          </div>
        ))}
      </div>
      <Button type="button" variant="secondary" size="sm" disabled={pending} onClick={() => startTransition(async () => { await reloadSheetsAction(); router.refresh(); })}>
        <RefreshCw aria-hidden className={pending ? "animate-spin" : undefined} /> {pending ? "Reading…" : "Reload sheets"}
      </Button>
    </div>
  );
}

/** Check a lead by hand; optionally send the result to the outbound webhook. */
export function LookupCheck({ hasOutbound }: { hasOutbound: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [form, setForm] = useState({ name: "", email: "", phone: "" });
  const [send, setSend] = useState(false);
  const [result, setResult] = useState<Awaited<ReturnType<typeof checkLeadByHandAction>> | null>(null);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        startTransition(async () => {
          setResult(await checkLeadByHandAction(form, send));
          router.refresh();
        });
      }}
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Name" htmlFor="lk-name"><Input id="lk-name" value={form.name} onChange={set("name")} placeholder="Asha Verma" /></Field>
        <Field label="Email" htmlFor="lk-email"><Input id="lk-email" value={form.email} onChange={set("email")} placeholder="asha@example.com" /></Field>
        <Field label="Phone" htmlFor="lk-phone"><Input id="lk-phone" value={form.phone} onChange={set("phone")} placeholder="+91 98765 43210" inputMode="tel" /></Field>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" size="sm" disabled={pending}><Search aria-hidden /> {pending ? "Checking…" : "Check lead"}</Button>
        <label className={`flex items-center gap-2 text-sm ${hasOutbound ? "" : "opacity-50"}`}>
          <input type="checkbox" className="size-4" checked={send} disabled={!hasOutbound} onChange={(e) => setSend(e.target.checked)} />
          Also send to my webhook{!hasOutbound && " (add it in the settings first)"}
        </label>
      </div>
      {result && !result.ok && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-inset ring-red-200">{result.error}</p>}
      {result?.ok && (
        <div className="rounded-lg border border-line p-4 text-sm">
          <Badge tone={TYPE_TONE[result.payload.lead_type]}>{result.payload.lead_type_label}</Badge>
          <dl className="mt-3 grid gap-2 sm:grid-cols-3">
            <div><dt className="text-xs text-ink-muted">Mentor</dt><dd className="font-medium">{result.payload.mentor_name || "—"}</dd></div>
            <div><dt className="text-xs text-ink-muted">Sub-mentor</dt><dd className="font-medium">{result.payload.sub_mentor_name || "—"}</dd></div>
            <div><dt className="text-xs text-ink-muted">Matched by</dt><dd className="font-medium">{result.payload.matched_by || "—"}</dd></div>
          </dl>
        </div>
      )}
    </form>
  );
}

/** "Send" for a failed or unsent lookup. */
export function ResendLookupButton({ id }: { id: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <Button type="button" variant="secondary" size="sm" disabled={pending} onClick={() => startTransition(async () => {
      const r = await resendLookupAction(id);
      if (r.error) alert(r.error);
      router.refresh();
    })}>
      <Send aria-hidden /> Send
    </Button>
  );
}
