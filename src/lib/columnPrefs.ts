// Columns each user hides from the leads table, remembered per view: "all" clients or one client id.
// Kept in the database, so the choice follows the user to any browser.
import { prisma } from "@/lib/db";
import { ALWAYS_SHOWN } from "@/lib/hiddenColumns";

const MAX_HIDDEN = 300;

export const columnScope = (clientId?: string | null) => clientId || "all";

export async function getHiddenColumns(userId: string, scope: string): Promise<Set<string>> {
  const pref = await prisma.columnPref.findUnique({ where: { userId_scope: { userId, scope } } });
  return new Set(pref?.hidden ?? []);
}

export async function saveHiddenColumns(userId: string, scope: string, ids: string[]) {
  const hidden = [...new Set(ids.map((id) => String(id).slice(0, 200)))].filter((id) => !ALWAYS_SHOWN.has(id)).slice(0, MAX_HIDDEN);
  await prisma.columnPref.upsert({
    where: { userId_scope: { userId, scope: scope.slice(0, 64) } },
    update: { hidden },
    create: { userId, scope: scope.slice(0, 64), hidden },
  });
}

export async function hideColumn(userId: string, scope: string, id: string) {
  const current = await getHiddenColumns(userId, scope);
  current.add(id);
  await saveHiddenColumns(userId, scope, [...current]);
}
