"use client";

import { AlertTriangle, Bell, Inbox, MoonStar, Webhook } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { notificationsAction } from "@/app/actions";
import { cx } from "@/components/ui";

type Item = Awaited<ReturnType<typeof notificationsAction>>[number];

const ICON: Record<string, typeof Bell> = { webhook_failed: Webhook, lp_quiet: MoonStar, error: AlertTriangle };

const ago = (iso: string) => {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
};

/** Bell with new-lead count and notifications (failed webhooks, quiet landing pages, errors). */
export function NotificationBell({ unread, newLeads, className, align = "left" }: { unread: number; newLeads: number; className?: string; align?: "left" | "right" }) {
  const router = useRouter();
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Item[] | null>(null);
  const [, startTransition] = useTransition();
  const badge = unread + (newLeads > 0 ? 1 : 0);

  function toggle() {
    if (open) return setOpen(false);
    setOpen(true);
    setItems(null);
    startTransition(async () => {
      setItems(await notificationsAction());
      router.refresh(); // clears the unread badge
    });
  }

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={toggle} aria-label={badge ? `Notifications, ${badge} new` : "Notifications"} aria-expanded={open} className={cx("relative rounded-md p-2 transition-colors", className)}>
        <Bell aria-hidden className="size-[18px]" />
        {badge > 0 && (
          <span className="absolute right-1 top-1 flex min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold leading-4 text-white">
            {badge > 9 ? "9+" : badge}
          </span>
        )}
      </button>
      {open && (
        <div role="dialog" aria-label="Notifications" className={cx("absolute top-full z-50 mt-2 w-[min(340px,calc(100vw-24px))] overflow-hidden rounded-xl border border-line bg-surface text-ink shadow-lift", align === "left" ? "left-0" : "right-0")}>
          <div className="border-b border-line px-4 py-3 text-sm font-semibold">Notifications</div>
          {newLeads > 0 && (
            <Link href="/leads" onClick={() => setOpen(false)} className="flex items-center gap-3 border-b border-line bg-brand-50 px-4 py-3 text-sm hover:bg-brand-100">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand-100 text-brand-700"><Inbox aria-hidden className="size-4" /></span>
              <span className="min-w-0">
                <span className="block font-medium">{newLeads > 999 ? "999+" : newLeads.toLocaleString("en-IN")} new lead{newLeads === 1 ? "" : "s"}</span>
                <span className="block text-xs text-ink-muted">Since you last opened Leads</span>
              </span>
            </Link>
          )}
          <ul className="max-h-[60vh] overflow-y-auto">
            {items === null && <li className="px-4 py-6 text-center text-sm text-ink-muted">Loading…</li>}
            {items?.length === 0 && newLeads === 0 && <li className="px-4 py-6 text-center text-sm text-ink-muted">You&apos;re all caught up.</li>}
            {items?.map((n) => {
              const Icon = ICON[n.type] ?? Bell;
              const body = (
                <>
                  <span className={cx("flex size-8 shrink-0 items-center justify-center rounded-lg", n.type === "webhook_failed" || n.type === "error" ? "bg-red-50 text-red-700" : "bg-amber-50 text-amber-700")}>
                    <Icon aria-hidden className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">{n.title}</span>
                    {n.body && <span className="mt-0.5 block text-xs text-ink-muted">{n.body}</span>}
                    <span className="mt-1 block text-[11px] text-ink-muted">{ago(n.at)}</span>
                  </span>
                  {n.unread && <span aria-label="New" className="mt-1.5 size-2 shrink-0 rounded-full bg-brand-500" />}
                </>
              );
              return (
                <li key={n.id} className="border-b border-line last:border-b-0">
                  {n.href ? (
                    <Link href={n.href} onClick={() => setOpen(false)} className="flex gap-3 px-4 py-3 hover:bg-slate-50">{body}</Link>
                  ) : (
                    <div className="flex gap-3 px-4 py-3">{body}</div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
