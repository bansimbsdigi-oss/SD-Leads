"use client";

import { Building2, Inbox, LayoutDashboard, LogOut, Menu, ScrollText, Users, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { Avatar, cx } from "@/components/ui";

const ICONS = { dashboard: LayoutDashboard, leads: Inbox, clients: Building2, team: Users, audit: ScrollText } as const;

export type NavItem = { href: string; label: string; icon: keyof typeof ICONS; match: string[] };

export function AppShell({
  nav,
  user,
  signOut,
  children,
}: {
  nav: NavItem[];
  user: { name: string; role: string };
  signOut: () => Promise<void>;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [pathname]); // close the mobile menu after navigating

  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="flex h-16 items-center gap-2.5 px-5">
        <span aria-hidden className="flex size-8 items-center justify-center rounded-lg bg-brand-700 text-sm font-bold text-white">S</span>
        <span className="text-[15px] font-semibold tracking-tight text-ink">Sabhi Leads</span>
      </div>
      <nav aria-label="Main" className="flex-1 space-y-0.5 px-3 py-2">
        {nav.map((item) => {
          const Icon = ICONS[item.icon];
          const active = item.match.some((m) => pathname === m || pathname.startsWith(`${m}/`));
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={cx(
                "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors duration-150",
                active ? "bg-brand-50 text-brand-700" : "text-ink-muted hover:bg-slate-100 hover:text-ink",
              )}
            >
              <Icon aria-hidden className="size-[18px]" />
              {item.label}
            </Link>
          );
        })}
      </nav>
      <div className="border-t border-line p-3">
        <div className="flex items-center gap-3 rounded-lg px-2 py-2">
          <Avatar name={user.name} size="sm" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-ink">{user.name}</p>
            <p className="truncate text-xs text-ink-muted">{user.role}</p>
          </div>
          <form action={signOut}>
            <button aria-label="Sign out" title="Sign out" className="rounded-md p-2 text-ink-muted transition-colors hover:bg-slate-100 hover:text-ink">
              <LogOut aria-hidden className="size-4" />
            </button>
          </form>
        </div>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 border-r border-line bg-surface lg:block">{sidebar}</aside>

      {/* Mobile top bar + drawer */}
      <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-line bg-surface/95 px-4 backdrop-blur lg:hidden">
        <button aria-label="Open menu" aria-expanded={open} onClick={() => setOpen(true)} className="-ml-2 rounded-md p-2 text-ink-muted hover:bg-slate-100">
          <Menu aria-hidden className="size-5" />
        </button>
        <span className="font-semibold text-ink">Sabhi Leads</span>
      </header>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <div className="absolute inset-0 bg-slate-900/40" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 max-w-[85vw] bg-surface shadow-xl">
            <button aria-label="Close menu" onClick={() => setOpen(false)} className="absolute right-3 top-4 rounded-md p-2 text-ink-muted hover:bg-slate-100">
              <X aria-hidden className="size-5" />
            </button>
            {sidebar}
          </aside>
        </div>
      )}

      <main className="lg:pl-60">
        <div className="mx-auto max-w-[1600px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">{children}</div>
      </main>
    </div>
  );
}
