import { Inbox, Filter, Webhook } from "lucide-react";
import { redirect } from "next/navigation";
import { loginAction } from "@/app/actions";
import { ActionForm } from "@/components/ActionForm";
import { Button, Input, Label } from "@/components/ui";
import { getCtx } from "@/lib/session";

const POINTS = [
  { icon: Webhook, text: "One webhook per client, every landing page captured" },
  { icon: Inbox, text: "Every form field becomes a column automatically" },
  { icon: Filter, text: "Sheet-style filters, search and export" },
];

export default async function LoginPage() {
  if (await getCtx()) redirect("/");
  return (
    <main className="grid min-h-screen lg:grid-cols-[1fr_520px]">
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

      <section className="flex items-center justify-center px-4 py-12 sm:px-8">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex items-center gap-2.5 lg:hidden">
            <span aria-hidden className="flex size-9 items-center justify-center rounded-lg bg-brand-700 text-base font-bold text-white">S</span>
            <span className="text-lg font-semibold">Sabhi Leads</span>
          </div>
          <h2 className="text-2xl font-semibold tracking-tight">Sign in</h2>
          <p className="mb-6 mt-1 text-sm text-ink-muted">Use the email your Sabhi account manager set up for you.</p>
          <ActionForm action={loginAction} className="space-y-4">
            <div>
              <Label htmlFor="email">Email</Label>
              <Input id="email" name="email" type="email" autoComplete="email" required className="h-10" />
            </div>
            <div>
              <Label htmlFor="password">Password</Label>
              <Input id="password" name="password" type="password" autoComplete="current-password" required className="h-10" />
            </div>
            <Button type="submit" className="h-10 w-full">Sign in</Button>
          </ActionForm>
        </div>
      </section>
    </main>
  );
}
