import { createUserAction } from "@/app/actions";
import { ActionForm } from "@/components/ActionForm";
import { Button, Input, Label, Select } from "@/components/ui";

export function UserForm({
  clientId,
  roles,
  lps = [],
  clients = [],
}: {
  clientId: string | null;
  roles: { value: string; label: string }[];
  lps?: { id: string; name: string }[];
  clients?: { id: string; name: string }[];
}) {
  return (
    <ActionForm action={createUserAction} className="space-y-4" resetOnSuccess>
      <input type="hidden" name="clientId" value={clientId ?? ""} />
      <div><Label htmlFor="u-name">Name</Label><Input id="u-name" name="name" required /></div>
      <div><Label htmlFor="u-email">Email</Label><Input id="u-email" name="email" type="email" required /></div>
      <div>
        <Label htmlFor="u-role">Role</Label>
        <Select id="u-role" name="role">
          {roles.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
        </Select>
      </div>
      <div><Label htmlFor="u-pass">Temporary password</Label><Input id="u-pass" name="password" type="text" minLength={10} required autoComplete="off" /></div>
      {lps.length > 0 && (
        <div>
          <Label>LP access (members only; leave empty for own leads only)</Label>
          <div className="max-h-36 space-y-0.5 overflow-y-auto rounded-md border border-line p-1.5 text-sm">
            {lps.map((lp) => (
              <label key={lp.id} className="flex items-center gap-2 rounded px-1.5 py-1 hover:bg-slate-50"><input className="size-4" type="checkbox" name="lpIds" value={lp.id} /> {lp.name}</label>
            ))}
          </div>
        </div>
      )}
      {clients.length > 0 && (
        <div>
          <Label>Assigned clients (account managers)</Label>
          <div className="max-h-36 space-y-0.5 overflow-y-auto rounded-md border border-line p-1.5 text-sm">
            {clients.map((c) => (
              <label key={c.id} className="flex items-center gap-2 rounded px-1.5 py-1 hover:bg-slate-50"><input className="size-4" type="checkbox" name="managedClientIds" value={c.id} /> {c.name}</label>
            ))}
          </div>
        </div>
      )}
      <Button type="submit" className="w-full">Add user</Button>
    </ActionForm>
  );
}
