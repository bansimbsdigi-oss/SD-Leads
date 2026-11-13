"use client";

import { useActionState, type ReactNode } from "react";
import type { ActionState } from "@/app/actions";
import { cx } from "@/components/ui";

export function ActionForm({
  action,
  children,
  className,
  resetOnSuccess = false,
}: {
  action: (state: ActionState, fd: FormData) => Promise<ActionState>;
  children: ReactNode;
  className?: string;
  resetOnSuccess?: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, undefined);
  return (
    <form action={formAction} key={resetOnSuccess && state?.ok ? state.ok : undefined}>
      {/* Layout classes go on the fieldset: it holds the fields, so spacing like space-y-4 applies to them. */}
      <fieldset disabled={pending} className={cx("min-w-0", className)}>
        {children}
      </fieldset>
      {state?.error && <p role="alert" className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-inset ring-red-200">{state.error}</p>}
      {state?.ok && <p role="status" className="mt-3 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800 ring-1 ring-inset ring-emerald-200">{state.ok}</p>}
    </form>
  );
}
