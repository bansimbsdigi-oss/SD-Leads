import { Inbox, Filter, Webhook } from "lucide-react";
import { redirect } from "next/navigation";
import { LoginForm } from "@/components/LoginForm";
import { getCtx } from "@/lib/session";

const POINTS = [
  { icon: Webhook, text: "One webhook per client, every landing page captured" },
  { icon: Inbox, text: "Every form field becomes a column automatically" },
  { icon: Filter, text: "Sheet-style filters, search and export" },
];

export default async function LoginPage() {
  if (await getCtx()) redirect("/");
  return (
    <main className="grid min-h-screen lg:grid-cols-[minmax(0,1fr)_minmax(480px,42%)]">
      <section className="relative hidden overflow-hidden bg-brand-900 p-12 text-white lg:flex lg:flex-col lg:justify-between">
        <div className="flex items-center gap-2.5">
          <span aria-hidden className="flex size-9 items-center justify-center rounded-lg bg-white/10 text-base font-bold">S</span>
          <span className="text-lg font-semibold">Sabhi Leads</span>
        </div>
        <div className="max-w-md">
          <h1 className="text-3xl font-semibold leading-tight tracking-tight">Every lead from every landing page, in one place.</h1>
          <ul className="mt-8 space-y-4 text-brand-100">
            {POINTS.map(({ icon: Icon, text }) => (
              <li key={text} className="flex items-center gap-3">
                <span className="flex size-8 items-center justify-center rounded-lg bg-white/10"><Icon aria-hidden className="size-4" /></span>
                {text}
              </li>
            ))}
          </ul>
        </div>
        <p className="text-xs text-brand-200/70">Sabhi Digital</p>
        <div aria-hidden className="absolute -right-24 -top-24 size-96 rounded-full bg-brand-700/40 blur-3xl" />
      </section>

      <section className="flex items-center justify-center bg-canvas px-4 py-12 sm:px-8">
        <div className="w-full max-w-[400px]">
          <div className="mb-8 flex items-center gap-2.5 lg:hidden">
            <span aria-hidden className="flex size-9 items-center justify-center rounded-lg bg-brand-700 text-base font-bold text-white">S</span>
            <span className="text-lg font-semibold">Sabhi Leads</span>
          </div>
          <div className="rounded-2xl border border-line bg-surface p-6 shadow-[0_1px_3px_rgba(15,23,42,0.06),0_8px_24px_rgba(15,23,42,0.06)] sm:p-8">
            <h2 className="text-2xl font-semibold tracking-tight">Welcome back</h2>
            <p className="mb-7 mt-1.5 text-sm text-ink-muted">Sign in with the email your Sabhi account manager set up for you.</p>
            <LoginForm />
          </div>
          <p className="mt-6 text-center text-xs text-ink-muted">Trouble signing in? Ask your Sabhi account manager to reset your password.</p>
        </div>
      </section>
    </main>
  );
}
