import Link from "next/link";
import { redirect } from "next/navigation";
import { requestResetAction } from "@/app/actions";
import { ActionForm } from "@/components/ActionForm";
import { AuthCard } from "@/components/AuthCard";
import { Button, Field, Input } from "@/components/ui";
import { getCtx } from "@/lib/session";

export default async function ForgotPasswordPage() {
  if (await getCtx()) redirect("/account");
  return (
    <AuthCard
      title="Forgot your password?"
      subtitle="Enter the email you sign in with. We'll email you a link to choose a new password."
      footer={<Link href="/login" className="font-medium text-brand-700 hover:underline">Back to sign in</Link>}
    >
      <ActionForm action={requestResetAction} className="space-y-4" resetOnSuccess>
        <Field label="Email" htmlFor="email">
          <Input id="email" name="email" type="email" autoComplete="email" inputMode="email" required placeholder="you@company.com" className="h-11" />
        </Field>
        <Button type="submit" className="h-11 w-full">Send reset link</Button>
      </ActionForm>
    </AuthCard>
  );
}
