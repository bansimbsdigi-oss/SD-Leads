"use client";

import { AlertCircle, Eye, EyeOff, Loader2, Lock, Mail } from "lucide-react";
import { useActionState, useState } from "react";
import { loginAction, type ActionState } from "@/app/actions";

const field =
  "h-11 w-full rounded-lg border border-line bg-surface pl-10 pr-3 text-[15px] text-ink shadow-sm transition-colors duration-150 placeholder:text-slate-400 hover:border-slate-300 focus:border-brand-600 focus:outline-none focus:ring-3 focus:ring-brand-100";

export function LoginForm() {
  const [state, action, pending] = useActionState<ActionState, FormData>(loginAction, undefined);
  // Controlled so a wrong password doesn't clear the email (forms reset after each submit).
  const [email, setEmail] = useState("");
  const [show, setShow] = useState(false);

  return (
    <form action={action} className="space-y-5">
      <div>
        <label htmlFor="email" className="mb-2 block text-sm font-medium text-ink">Email</label>
        <div className="relative">
          <Mail aria-hidden className="pointer-events-none absolute left-3.5 top-1/2 size-[18px] -translate-y-1/2 text-slate-400" />
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            inputMode="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com"
            className={field}
          />
        </div>
      </div>

      <div>
        <label htmlFor="password" className="mb-2 block text-sm font-medium text-ink">Password</label>
        <div className="relative">
          <Lock aria-hidden className="pointer-events-none absolute left-3.5 top-1/2 size-[18px] -translate-y-1/2 text-slate-400" />
          <input
            id="password"
            name="password"
            type={show ? "text" : "password"}
            autoComplete="current-password"
            required
            placeholder="Your password"
            className={`${field} pr-11`}
          />
          <button
            type="button"
            onClick={() => setShow((s) => !s)}
            aria-label={show ? "Hide password" : "Show password"}
            aria-pressed={show}
            className="absolute right-1.5 top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-slate-100 hover:text-ink"
          >
            {show ? <EyeOff aria-hidden className="size-[18px]" /> : <Eye aria-hidden className="size-[18px]" />}
          </button>
        </div>
      </div>

      {state?.error && (
        <p role="alert" className="flex items-start gap-2 rounded-lg bg-red-50 px-3 py-2.5 text-sm text-red-700 ring-1 ring-inset ring-red-200">
          <AlertCircle aria-hidden className="mt-0.5 size-4 shrink-0" />
          {state.error}
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-brand-700 text-[15px] font-semibold text-white shadow-sm transition-colors duration-150 hover:bg-brand-800 disabled:opacity-70"
      >
        {pending && <Loader2 aria-hidden className="size-4 animate-spin" />}
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
