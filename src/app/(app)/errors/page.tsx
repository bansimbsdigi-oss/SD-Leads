import { CircleCheck, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ErrorRowActions } from "@/components/ErrorRowActions";
import { Badge, Card, cx, Empty, PageHeader } from "@/components/ui";
import { listErrors } from "@/lib/errors";
import { formatDateTime } from "@/lib/leadColumns";
import { requireCtx } from "@/lib/session";

type SP = Promise<Record<string, string | string[] | undefined>>;

const SOURCE: Record<string, { label: string; tone: "red" | "amber" | "violet" }> = {
  server: { label: "Server", tone: "red" },
  job: { label: "Background job", tone: "amber" },
  browser: { label: "Browser", tone: "violet" },
};

export default async function ErrorsPage({ searchParams }: { searchParams: SP }) {
  const ctx = await requireCtx();
  if (ctx.role !== "SUPER_ADMIN") notFound();
  const show = (await searchParams).show === "fixed" ? "fixed" : "open";
  const errors = await listErrors(show);

  return (
    <>
      <PageHeader title="Errors" subtitle="Problems the app ran into, grouped. New ones also show in the bell." />
      <nav aria-label="Error lists" className="mb-4 flex gap-1 border-b border-line">
        {(["open", "fixed"] as const).map((s) => (
          <Link
            key={s}
            href={s === "open" ? "/errors" : "/errors?show=fixed"}
            aria-current={show === s ? "page" : undefined}
            className={cx("-mb-px border-b-2 px-3 py-2 text-sm font-medium", show === s ? "border-brand-600 text-ink" : "border-transparent text-ink-muted hover:text-ink")}
          >
            {s === "open" ? "Open" : "Marked fixed"}
          </Link>
        ))}
      </nav>
      <Card flush>
        {errors.length === 0 ? (
          <Empty icon={show === "open" ? <CircleCheck /> : <TriangleAlert />} title={show === "open" ? "No open errors" : "Nothing marked fixed yet"}>
            {show === "open" ? "Everything is running smoothly." : "Errors you mark fixed move here, and come back if they happen again."}
          </Empty>
        ) : (
          <ul className="divide-y divide-line">
            {errors.map((e) => (
              <li key={e.id} className="px-5 py-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={SOURCE[e.source]?.tone ?? "red"}>{SOURCE[e.source]?.label ?? e.source}</Badge>
                      {e.path && <code className="font-mono text-xs text-ink-muted">{e.path}</code>}
                      <span className="text-xs text-ink-muted">· {e.count.toLocaleString("en-IN")}×</span>
                    </div>
                    <p className="mt-1.5 break-words text-sm font-medium">{e.message}</p>
                    <p className="mt-1 text-xs text-ink-muted">Last {formatDateTime(e.lastSeenAt)} · first {formatDateTime(e.firstSeenAt)}</p>
                    {e.stack && (
                      <details className="mt-2">
                        <summary className="cursor-pointer text-xs font-medium text-brand-700">Details</summary>
                        <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-slate-900 p-3 font-mono text-[11px] leading-relaxed text-[#cfe3f5]">{e.stack}</pre>
                      </details>
                    )}
                  </div>
                  <ErrorRowActions id={e.id} resolved={Boolean(e.resolvedAt)} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
