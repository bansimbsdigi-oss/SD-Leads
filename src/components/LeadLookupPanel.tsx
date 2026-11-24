"use client";

import { FileSpreadsheet, FileUp, Link2, RefreshCw, Search, Send, TriangleAlert, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { checkLeadByHandAction, reloadSheetsAction, removeSheetFileAction, resendLookupAction, uploadSheetAction } from "@/app/actions";
import { ActionForm } from "@/components/ActionForm";
import { Badge, Button, Field, Input, type Tone } from "@/components/ui";

const TYPE_TONE: Record<string, Tone> = { mentor: "green", sub_mentor: "violet", none: "slate" };

type SheetCard = {
  sheet: "mentor" | "subMentor";
  label: string;
  url: string | null;
  linkRows: number | null;
  files: { name: string; rows: number; uploadedAt: string }[];
  rows: number | null;
  readAt: string | null;
  error: string | null;
};

/** One card per list (Mentor / Sub-mentor): its files and sheet link, add files, remove one, reload. */
export function LookupSheets({ sheets }: { sheets: SheetCard[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const remove = (sheet: SheetCard["sheet"], name: string) => {
    if (!confirm(`Remove ${name} from this list? Its people won't be matched any more.`)) return;
    startTransition(async () => {
      await removeSheetFileAction(sheet, name);
      router.refresh();
    });
  };
  return (
    <div className="space-y-4">
      <div className="grid gap-3 lg:grid-cols-2">
        {sheets.map((s) => (
          <div key={s.sheet} className="rounded-xl border border-line p-4">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-semibold">{s.label} list</p>
              {s.rows === null ? <Badge>Empty</Badge> : s.error ? <Badge tone="red">Problem</Badge> : <Badge tone="green">Ready</Badge>}
            </div>
            {s.rows !== null && <p className="mt-2 text-2xl font-semibold tabular-nums">{s.rows.toLocaleString("en-IN")} <span className="text-sm font-normal text-ink-muted">people in total</span></p>}

            <ul className="mt-3 space-y-1.5">
              {s.files.map((f) => (
                <li key={f.name} className="flex items-center gap-2 rounded-lg bg-slate-50 px-2.5 py-1.5 text-xs ring-1 ring-inset ring-line">
                  <FileSpreadsheet aria-hidden className="size-3.5 shrink-0 text-ink-muted" />
                  <span className="min-w-0 flex-1 truncate font-medium" title={f.name}>{f.name}</span>
                  <span className="shrink-0 tabular-nums text-ink-muted">{f.rows.toLocaleString("en-IN")} rows</span>
                  <button type="button" disabled={pending} onClick={() => remove(s.sheet, f.name)} aria-label={`Remove ${f.name}`} className="rounded p-0.5 text-ink-muted hover:bg-slate-200 hover:text-red-700">
                    <X aria-hidden className="size-3.5" />
                  </button>
                </li>
              ))}
              {s.url && (
                <li className="flex items-center gap-2 rounded-lg bg-slate-50 px-2.5 py-1.5 text-xs ring-1 ring-inset ring-line">
                  <Link2 aria-hidden className="size-3.5 shrink-0 text-ink-muted" />
                  <span className="min-w-0 flex-1 truncate font-medium">Google Sheet link</span>
                  <span className="shrink-0 tabular-nums text-ink-muted">{s.linkRows === null ? "not read" : `${s.linkRows.toLocaleString("en-IN")} rows`}</span>
                </li>
              )}
            </ul>
            {s.error && (
              <p className="mt-2 flex items-start gap-1.5 text-xs text-red-700">
                <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                <span>Google Sheet link: {s.error}{s.linkRows ? " Using the last good copy." : ""}</span>
              </p>
            )}
            {s.rows === null && <p className="mt-2 text-xs text-ink-muted">Add one or more files below (you can pick several at once).</p>}

            <ActionForm action={uploadSheetAction} className="mt-3 space-y-2 border-t border-line pt-3" resetOnSuccess>
              <input type="hidden" name="sheet" value={s.sheet} />
              <input
                type="file"
                name="file"
                multiple
                required
                accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                aria-label={`${s.label} files`}
                className="block w-full text-xs text-ink-muted file:mr-2 file:rounded-md file:border-0 file:bg-slate-100 file:px-2.5 file:py-1.5 file:text-xs file:font-medium file:text-ink hover:file:bg-slate-200"
              />
              <Button type="submit" variant="secondary" size="sm" className="w-full"><FileUp aria-hidden /> Add {s.label} file(s)</Button>
              <p className="text-[11px] text-ink-muted">CSV or Excel (.xlsx). Uploading a file with the same name replaces the old copy.</p>
            </ActionForm>
          </div>
        ))}
      </div>
      <Button type="button" variant="secondary" size="sm" disabled={pending} onClick={() => startTransition(async () => { await reloadSheetsAction(); router.refresh(); })}>
        <RefreshCw aria-hidden className={pending ? "animate-spin" : undefined} /> {pending ? "Reading…" : "Reload Google Sheet links"}
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
