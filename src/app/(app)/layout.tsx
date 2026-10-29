import { logoutAction } from "@/app/actions";
import { AppShell, type NavItem } from "@/components/AppShell";
import { requireCtx } from "@/lib/session";
import { isSabhiStaff } from "@/lib/tenant";

const ROLE_LABEL = {
  SUPER_ADMIN: "Super admin",
  ACCOUNT_MANAGER: "Account manager",
  CLIENT_ADMIN: "Client admin",
  CLIENT_MEMBER: "Member",
} as const;

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireCtx();
  const nav: NavItem[] = [
    { href: "/dashboard", label: "Dashboard", icon: "dashboard", match: ["/dashboard"] },
    { href: "/leads", label: "Leads", icon: "leads", match: ["/leads"] },
    isSabhiStaff(ctx) || !ctx.clientId
      ? { href: "/clients", label: "Clients", icon: "clients", match: ["/clients", "/lps"] }
      : { href: `/clients/${ctx.clientId}`, label: "Landing pages", icon: "clients", match: ["/clients", "/lps"] },
    ...(ctx.role === "SUPER_ADMIN"
      ? ([
          { href: "/users", label: "Sabhi team", icon: "team", match: ["/users"] },
          { href: "/audit", label: "Audit log", icon: "audit", match: ["/audit"] },
        ] satisfies NavItem[])
      : []),
  ];
  return (
    <AppShell nav={nav} user={{ name: ctx.name, role: ROLE_LABEL[ctx.role] }} signOut={logoutAction}>
      {children}
    </AppShell>
  );
}
