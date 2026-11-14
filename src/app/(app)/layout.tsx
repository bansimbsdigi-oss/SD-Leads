import { logoutAction } from "@/app/actions";
import { AppShell, type NavItem } from "@/components/AppShell";
import { logoUrl } from "@/lib/branding";
import { prisma } from "@/lib/db";
import { newLeadsCount, unreadCount } from "@/lib/notifications";
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
    { href: "/dashboard", label: "Dashboard", icon: "dashboard", match: ["/dashboard"], section: "Workspace" },
    { href: "/leads", label: "Leads", icon: "leads", match: ["/leads"], section: "Workspace" },
    isSabhiStaff(ctx) || !ctx.clientId
      ? { href: "/clients", label: "Clients", icon: "clients", match: ["/clients", "/lps"], section: "Workspace" }
      : { href: `/clients/${ctx.clientId}`, label: "Landing pages", icon: "clients", match: ["/clients", "/lps"], section: "Workspace" },
    ...(ctx.role === "SUPER_ADMIN"
      ? ([
          { href: "/users", label: "Sabhi team", icon: "team", match: ["/users"], section: "Admin" },
          { href: "/audit", label: "Audit log", icon: "audit", match: ["/audit"], section: "Admin" },
        ] satisfies NavItem[])
      : []),
  ];
  const seen = await prisma.user.findUnique({ where: { id: ctx.userId }, select: { leadsSeenAt: true } });
  const [unread, newLeads, own] = await Promise.all([
    unreadCount(ctx.userId),
    newLeadsCount(ctx, seen?.leadsSeenAt ?? null),
    // A client's own users see their client's name and logo in the sidebar.
    ctx.clientId ? prisma.client.findUnique({ where: { id: ctx.clientId }, select: { name: true, slug: true, logoUpdatedAt: true } }) : null,
  ]);
  return (
    <AppShell nav={nav} user={{ name: ctx.name, role: ROLE_LABEL[ctx.role] }} bell={{ unread, newLeads }} brand={own ? { name: own.name, logo: logoUrl(own) } : null} signOut={logoutAction}>
      {children}
    </AppShell>
  );
}
