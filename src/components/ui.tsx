// Small shadcn-style primitives on Tailwind, using the tokens in globals.css.
import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

type ButtonProps = ComponentProps<"button"> & { variant?: "primary" | "secondary" | "ghost" | "danger"; size?: "sm" | "md" };

export function buttonClass(variant: ButtonProps["variant"] = "primary", size: ButtonProps["size"] = "md") {
  return cx(
    "inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-colors duration-150 disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
    size === "sm" ? "h-8 px-3 text-sm" : "h-9 px-4 text-sm",
    variant === "primary" && "bg-brand-700 text-white shadow-sm hover:bg-brand-800",
    variant === "secondary" && "border border-line bg-surface text-ink shadow-sm hover:border-slate-300 hover:bg-slate-50",
    variant === "ghost" && "text-ink-muted hover:bg-slate-100 hover:text-ink",
    variant === "danger" && "bg-red-600 text-white shadow-sm hover:bg-red-700",
  );
}

export function Button({ variant, size, className, ...props }: ButtonProps) {
  return <button className={cx(buttonClass(variant, size), className)} {...props} />;
}

const field =
  "w-full rounded-md border border-line bg-surface text-sm text-ink shadow-sm transition-colors duration-150 placeholder:text-slate-400 hover:border-slate-300 focus:border-brand-600 focus:outline-none focus:ring-3 focus:ring-brand-100 disabled:bg-slate-50";

export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input className={cx(field, "h-9 px-3", className)} {...props} />;
}

export function Select({ className, ...props }: ComponentProps<"select">) {
  return <select className={cx(field, "h-9 px-2.5", className)} {...props} />;
}

export function Label({ className, ...props }: ComponentProps<"label">) {
  return <label className={cx("mb-1.5 block text-xs font-medium text-ink-muted", className)} {...props} />;
}

export function Hint({ children }: { children: ReactNode }) {
  return <p className="mt-1.5 text-xs leading-relaxed text-ink-muted">{children}</p>;
}

/** White panel. `flush` removes body padding (tables run edge to edge). */
export function Card({
  className,
  title,
  description,
  actions,
  flush = false,
  children,
}: {
  className?: string;
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  flush?: boolean;
  children: ReactNode;
}) {
  return (
    <section className={cx("overflow-hidden rounded-xl border border-line bg-surface shadow-[0_1px_2px_rgba(15,23,42,0.04)]", className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3.5">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-ink">{title}</h2>
            {description && <p className="mt-0.5 text-xs text-ink-muted">{description}</p>}
          </div>
          {actions}
        </header>
      )}
      <div className={flush ? "" : "p-5"}>{children}</div>
    </section>
  );
}

export type Tone = "slate" | "green" | "amber" | "red" | "blue" | "violet";

const TONES: Record<Tone, string> = {
  slate: "bg-slate-100 text-slate-700 ring-slate-200",
  green: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  amber: "bg-amber-50 text-amber-800 ring-amber-200",
  red: "bg-red-50 text-red-700 ring-red-200",
  blue: "bg-brand-50 text-brand-700 ring-brand-200",
  violet: "bg-violet-50 text-violet-700 ring-violet-200",
};
const DOTS: Record<Tone, string> = {
  slate: "bg-slate-400", green: "bg-emerald-500", amber: "bg-amber-500", red: "bg-red-500", blue: "bg-brand-500", violet: "bg-violet-500",
};

export function Badge({ tone = "slate", dot = false, children }: { tone?: Tone; dot?: boolean; children: ReactNode }) {
  return (
    <span className={cx("inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset", TONES[tone])}>
      {dot && <span aria-hidden className={cx("size-1.5 rounded-full", DOTS[tone])} />}
      {children}
    </span>
  );
}

/** Pipeline stage colours by name; unknown custom stages fall back to slate. */
export function stageTone(name?: string | null): Tone {
  switch ((name ?? "").toLowerCase()) {
    case "new": return "blue";
    case "contacted": return "amber";
    case "qualified": return "violet";
    case "won": return "green";
    case "lost": return "red";
    default: return "slate";
  }
}

export function StatusBadge({ name }: { name?: string | null }) {
  if (!name) return <span className="text-slate-400">—</span>;
  return <Badge tone={stageTone(name)} dot>{name}</Badge>;
}

const AVATAR_TONES = ["bg-brand-100 text-brand-800", "bg-emerald-100 text-emerald-800", "bg-amber-100 text-amber-900", "bg-violet-100 text-violet-800", "bg-rose-100 text-rose-800", "bg-sky-100 text-sky-800"];

export function Avatar({ name, size = "md" }: { name: string; size?: "sm" | "md" | "lg" }) {
  const initials = name.trim().split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? "").join("") || "?";
  const tone = AVATAR_TONES[[...name].reduce((a, ch) => a + ch.charCodeAt(0), 0) % AVATAR_TONES.length];
  const dims = size === "sm" ? "size-7 text-[11px]" : size === "lg" ? "size-12 text-base" : "size-9 text-xs";
  return <span aria-hidden className={cx("inline-flex shrink-0 items-center justify-center rounded-full font-semibold", dims, tone)}>{initials}</span>;
}

export type Crumb = { label: string; href?: string };

export function PageHeader({
  title,
  subtitle,
  actions,
  crumbs,
  icon,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  crumbs?: Crumb[];
  icon?: ReactNode;
}) {
  return (
    <div className="mb-6">
      {crumbs && crumbs.length > 0 && (
        <nav aria-label="Breadcrumb" className="mb-2 flex flex-wrap items-center gap-1.5 text-xs text-ink-muted">
          {crumbs.map((c, i) => (
            <span key={i} className="flex items-center gap-1.5">
              {i > 0 && <span aria-hidden className="text-slate-300">/</span>}
              {c.href ? <Link href={c.href} className="hover:text-ink hover:underline">{c.label}</Link> : <span>{c.label}</span>}
            </span>
          ))}
        </nav>
      )}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          {icon}
          <div className="min-w-0">
            <h1 className="truncate text-xl font-semibold tracking-tight text-ink sm:text-2xl">{title}</h1>
            {subtitle && <div className="mt-1 text-sm text-ink-muted">{subtitle}</div>}
          </div>
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}

export const tableClass = cx(
  "w-full border-separate border-spacing-0 text-left text-sm",
  "[&_thead_th]:sticky [&_thead_th]:top-0 [&_thead_th]:z-10 [&_thead_th]:border-b [&_thead_th]:border-line [&_thead_th]:bg-slate-50/95 [&_thead_th]:backdrop-blur",
  "[&_th]:whitespace-nowrap [&_th]:px-4 [&_th]:py-2.5 [&_th]:text-xs [&_th]:font-semibold [&_th]:text-ink-muted",
  "[&_td]:border-b [&_td]:border-slate-100 [&_td]:px-4 [&_td]:py-3 [&_td]:align-middle",
  "[&_tbody_tr:last-child_td]:border-b-0 [&_tbody_tr]:transition-colors [&_tbody_tr:hover]:bg-slate-50/70",
);

export function Empty({ icon, title, children, action }: { icon?: ReactNode; title?: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-12 text-center">
      {icon && <div className="mb-3 flex size-11 items-center justify-center rounded-full bg-slate-100 text-ink-muted [&_svg]:size-5">{icon}</div>}
      {title && <p className="text-sm font-semibold text-ink">{title}</p>}
      {children && <p className="mt-1 max-w-sm text-sm text-ink-muted">{children}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/** Small label/value pair for detail headers. */
export function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium text-ink-muted">{label}</dt>
      <dd className="mt-1 truncate text-sm font-medium text-ink">{children}</dd>
    </div>
  );
}
