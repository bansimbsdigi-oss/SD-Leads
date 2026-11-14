import Link from "next/link";
import { resetPasswordAction } from "@/app/actions";
import { ActionForm } from "@/components/ActionForm";
import { AuthCard } from "@/components/AuthCard";
import { Button, Field, Input } from "@/components/ui";
import { resetTokenUser } from "@/lib/authSecurity";

type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function ResetPasswordPage({ searchParams }: { searchParams: SP }) {
  const raw = (await searchParams).token;
  const token = (Array.isArray(raw) ? raw[0] : raw) ?? "";
  const user = await resetTokenUser(token);
  const back = <Link href="/login" className="font-medium text-brand-700 hover:underline">Back to sign in</Link>;

  if (!user) {
    return (
      <AuthCard title="Link expired" subtitle="This reset link has expired or was already used. Links work once, for 1 hour." footer={back}>
        <Link href="/forgot" className="flex h-11 w-full items-center justify-center rounded-lg bg-brand-700 text-sm font-semibold text-on-brand hover:bg-brand-800">
          Send a new link
        </Link>
      </AuthCard>
    );
  }
  return (
    <AuthCard title="Choose a new password" subtitle={<>For <span className="font-medium text-ink">{user.email}</span>. Use at least 10 characters.</>} footer={back}>
      <ActionForm action={resetPasswordAction} className="space-y-4">
        <input type="hidden" name="token" value={token} />
        <Field label="New password" htmlFor="password">
          <Input id="password" name="password" type="password" autoComplete="new-password" minLength={10} required className="h-11" />
        </Field>
        <Field label="Type it again" htmlFor="confirm">
          <Input id="confirm" name="confirm" type="password" autoComplete="new-password" minLength={10} required className="h-11" />
        </Field>
        <Button type="submit" className="h-11 w-full">Save new password</Button>
      </ActionForm>
    </AuthCard>
  );
}
