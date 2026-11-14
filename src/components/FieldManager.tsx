"use client";

import { Eye, EyeOff, GitMerge, Undo2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { hideColumnFieldsAction, mergeColumnAction, renameColumnAction, unmergeFieldAction, type ActionState } from "@/app/actions";
import { Badge, Button, cx } from "@/components/ui";
import type { FieldColumn } from "@/lib/fieldManager";

type Target = { key: string; label: string };

/** Rename, hide or merge one client's form columns. */
export function FieldManager({ clientId, columns, targets }: { clientId: string; columns: FieldColumn[]; targets: { form: Target[]; fixed: Target[] } }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<ActionState>(undefined);
  const run = (act: () => Promise<ActionState>) =>
    startTransition(async () => {
      const r = await act();
      setMessage(r);
      router.refresh();
    });

  return (
    <div className={cx("divide-y divide-line", pending && "opacity-70")}>
      {message?.error && <p role="alert" className="bg-red-50 px-5 py-2.5 text-sm text-red-700">{message.error}</p>}
      {columns.map((c) => (
        <ColumnRow key={c.key} clientId={clientId} column={c} targets={targets} run={run} disabled={pending} />
      ))}
    </div>
  );
}

function ColumnRow({
  clientId,
  column: c,
  targets,
  run,
  disabled,
}: {
  clientId: string;
  column: FieldColumn;
  targets: { form: Target[]; fixed: Target[] };
  run: (act: () => Promise<ActionState>) => void;
  disabled: boolean;
}) {
  const [label, setLabel] = useState(c.label);
  const [into, setInto] = useState("");
  const others = targets.form.filter((t) => t.key !== c.key);

  return (
    <div className="grid gap-3 px-5 py-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1.5fr)_auto] lg:items-start">
      <div className="min-w-0">
        {c.fixed ? (
          <p className="text-sm font-semibold">{c.label} <Badge>Fixed column</Badge></p>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (label.trim() !== c.label) run(() => renameColumnAction(clientId, c.key, label));
            }}
            className="flex items-center gap-2"
          >
            <input
              aria-label="Column name"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              onBlur={() => label.trim() && label.trim() !== c.label && run(() => renameColumnAction(clientId, c.key, label))}
              maxLength={120}
              className="h-8 w-full min-w-0 rounded-md border border-transparent bg-transparent px-2 text-sm font-semibold hover:border-line focus:border-brand-600 focus:bg-surface focus:outline-none"
            />
            {c.hidden && <Badge tone="amber">Hidden</Badge>}
          </form>
        )}
        <p className="mt-0.5 px-2 font-mono text-[11px] text-ink-muted">{c.key}</p>
      </div>

      <ul className="space-y-1 text-xs">
        {c.fields.map((f) => (
          <li key={f.id} className="flex flex-wrap items-center gap-1.5">
            <span className="text-ink-muted">{f.lpName}:</span>
            <span className="font-medium">{f.label}</span>
            {f.merged && (
              <button type="button" disabled={disabled} onClick={() => run(() => unmergeFieldAction(clientId, f.id))} className="inline-flex items-center gap-1 rounded px-1 text-brand-700 hover:underline">
                <Undo2 aria-hidden className="size-3" /> Undo merge
              </button>
            )}
          </li>
        ))}
      </ul>

      {!c.fixed && (
        <div className="flex flex-wrap items-center gap-2 lg:justify-end">
          <Button type="button" variant="secondary" size="sm" disabled={disabled} onClick={() => run(() => hideColumnFieldsAction(clientId, c.key, !c.hidden))}>
            {c.hidden ? <><Eye aria-hidden /> Show</> : <><EyeOff aria-hidden /> Hide</>}
          </Button>
          <select aria-label={`Merge ${c.label} into`} value={into} onChange={(e) => setInto(e.target.value)} className="h-8 max-w-48 rounded-md border border-line bg-surface px-2 text-sm">
            <option value="">Merge into…</option>
            {others.length > 0 && <optgroup label="Form columns">{others.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}</optgroup>}
            <optgroup label="Fixed columns">{targets.fixed.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}</optgroup>
          </select>
          <Button type="button" variant="secondary" size="sm" disabled={disabled || !into} onClick={() => {
            const target = [...targets.form, ...targets.fixed].find((t) => t.key === into)?.label ?? into;
            if (confirm(`Show “${c.label}” inside “${target}”? You can undo it per field.`)) run(() => mergeColumnAction(clientId, c.key, into));
          }}>
            <GitMerge aria-hidden /> Merge
          </Button>
        </div>
      )}
    </div>
  );
}
