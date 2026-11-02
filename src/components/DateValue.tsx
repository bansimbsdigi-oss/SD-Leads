"use client";

import type { ComponentProps, ComponentType } from "react";
import { splitDateRange } from "@/lib/leadFilterSpec";

/** Date picker(s) for a Date of Registration condition: one day, or two for "is between". */
export function DateValue({
  op,
  value,
  onChange,
  Field = (p) => <input {...p} />,
  className,
}: {
  op: string;
  value: string;
  onChange: (value: string) => void;
  Field?: ComponentType<ComponentProps<"input">>;
  className?: string;
}) {
  const [from, to] = splitDateRange(value);
  if (op !== "between") {
    return <Field aria-label="Date" type="date" value={from} onChange={(e) => onChange(e.target.value)} className={className} />;
  }
  const set = (a: string, b: string) => onChange(a || b ? `${a}..${b}` : "");
  return (
    <span className="flex w-full items-center gap-1.5">
      <Field aria-label="From date" type="date" value={from} max={to || undefined} onChange={(e) => set(e.target.value, to)} className={className} />
      <span className="text-xs text-ink-muted">to</span>
      <Field aria-label="To date" type="date" value={to} min={from || undefined} onChange={(e) => set(from, e.target.value)} className={className} />
    </span>
  );
}
