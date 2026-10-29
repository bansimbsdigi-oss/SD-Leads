"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { buttonClass } from "@/components/ui";

/** Page numbers with First/Prev/Next/Last, plus a rows-per-page picker. */
export function Pagination({
  page,
  pageSize,
  total,
  capped = false,
  sizes,
  defaultSize,
}: {
  page: number;
  pageSize: number;
  total: number;
  capped?: boolean;
  sizes: readonly number[];
  defaultSize: number;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const first = total ? (page - 1) * pageSize + 1 : 0;
  const last = Math.min(page * pageSize, total);

  const href = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(changes)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    return next.size ? `${pathname}?${next}` : pathname;
  };
  const pageHref = (p: number) => href({ page: p > 1 ? String(p) : null });

  // 1 … 4 5 [6] 7 8 … 20
  const numbers: (number | "gap")[] = [];
  for (let p = 1; p <= pages; p++) {
    if (p === 1 || p === pages || Math.abs(p - page) <= 2) numbers.push(p);
    else if (numbers[numbers.length - 1] !== "gap") numbers.push("gap");
  }

  const nav = (label: string, target: number, disabled: boolean, aria: string) =>
    disabled ? (
      <span className={`${buttonClass("secondary", "sm")} pointer-events-none opacity-40`} aria-hidden>{label}</span>
    ) : (
      <Link href={pageHref(target)} className={buttonClass("secondary", "sm")} aria-label={aria}>{label}</Link>
    );

  return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-sm text-slate-500">
      <div className="flex items-center gap-2">
        <span>
          Showing {first.toLocaleString("en-IN")}–{last.toLocaleString("en-IN")} of {total.toLocaleString("en-IN")}
          {capped ? "+" : ""}
        </span>
        <span className="text-slate-300">|</span>
        <label className="flex items-center gap-1.5">
          Rows per page
          <select
            value={pageSize}
            // Back to page 1, since the old page number means something else at a new size.
            onChange={(e) => router.push(href({ size: Number(e.target.value) === defaultSize ? null : e.target.value, page: null }))}
            className="h-8 rounded-md border border-slate-300 bg-white px-1.5 text-sm text-slate-800"
          >
            {sizes.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
      </div>
      {pages > 1 && (
        <nav className="flex flex-wrap items-center gap-1" aria-label="Pages">
          {nav("«", 1, page === 1, "First page")}
          {nav("‹", page - 1, page === 1, "Previous page")}
          {numbers.map((n, i) =>
            n === "gap" ? (
              <span key={`g${i}`} className="px-1">…</span>
            ) : (
              <Link
                key={n}
                href={pageHref(n)}
                aria-current={n === page ? "page" : undefined}
                className={buttonClass(n === page ? "primary" : "secondary", "sm")}
              >
                {n}
              </Link>
            ),
          )}
          {nav("›", page + 1, page >= pages, "Next page")}
          {nav("»", pages, page >= pages, "Last page")}
        </nav>
      )}
    </div>
  );
}
