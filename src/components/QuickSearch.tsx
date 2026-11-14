"use client";

import { Building2, FileText, LayoutDashboard, Search, UserRound } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { cx } from "@/components/ui";

type Result = { href: string; title: string; sub?: string; group: string; icon: typeof Search };
type Api = { leads: { id: string; name: string; sub: string }[]; clients: { id: string; name: string }[]; lps: { id: string; name: string; sub: string }[] };

const OPEN_EVENT = "quick-search:open";

/** Button that opens quick search (the panel itself is mounted once, in the app shell). */
export function SearchButton({ className, compact = false }: { className?: string; compact?: boolean }) {
  const [mac, setMac] = useState(false);
  useEffect(() => setMac(/Mac|iPhone|iPad/.test(navigator.platform)), []);
  if (compact) {
    return (
      <button type="button" aria-label="Search" onClick={() => window.dispatchEvent(new Event(OPEN_EVENT))} className={cx("rounded-md p-2 transition-colors", className)}>
        <Search aria-hidden className="size-[18px]" />
      </button>
    );
  }
  return (
    <button type="button" onClick={() => window.dispatchEvent(new Event(OPEN_EVENT))} className={cx("flex w-full items-center gap-2 rounded-lg border px-2.5 py-1.5 text-sm transition-colors", className)}>
      <Search aria-hidden className="size-4" />
      <span className="flex-1 text-left">Search</span>
      <kbd className="rounded border border-current/20 px-1.5 text-[10px] font-medium opacity-70">{mac ? "⌘" : "Ctrl"} K</kbd>
    </button>
  );
}

/** Ctrl/⌘ K anywhere: find a lead (name, phone, email, answers), client, landing page or page. */
export function QuickSearch({ pages }: { pages: { href: string; label: string }[] }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [data, setData] = useState<Api | null>(null);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_EVENT, onOpen);
    };
  }, []);

  useEffect(() => {
    if (open) {
      setQ("");
      setData(null);
      setActive(0);
      setTimeout(() => input.current?.focus(), 0);
    }
  }, [open]);

  // Search as you type (debounced); the newest request wins.
  useEffect(() => {
    if (q.trim().length < 2) {
      setData(null);
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      setLoading(true);
      fetch(`/api/search?q=${encodeURIComponent(q.trim())}`, { signal: ctrl.signal })
        .then((r) => (r.ok ? r.json() : null))
        .then((d: Api | null) => {
          setData(d);
          setActive(0);
        })
        .catch(() => {})
        .finally(() => setLoading(false));
    }, 200);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q]);

  const results = useMemo<Result[]>(() => {
    const needle = q.trim().toLowerCase();
    const pageHits = pages
      .filter((p) => !needle || p.label.toLowerCase().includes(needle))
      .map((p) => ({ href: p.href, title: p.label, group: "Go to", icon: LayoutDashboard }));
    if (!data) return pageHits;
    return [
      ...data.leads.map((l) => ({ href: `/leads/${l.id}`, title: l.name, sub: l.sub, group: "Leads", icon: UserRound })),
      ...data.clients.map((c) => ({ href: `/clients/${c.id}`, title: c.name, group: "Clients", icon: Building2 })),
      ...data.lps.map((p) => ({ href: `/lps/${p.id}`, title: p.name, sub: p.sub, group: "Landing pages", icon: FileText })),
      ...pageHits,
    ];
  }, [data, pages, q]);

  const go = (r: Result | undefined) => {
    if (!r) return;
    setOpen(false);
    router.push(r.href);
  };

  return (
    <>
      {open && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-slate-900/50 px-3 pt-[12vh]" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
          <div role="dialog" aria-label="Quick search" className="w-full max-w-xl overflow-hidden rounded-xl border border-line bg-surface text-ink shadow-lift">
            <div className="flex items-center gap-2 border-b border-line px-4">
              <Search aria-hidden className="size-4 text-ink-muted" />
              <input
                ref={input}
                autoFocus // focused as it opens, so typing straight after Ctrl/⌘ K isn't lost
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setOpen(false);
                  else if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, results.length - 1)); }
                  else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
                  else if (e.key === "Enter") { e.preventDefault(); go(results[active]); }
                }}
                placeholder="Search leads by name, phone or email, clients, pages…"
                aria-label="Search"
                className="h-12 flex-1 bg-transparent text-[15px] outline-none placeholder:text-slate-400"
              />
              {loading && <span className="text-xs text-ink-muted">Searching…</span>}
            </div>
            <ul className="max-h-[55vh] overflow-y-auto py-1" role="listbox">
              {results.length === 0 && <li className="px-4 py-6 text-center text-sm text-ink-muted">{q.trim().length < 2 ? "Type at least 2 letters." : "Nothing found."}</li>}
              {results.map((r, i) => {
                const Icon = r.icon;
                const header = i === 0 || results[i - 1].group !== r.group;
                return (
                  <li key={`${r.group}-${r.href}`} role="option" aria-selected={i === active}>
                    {header && <p className="px-4 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-ink-muted">{r.group}</p>}
                    <button
                      type="button"
                      onMouseEnter={() => setActive(i)}
                      onClick={() => go(r)}
                      className={cx("flex w-full items-center gap-3 px-4 py-2 text-left", i === active && "bg-brand-50")}
                    >
                      <Icon aria-hidden className="size-4 shrink-0 text-ink-muted" />
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium">{r.title}</span>
                        {r.sub && <span className="block truncate text-xs text-ink-muted">{r.sub}</span>}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      )}
    </>
  );
}
