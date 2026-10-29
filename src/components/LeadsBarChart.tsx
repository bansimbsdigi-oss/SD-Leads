"use client";

import Link from "next/link";
import { useState } from "react";
import { niceAxis } from "@/lib/chartScale";

export type Bar = { id: string; name: string; value: number; today: number; last7: number; href?: string };

const fmt = (n: number) => n.toLocaleString("en-IN");


const compact = (n: number) => (n >= 1000 ? `${+(n / 1000).toFixed(n % 1000 ? 1 : 0)}K` : String(n));

/**
 * Single-series horizontal bar chart (one hue, sorted by the caller). Thin bars with a rounded
 * tip and square base, hairline gridlines, value at each tip, tooltip on hover and focus.
 */
export function LeadsBarChart({ bars, total, valueLabel }: { bars: Bar[]; total: number; valueLabel: string }) {
  const [active, setActive] = useState<string | null>(null);
  const { max, ticks } = niceAxis(Math.max(...bars.map((b) => b.value), 0));

  return (
    <div className="grid grid-cols-[minmax(96px,180px)_1fr] gap-x-4 text-sm">
      {/* Axis ticks */}
      <div />
      <div className="relative mb-2 h-4 text-[11px] text-ink-muted">
        {ticks.map((t, i) => (
          <span key={i} className="absolute -translate-x-1/2 tabular-nums" style={{ left: `${(t / max) * 100}%` }}>
            {compact(t)}
          </span>
        ))}
      </div>

      {bars.map((b) => {
        const pct = (b.value / max) * 100;
        const share = total ? Math.round((b.value / total) * 1000) / 10 : 0;
        const isActive = active === b.id;
        const label = (
          <span className={`block truncate py-1.5 ${isActive ? "text-brand-700" : "text-ink"}`} title={b.name}>{b.name}</span>
        );
        return (
          <div key={b.id || b.name} className="contents">
            {b.href ? <Link href={b.href} className="min-w-0 font-medium hover:underline" tabIndex={-1}>{label}</Link> : <div className="min-w-0 font-medium">{label}</div>}
            <div className="relative flex items-center">
              {/* Hairline gridlines, recessive */}
              {ticks.map((t, i) => (
                <span key={i} aria-hidden className="absolute inset-y-0 w-px bg-slate-100" style={{ left: `${(t / max) * 100}%` }} />
              ))}
              <Link
                href={b.href ?? "#"}
                aria-label={`${b.name}: ${fmt(b.value)} ${valueLabel}, ${share}% of total`}
                onMouseEnter={() => setActive(b.id)}
                onMouseLeave={() => setActive((a) => (a === b.id ? null : a))}
                onFocus={() => setActive(b.id)}
                onBlur={() => setActive((a) => (a === b.id ? null : a))}
                // Hit target is the whole row height, larger than the 18px bar.
                className="relative z-10 flex h-8 w-full items-center"
              >
                <span
                  className={`h-[18px] rounded-r-[4px] transition-colors duration-150 ${isActive ? "bg-brand-700" : "bg-brand-600"}`}
                  style={{ width: b.value ? `max(${pct}%, 3px)` : 0 }}
                />
                <span className="ml-2 text-xs font-medium tabular-nums text-ink">{fmt(b.value)}</span>
              </Link>
              {isActive && (
                <div
                  role="tooltip"
                  className="pointer-events-none absolute bottom-full z-20 mb-1 w-52 rounded-lg border border-line bg-surface p-3 text-xs shadow-lg"
                  style={{ left: `clamp(0px, calc(${pct}% - 104px), calc(100% - 208px))` }}
                >
                  <p className="mb-1.5 truncate font-semibold text-ink">{b.name}</p>
                  <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-ink-muted">
                    <dt>{valueLabel[0].toUpperCase() + valueLabel.slice(1)}</dt><dd className="text-right font-medium tabular-nums text-ink">{fmt(b.value)}</dd>
                    <dt>Share of total</dt><dd className="text-right font-medium tabular-nums text-ink">{share}%</dd>
                    <dt>Today</dt><dd className="text-right tabular-nums text-ink">{fmt(b.today)}</dd>
                    <dt>Last 7 days</dt><dd className="text-right tabular-nums text-ink">{fmt(b.last7)}</dd>
                  </dl>
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
