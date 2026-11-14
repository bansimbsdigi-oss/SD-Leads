// Field manager: one list of a client's form columns across all its landing pages, to rename, hide or
// merge them. Columns are grouped exactly like the leads table (lib/leadQuery formFieldGroups).
import { prisma } from "@/lib/db";
import { groupKey } from "@/lib/leadQuery";
import { STANDARD_COLUMNS, standardKeyOf } from "@/lib/standardColumns";
import { can, canSeeClient, ForbiddenError, NotFoundError, type Ctx } from "@/lib/tenant";

const CORE_KEYS = new Set(["name", "phone", "email"]);

export type FieldColumn = {
  key: string;
  label: string;
  hidden: boolean;
  /** A fixed column that form fields were merged into: only "undo merge" applies. */
  fixed?: boolean;
  fields: { id: string; fieldKey: string; label: string; lpName: string; merged: boolean }[];
};

function assertEdit(ctx: Ctx, clientId: string) {
  if (!canSeeClient(ctx, clientId)) throw new NotFoundError("Client not found");
  if (!can.editFields(ctx, clientId)) throw new ForbiddenError();
}

async function clientFields(clientId: string) {
  const fields = await prisma.formField.findMany({
    where: { lp: { clientId } },
    orderBy: [{ position: "asc" }, { firstSeenAt: "asc" }],
    include: { lp: { select: { name: true } } },
  });
  return fields.map((f) => ({ ...f, key: f.mergeInto || groupKey(f.fieldKey, f.label) }));
}

/** The client's own form columns (not name / mobile / email or the fixed columns), with where they come from. */
export async function fieldColumns(ctx: Ctx, clientId: string): Promise<FieldColumn[]> {
  if (!canSeeClient(ctx, clientId)) throw new NotFoundError("Client not found");
  const byKey = new Map<string, FieldColumn>();
  for (const f of await clientFields(clientId)) {
    const std = f.mergeInto ? standardKeyOf(f.key) : undefined;
    if (std) {
      // Merged into a fixed column by hand: listed so it can be undone.
      const header = STANDARD_COLUMNS.find((c) => c.keys.includes(std))?.header ?? std;
      const col = byKey.get(`fixed:${std}`) ?? { key: `fixed:${std}`, label: header, hidden: false, fixed: true, fields: [] };
      col.fields.push({ id: f.id, fieldKey: f.fieldKey, label: f.label, lpName: f.lp.name, merged: true });
      byKey.set(col.key, col);
      continue;
    }
    if (f.role || CORE_KEYS.has(f.key) || standardKeyOf(f.key)) continue;
    const col = byKey.get(f.key) ?? { key: f.key, label: f.displayLabel || f.label, hidden: true, fields: [] };
    col.fields.push({ id: f.id, fieldKey: f.fieldKey, label: f.label, lpName: f.lp.name, merged: Boolean(f.mergeInto) });
    col.hidden &&= f.isHidden;
    if (f.displayLabel) col.label = f.displayLabel;
    byKey.set(f.key, col);
  }
  return [...byKey.values()];
}

/** Columns a column can be merged into: the client's other form columns, plus the fixed columns. */
export async function mergeTargets(ctx: Ctx, clientId: string) {
  const cols = await fieldColumns(ctx, clientId);
  return {
    form: cols.filter((c) => !c.fixed).map((c) => ({ key: c.key, label: c.label })),
    fixed: STANDARD_COLUMNS.map((c) => ({ key: c.keys[0], label: c.header })),
  };
}

const inColumn = async (clientId: string, key: string) => (await clientFields(clientId)).filter((f) => f.key === key);

export async function renameColumn(ctx: Ctx, clientId: string, key: string, label: string) {
  assertEdit(ctx, clientId);
  const name = label.replace(/\s+/g, " ").trim().slice(0, 120);
  const fields = await inColumn(clientId, key);
  if (!fields.length) throw new NotFoundError("Column not found");
  await prisma.formField.updateMany({ where: { id: { in: fields.map((f) => f.id) } }, data: { displayLabel: name || null } });
  await prisma.auditLog.create({ data: { actorId: ctx.userId, clientId, action: "field.rename", target: key } });
}

export async function setColumnHidden(ctx: Ctx, clientId: string, key: string, hidden: boolean) {
  assertEdit(ctx, clientId);
  const fields = await inColumn(clientId, key);
  if (!fields.length) throw new NotFoundError("Column not found");
  await prisma.formField.updateMany({ where: { id: { in: fields.map((f) => f.id) } }, data: { isHidden: hidden } });
  await prisma.auditLog.create({ data: { actorId: ctx.userId, clientId, action: hidden ? "field.hide" : "field.show", target: key } });
}

/** Shows column `from` inside column `into` (another form column or a fixed one). Undo per field. */
export async function mergeColumn(ctx: Ctx, clientId: string, from: string, into: string) {
  assertEdit(ctx, clientId);
  if (!into || from === into) throw new Error("Pick a different column to merge into.");
  const targets = await mergeTargets(ctx, clientId);
  if (![...targets.form, ...targets.fixed].some((t) => t.key === into)) throw new NotFoundError("Column not found");
  const fields = await inColumn(clientId, from);
  if (!fields.length) throw new NotFoundError("Column not found");
  // Fields merged into `from` earlier move along too, so nothing points at an empty column.
  await prisma.formField.updateMany({ where: { id: { in: fields.map((f) => f.id) } }, data: { mergeInto: into } });
  await prisma.auditLog.create({ data: { actorId: ctx.userId, clientId, action: "field.merge", target: `${from} → ${into}` } });
}

export async function unmergeField(ctx: Ctx, fieldId: string) {
  const field = await prisma.formField.findUnique({ where: { id: fieldId }, include: { lp: { select: { clientId: true } } } });
  if (!field) throw new NotFoundError("Field not found");
  assertEdit(ctx, field.lp.clientId);
  await prisma.formField.update({ where: { id: fieldId }, data: { mergeInto: null } });
  await prisma.auditLog.create({ data: { actorId: ctx.userId, clientId: field.lp.clientId, action: "field.unmerge", target: field.fieldKey } });
  return field.lp.clientId;
}
