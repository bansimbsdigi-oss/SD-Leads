"use client";

import { useState } from "react";
import { niceAxis } from "@/lib/chartScale";
import type { TrendPoint } from "@/lib/dashboard";

const fmt = (n: number) => n.toLocaleString("en-IN");
const compact = (n: number) => (n >= 1000 ? `${+(n / 1000).toFixed(n % 1000 ? 1 : 0)}K` : String(n));


/**
 * Single-series column chart over time. Columns ≤ 24px with a 4px rounded cap and square base,
 * hairline gridlines, sparse x labels, a tooltip per column on hover and focus.
 */
export function LeadsTrendChart({ points }: { points: TrendPoint[] }) {
  const [active, setActive] = useState<number | null>(null);
  const { max, ticks } = niceAxis(Math.max(...points.map((p) => p.value), 0));
  // Label about 7 columns, always including the last (most recent) one.
  const every = Math.max(1, Math.ceil(points.length / 7));
  const showLabel = (i: number) => i === points.length - 1 || (points.length - 1 - i) % every === 0;
  const total = points.reduce((n, p) => n + p.value, 0);

  return (
    <div className="grid grid-cols-[32px_1fr] gap-x-2 text-[11px] text-ink-muted">
      {/* Y axis */}
      <div className="relative h-48">
        {ticks.map((t) => (
          <span key={t} className="absolute right-0 translate-y-1/2 tabular-nums" style={{ bottom: `${(t / max) * 100}%` }}>{compact(t)}</span>
        ))}
      </div>
      <div className="relative h-48">
        {ticks.map((t) => (
          <span key={t} aria-hidden className={`absolute inset-x-0 h-px ${t === 0 ? "bg-slate-300" : "bg-slate-100"}`} style={{ bottom: `${(t / max) * 100}%` }} />
        ))}
        <ol className="absolute inset-0 flex items-end gap-[2px]" aria-label={`Leads over time, ${fmt(total)} in total`}>
          {points.map((p, i) => {
            const h = (p.value / max) * 100;
            const isActive = active === i;
            return (
              <li key={p.key} className="relative flex h-full flex-1 items-end justify-center">
                <button
                  type="button"
                  aria-label={`${p.label}: ${fmt(p.value)} leads`}
                  onMouseEnter={() => setActive(i)}
                  onMouseLeave={() => setActive((a) => (a === i ? null : a))}
                  onFocus={() => setActive(i)}
                  onBlur={() => setActive((a) => (a === i ? null : a))}
                  // Full-height hit target, wider than the column itself.
                  className="flex h-full w-full cursor-default items-end justify-center"
                >
                  <span
                    className={`w-full max-w-6 rounded-t-[4px] transition-colors duration-150 ${isActive ? "bg-brand-700" : "bg-brand-600"}`}
                    style={{ height: p.value ? `max(${h}%, 2px)` : 0 }}
                  />
                </button>
                {isActive && (
                  <div
                    role="tooltip"
                    className="pointer-events-none absolute z-20 w-max rounded-lg border border-line bg-surface px-3 py-2 text-xs shadow-lg"
                    style={{
                      bottom: `calc(${h}% + 8px)`,
                      ...(i < points.length / 2 ? { left: 0 } : { right: 0 }),
                    }}
                  >
                    <p className="font-semibold text-ink">{p.label}</p>
                    <p className="tabular-nums text-ink-muted"><span className="font-medium text-ink">{fmt(p.value)}</span> lead{p.value === 1 ? "" : "s"}</p>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      </div>
      {/* X labels */}
      <div />
      <div className="mt-1.5 flex h-4 gap-[2px]">
        {points.map((p, i) => (
          <span key={p.key} className="relative flex-1">
            {showLabel(i) && (
              <span
                className={`absolute whitespace-nowrap ${i === points.length - 1 ? "right-0" : i === 0 ? "left-0" : "left-1/2 -translate-x-1/2"}`}
              >
                {p.label}
              </span>
            )}
          </span>
        ))}
      </div>
    </div>
  );
}
