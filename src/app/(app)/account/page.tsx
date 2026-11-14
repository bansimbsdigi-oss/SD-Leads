import { KeyRound } from "lucide-react";
import { changePasswordAction } from "@/app/actions";
import { ActionForm } from "@/components/ActionForm";
import { Avatar, Button, Card, Field, Input, PageHeader, Stat } from "@/components/ui";
import { requireCtx } from "@/lib/session";

const ROLE_LABEL = { SUPER_ADMIN: "Super admin", ACCOUNT_MANAGER: "Account manager", CLIENT_ADMIN: "Client admin", CLIENT_MEMBER: "Member" } as const;

export default async function AccountPage() {
  const ctx = await requireCtx();
  return (
    <>
      <PageHeader icon={<Avatar name={ctx.name} size="lg" />} title={ctx.name} subtitle={ctx.email} />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_420px]">
        <Card title="Your account">
          <dl className="grid gap-5 sm:grid-cols-3">
            <Stat label="Name">{ctx.name}</Stat>
            <Stat label="Email">{ctx.email}</Stat>
            <Stat label="Role">{ROLE_LABEL[ctx.role]}</Stat>
          </dl>
          <p className="mt-5 text-xs text-ink-muted">To change your name or email, ask a super admin.</p>
        </Card>
        <Card title={<span className="flex items-center gap-2"><KeyRound aria-hidden className="size-4 text-brand-700" /> Change password</span>} description="You'll be signed out everywhere and asked to sign in again." className="self-start">
          <ActionForm action={changePasswordAction} className="space-y-4">
            <Field label="Current password" htmlFor="current">
              <Input id="current" name="current" type="password" autoComplete="current-password" required />
            </Field>
            <Field label="New password" htmlFor="password" hint="At least 10 characters.">
              <Input id="password" name="password" type="password" autoComplete="new-password" minLength={10} required />
            </Field>
            <Field label="Type it again" htmlFor="confirm">
              <Input id="confirm" name="confirm" type="password" autoComplete="new-password" minLength={10} required />
            </Field>
            <Button type="submit" className="w-full">Change password</Button>
          </ActionForm>
        </Card>
      </div>
    </>
  );
}
