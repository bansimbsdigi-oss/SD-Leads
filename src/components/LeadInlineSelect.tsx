"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { assignLeadsAction, setLeadStatusAction } from "@/app/actions";
import { cx, stageTone } from "@/components/ui";

const DOT: Record<string, string> = {
  slate: "bg-slate-400", green: "bg-emerald-500", amber: "bg-amber-500", red: "bg-red-500", blue: "bg-brand-500", violet: "bg-violet-500",
};

/** Status or owner of one lead, changed right in the table (or on the lead page). */
export function LeadInlineSelect({
  leadId,
  kind,
  value,
  options,
  className,
}: {
  leadId: string;
  kind: "status" | "owner";
  value: string | null;
  options: { id: string; name: string }[];
  className?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [current, setCurrent] = useState(value ?? "");
  useEffect(() => setCurrent(value ?? ""), [value]);

  function change(next: string) {
    const before = current;
    setCurrent(next);
    startTransition(async () => {
      const r = kind === "status" ? await setLeadStatusAction([leadId], next || null) : await assignLeadsAction([leadId], next || null);
      if (r.error) {
        setCurrent(before);
        alert(r.error);
      }
      router.refresh();
    });
  }

  const name = options.find((o) => o.id === current)?.name;
  return (
    <span className={cx("inline-flex items-center gap-1.5", pending && "opacity-60", className)}>
      {kind === "status" && <span aria-hidden className={cx("size-2 shrink-0 rounded-full", name ? DOT[stageTone(name)] : "bg-slate-300")} />}
      <select
        aria-label={kind === "status" ? "Status" : "Owner"}
        value={current}
        disabled={pending}
        onChange={(e) => change(e.target.value)}
        className={cx(
          "h-7 max-w-44 cursor-pointer truncate rounded-md border border-transparent bg-transparent pl-1 pr-6 text-sm transition-colors hover:border-line hover:bg-surface focus:border-brand-600 focus:outline-none",
          !current && "text-ink-muted",
        )}
      >
        <option value="">{kind === "status" ? "No status" : "Unassigned"}</option>
        {options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
      </select>
    </span>
  );
}
