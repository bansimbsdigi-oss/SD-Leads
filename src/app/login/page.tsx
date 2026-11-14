import { CircleCheck, Inbox, Filter, Webhook } from "lucide-react";
import { redirect } from "next/navigation";
import { ClientLogo } from "@/components/ClientLogo";
import { LoginForm } from "@/components/LoginForm";
import { brandBySlug } from "@/lib/branding";
import { getCtx } from "@/lib/session";

const POINTS = [
  { icon: Webhook, text: "One webhook per client, every landing page captured" },
  { icon: Inbox, text: "Every form field becomes a column automatically" },
  { icon: Filter, text: "Sheet-style filters, search and export" },
];

type SP = Promise<Record<string, string | string[] | undefined>>;

const NOTICES: Record<string, string> = {
  changed: "Password changed. Sign in with your new password.",
  reset: "New password saved. Sign in with it now.",
};

export default async function LoginPage({ searchParams }: { searchParams: SP }) {
  if (await getCtx()) redirect("/");
  const sp = await searchParams;
  const notice = Object.keys(NOTICES).find((k) => sp[k]);
  // A client's own login link (/login?c=<slug>) shows their name and logo.
  const brand = typeof sp.c === "string" ? await brandBySlug(sp.c) : null;
  return (
    <main className="grid min-h-screen lg:grid-cols-[minmax(0,1fr)_minmax(480px,42%)]">
      <section className="relative hidden overflow-hidden border-r border-nav-line bg-nav p-12 text-nav-strong lg:flex lg:flex-col lg:justify-between">
        <div className="flex items-center gap-2.5">
          <span aria-hidden className="flex size-9 items-center justify-center rounded-lg bg-highlight text-base font-bold text-on-highlight">S</span>
          <span className="text-lg font-semibold">Sabhi Leads</span>
        </div>
        <div className="max-w-md">
          <h1 className="text-3xl font-semibold leading-tight tracking-tight">Every lead from every landing page, in one place.</h1>
          <ul className="mt-8 space-y-4 text-nav-ink">
            {POINTS.map(({ icon: Icon, text }) => (
              <li key={text} className="flex items-center gap-3">
                <span className="flex size-8 items-center justify-center rounded-lg bg-nav-active text-nav-accent ring-1 ring-nav-line"><Icon aria-hidden className="size-4" /></span>
                {text}
              </li>
            ))}
          </ul>
        </div>
        <p className="text-xs text-nav-muted">Sabhi Digital</p>
        <div aria-hidden className="absolute -right-24 -top-24 size-96 rounded-full bg-highlight/15 blur-3xl" />
      </section>

      <section className="flex items-center justify-center bg-canvas px-4 py-12 sm:px-8">
        <div className="w-full max-w-[400px]">
          <div className="mb-8 flex items-center gap-2.5 lg:hidden">
            <span aria-hidden className="flex size-9 items-center justify-center rounded-lg bg-highlight text-base font-bold text-on-highlight">S</span>
            <span className="text-lg font-semibold">Sabhi Leads</span>
          </div>
          <div className="rounded-2xl border border-line bg-surface p-6 shadow-[0_1px_3px_rgba(15,23,42,0.06),0_8px_24px_rgba(15,23,42,0.06)] sm:p-8">
            {brand && (
              <div className="mb-5 flex items-center gap-3 border-b border-line pb-5">
                <ClientLogo name={brand.name} logo={brand.logo} size="lg" />
                <div className="min-w-0">
                  <p className="truncate font-semibold">{brand.name}</p>
                  <p className="text-xs text-ink-muted">Lead dashboard by Sabhi Digital</p>
                </div>
              </div>
            )}
            <h2 className="text-2xl font-semibold tracking-tight">Welcome back</h2>
            <p className="mb-7 mt-1.5 text-sm text-ink-muted">Sign in with the email your Sabhi account manager set up for you.</p>
            {notice && (
              <p role="status" className="-mt-2 mb-5 flex items-start gap-2 rounded-lg bg-emerald-50 px-3 py-2.5 text-sm text-emerald-800 ring-1 ring-inset ring-emerald-200">
                <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0" />
                {NOTICES[notice]}
              </p>
            )}
            <LoginForm />
          </div>
          <p className="mt-6 text-center text-xs text-ink-muted">Still stuck? Ask your Sabhi account manager to reset your password.</p>
        </div>
      </section>
    </main>
  );
}
