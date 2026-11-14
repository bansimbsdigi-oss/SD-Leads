import Link from "next/link";
import type { ReactNode } from "react";

/** Centered card for the signed-out pages (forgot / reset password). */
export function AuthCard({ title, subtitle, children, footer }: { title: string; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas px-4 py-12">
      <div className="w-full max-w-[420px]">
        <Link href="/login" className="mb-8 flex items-center gap-2.5">
          <span aria-hidden className="flex size-9 items-center justify-center rounded-lg bg-highlight text-base font-bold text-on-highlight">S</span>
          <span className="text-lg font-semibold text-ink">Sabhi Leads</span>
        </Link>
        <div className="rounded-2xl border border-line bg-surface p-6 shadow-card sm:p-8">
          <h1 className="text-2xl font-semibold tracking-tight text-ink">{title}</h1>
          {subtitle && <p className="mb-6 mt-1.5 text-sm text-ink-muted">{subtitle}</p>}
          {children}
        </div>
        {footer && <div className="mt-6 text-center text-sm text-ink-muted">{footer}</div>}
      </div>
    </main>
  );
}
