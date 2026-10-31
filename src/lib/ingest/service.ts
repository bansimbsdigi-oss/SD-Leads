// Saves one LP form submission as a lead (plan section 6.3, steps 6–11).
import { Prisma, type FieldRole, type LandingPage } from "@prisma/client";
import { prisma } from "@/lib/db";
import { adjustDailyCounts } from "@/lib/dailyCounts";
import { enqueue } from "@/lib/queue";
import { assignFieldKeys, formVersionHash, toFieldKey } from "./fieldKeys";
import { normaliseEmail, normalisePhone } from "./normalise";
import { buildSearchText } from "./searchText";
import type { IngestField, IngestPayload } from "./schema";

const DEDUPE_WINDOW_DAYS = 30;

// Fields whose shared key is name / phone / email feed the core columns even without a data-role.
const CORE_ROLE_KEYS = new Set(["name", "phone", "email"]);

export type PreparedField = IngestField & { key: string; role: FieldRole | null };

/** Applies key rules and role detection (data-role, else input type). */
const isBlank = (v: unknown) => v === null || v === undefined || (typeof v === "string" && !v.trim()) || (Array.isArray(v) && v.length === 0);

/** Two values of the same field: keep the first filled one; different text is kept as "a, b". */
function mergeValues(a: IngestField["value"], b: IngestField["value"], keepFirst: boolean): IngestField["value"] {
  if (isBlank(a)) return b;
  if (isBlank(b) || keepFirst) return a;
  if (Array.isArray(a) || Array.isArray(b)) return [...new Set([...[a].flat(), ...[b].flat()].map(String))];
  if (typeof a === "string" && typeof b === "string") {
    return a.trim().toLowerCase() === b.trim().toLowerCase() ? a : `${a}, ${b}`;
  }
  return a;
}

/** Applies key rules and role detection (data-role, else input type / shared key); merges repeated fields. */
export function prepareFields(fields: IngestField[]): PreparedField[] {
  const keys = assignFieldKeys(fields.map((f) => f.key));
  const merged = new Map<string, PreparedField>();
  fields.forEach((f, i) => {
    const key = keys[i];
    const role: FieldRole | null =
      f.role ??
      (f.type === "tel" ? "phone" : f.type === "email" ? "email" : key === "whatsapp" ? "phone" : CORE_ROLE_KEYS.has(key) ? (key as FieldRole) : null);
    const current = merged.get(key);
    if (!current) {
      merged.set(key, { ...f, key, type: f.type.toLowerCase(), role });
      return;
    }
    // Contact fields keep their first value (two numbers joined would be neither); others keep both.
    current.value = mergeValues(current.value, f.value, CORE_ROLE_KEYS.has(key) || key === "whatsapp");
    current.role ??= role;
    if (!current.label?.trim()) current.label = f.label;
    current.options ??= f.options;
    if (current.score == null) current.score = f.score;
  });
  return [...merged.values()];
}

const textValue = (f: PreparedField) => (typeof f.value === "string" ? f.value.trim() : "");

/**
 * First email / phone that is actually valid, so a "yes" or a blank field can't hide the real one.
 * The phone prefers a real phone field; a WhatsApp number is only used when there's none.
 */
function firstValid(fields: PreparedField[], role: "email" | "phone", normalise: (v: string) => string | null): string | null {
  const ordered = [...fields].sort((a, b) => Number(a.key === "whatsapp") - Number(b.key === "whatsapp"));
  for (const f of ordered) {
    if (f.role !== role) continue;
    const v = textValue(f) && normalise(textValue(f));
    if (v) return v;
  }
  return null;
}

/** The person's name: a "name" field first, else first + last name, else any other name-role field. */
function pickName(fields: PreparedField[]): string | null {
  const named = (key: string) => fields.find((f) => f.key === key && textValue(f));
  const full = named("name");
  if (full) return textValue(full);
  const parts = [named("first_name"), named("last_name")].filter(Boolean).map((f) => textValue(f!));
  if (parts.length) return parts.join(" ");
  const any = fields.find((f) => f.role === "name" && textValue(f));
  return any ? textValue(any) : null;
}

// last_seen_at is refreshed at most this often, so steady traffic doesn't rewrite registry rows.
const LAST_SEEN_REFRESH_MS = 60 * 60_000;

/**
 * Registers new fields and returns the form version id for this field set. Reads first and only
 * writes what changed: in steady state a submission touches no registry rows, so concurrent leads
 * on one LP never queue behind each other's row locks.
 */
export async function registerFields(
  tx: Prisma.TransactionClient,
  lp: Pick<LandingPage, "id" | "currentFormVersion">,
  fields: PreparedField[],
): Promise<string> {
  const now = new Date();
  const existing = await tx.formField.findMany({
    where: { lpId: lp.id },
    select: { fieldKey: true, label: true, inputType: true, options: true, lastSeenAt: true },
  });
  const byKey = new Map(existing.map((f) => [f.fieldKey, f]));

  const fresh = fields.filter((f) => !byKey.has(f.key));
  if (fresh.length) {
    await tx.formField.createMany({
      data: fresh.map((f, i) => ({
        lpId: lp.id,
        fieldKey: f.key,
        label: f.label?.trim() || f.key,
        inputType: f.type,
        options: f.options ?? Prisma.JsonNull,
        role: f.role,
        position: existing.length + i,
        firstSeenAt: now,
        lastSeenAt: now,
      })),
      skipDuplicates: true, // another submission may have registered it a moment ago
    });
  }

  // Label/options changes are registry updates; answers already stored are never rewritten.
  // A "label" that is just the raw key (plain webhook posts) never replaces a real label.
  const stale: string[] = [];
  for (const f of fields) {
    const current = byKey.get(f.key);
    if (!current) continue;
    const label = f.label?.trim();
    const realLabel = label && toFieldKey(label) !== f.key ? label : null;
    const changes: Prisma.FormFieldUpdateManyMutationInput = {};
    if (current.inputType !== f.type) changes.inputType = f.type;
    if (realLabel && realLabel !== current.label) changes.label = realLabel;
    if (f.options && JSON.stringify(f.options) !== JSON.stringify(current.options)) changes.options = f.options;
    if (Object.keys(changes).length) {
      await tx.formField.updateMany({ where: { lpId: lp.id, fieldKey: f.key }, data: { ...changes, lastSeenAt: now } });
    } else if (now.getTime() - current.lastSeenAt.getTime() > LAST_SEEN_REFRESH_MS) {
      stale.push(f.key);
    }
  }
  if (stale.length) {
    await tx.formField.updateMany({ where: { lpId: lp.id, fieldKey: { in: stale } }, data: { lastSeenAt: now } });
  }

  const versionHash = formVersionHash(fields);
  const where = { lpId_versionHash: { lpId: lp.id, versionHash } };
  let version = await tx.formVersion.findUnique({ where, select: { id: true } });
  let isNew = false;
  if (!version) {
    const created = await tx.formVersion.createMany({
      data: [{ lpId: lp.id, versionHash, fieldKeys: fields.map((f) => f.key) }],
      skipDuplicates: true,
    });
    isNew = created.count > 0;
    version = await tx.formVersion.findUniqueOrThrow({ where, select: { id: true } });
  }
  // The newest field set becomes "current". Forms that alternate between known versions
  // (conditional fields) don't flip the LP row on every lead.
  if (lp.currentFormVersion !== version.id && (isNew || !lp.currentFormVersion)) {
    await tx.landingPage.update({ where: { id: lp.id }, data: { currentFormVersion: version.id } });
  }
  return version.id;
}

export type IngestResult = { leadId: string; created: boolean; duplicateOfId: string | null };

export async function ingestLead(
  lp: Pick<LandingPage, "id" | "clientId" | "currentFormVersion">,
  payload: IngestPayload,
  source = "lp",
): Promise<IngestResult> {
  const existing = await prisma.lead.findUnique({
    where: { lpId_submissionId: { lpId: lp.id, submissionId: payload.submission_id } },
    select: { id: true, duplicateOfId: true },
  });
  if (existing) return { leadId: existing.id, created: false, duplicateOfId: existing.duplicateOfId };

  const fields = prepareFields(payload.fields);
  const phone = firstValid(fields, "phone", normalisePhone);
  const email = firstValid(fields, "email", normaliseEmail);
  const name = pickName(fields)?.slice(0, 200) ?? null;

  const answers: Record<string, unknown> = {};
  const scores: Record<string, number> = {};
  for (const f of fields) {
    answers[f.key] = f.value;
    if (typeof f.score === "number") scores[f.key] = f.score;
  }
  const scoreValues = Object.values(scores);
  const totalScore = scoreValues.length ? Math.round(scoreValues.reduce((a, b) => a + b, 0)) : null;

  try {
    const result = await prisma.$transaction(async (tx) => {
      const formVersionId = await registerFields(tx, lp, fields);

      const since = new Date(Date.now() - DEDUPE_WINDOW_DAYS * 86_400_000);
      const contactMatch = [
        ...(phone ? [{ phoneNormalised: phone }] : []),
        ...(email ? [{ emailNormalised: email }] : []),
      ];
      const original = contactMatch.length
        ? await tx.lead.findFirst({
            where: { clientId: lp.clientId, createdAt: { gte: since }, OR: contactMatch },
            orderBy: { createdAt: "asc" },
            select: { id: true },
          })
        : null;

      const firstStage = await tx.pipelineStage.findFirst({
        where: { clientId: lp.clientId },
        orderBy: { position: "asc" },
        select: { id: true },
      });

      const lead = await tx.lead.create({
        data: {
          clientId: lp.clientId,
          lpId: lp.id,
          formVersionId,
          statusId: firstStage?.id,
          submissionId: payload.submission_id,
          name,
          phoneNormalised: phone,
          emailNormalised: email,
          answers: answers as Prisma.InputJsonObject,
          scores,
          totalScore,
          searchText: buildSearchText({ name, email, phone, answers }),
          tracking: payload.tracking ?? {},
          consent: payload.consent ?? {},
          source,
          isDuplicate: Boolean(original),
          duplicateOfId: original?.id,
          events: {
            create: [
              { type: "created", payload: { source } },
              ...(original ? [{ type: "duplicate_of" as const, payload: { leadId: original.id } }] : []),
            ],
          },
        },
        select: { id: true, duplicateOfId: true, clientId: true, lpId: true, createdAt: true, isDuplicate: true },
      });
      await adjustDailyCounts(tx, [lead], 1);
      return lead;
    });

    await enqueue("lead.created", { leadId: result.id });
    return { leadId: result.id, created: true, duplicateOfId: result.duplicateOfId };
  } catch (err) {
    // Two identical submits racing: the unique (lp_id, submission_id) index lets one win.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const winner = await prisma.lead.findUnique({
        where: { lpId_submissionId: { lpId: lp.id, submissionId: payload.submission_id } },
        select: { id: true, duplicateOfId: true },
      });
      if (winner) return { leadId: winner.id, created: false, duplicateOfId: winner.duplicateOfId };
    }
    throw err;
  }
}
