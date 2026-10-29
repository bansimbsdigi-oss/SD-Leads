// Times the real lead query + ingest code against a large dataset. Expects clients c1–c12 with LPs
// lp{c}_{1..5} (client c1 holding ~30% of leads), as loaded by scripts/bench-data.sql.
// Usage: DATABASE_URL=postgresql://…/sabhi_leads_bench pnpm exec tsx scripts/bench-leads.ts
import { prisma } from "../src/lib/db";
import { ingestPayloadSchema } from "../src/lib/ingest/schema";
import { ingestLead } from "../src/lib/ingest/service";
import { columnValues, leadFieldDefs, queryLeads, type LeadQuery } from "../src/lib/leadQuery";
import type { Ctx } from "../src/lib/tenant";

const admin: Ctx = { userId: "bench", role: "SUPER_ADMIN", clientId: null, managedClientIds: [], lpIds: [] };
const clientAdmin: Ctx = { userId: "bench", role: "CLIENT_ADMIN", clientId: "c1", managedClientIds: [], lpIds: [] };
const q = (o: Partial<LeadQuery>): LeadQuery => ({ conditions: [], dir: "desc", page: 1, pageSize: 25, ...o });

const cases: [string, Ctx, LeadQuery][] = [
  ["All clients, newest first", admin, q({})],
  ["Big client (300k), newest first", clientAdmin, q({ clientId: "c1" })],
  ["Big client, page 400", clientAdmin, q({ clientId: "c1", page: 400 })],
  ["Big client, 1000 rows/page", clientAdmin, q({ clientId: "c1", pageSize: 1000 })],
  ["Big client, search name 'priya gupta'", clientAdmin, q({ clientId: "c1", q: "priya gupta" })],
  ["Big client, search phone '00012345'", clientAdmin, q({ clientId: "c1", q: "00012345" })],
  ["Big client, search answer 'launch a course 99'", clientAdmin, q({ clientId: "c1", q: "launch a course 99" })],
  ["All clients, search 'sneha.reddy12'", admin, q({ q: "sneha.reddy12" })],
  ["Big client, sort name A→Z", clientAdmin, q({ clientId: "c1", sort: "name", dir: "asc" })],
  ["Big client, sort City Z→A", clientAdmin, q({ clientId: "c1", sort: "a:city", dir: "desc" })],
  ["Big client, Budget is 5L+", clientAdmin, q({ clientId: "c1", conditions: [{ field: "a:budget", op: "is", value: "5L+" }] })],
  ["Big client, Platforms is YouTube + 30 days", clientAdmin, q({ clientId: "c1", range: "30d", conditions: [{ field: "a:platforms", op: "is", value: "YouTube" }] })],
  ["Big client, City contains 'pun' + Today", clientAdmin, q({ clientId: "c1", range: "today", conditions: [{ field: "a:city", op: "contains", value: "pun" }] })],
  ["Big client, status Qualified, sort score", clientAdmin, q({ clientId: "c1", sort: "score", conditions: [{ field: "status", op: "is", value: "Qualified" }] })],
];

async function time<T>(fn: () => Promise<T>, runs = 3): Promise<[number, T]> {
  let best = Infinity;
  let out!: T;
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    out = await fn();
    best = Math.min(best, performance.now() - t);
  }
  return [best, out];
}

async function main() {
  console.log(`leads in db: ${await prisma.lead.count()}\n`);
  for (const [label, ctx, query] of cases) {
    const [ms, res] = await time(async () => {
      const defs = await leadFieldDefs(ctx, { clientId: query.clientId });
      return queryLeads(ctx, query, defs);
    });
    console.log(`${ms.toFixed(0).padStart(6)} ms  ${label.padEnd(48)} total=${res.total}${res.totalCapped ? "+" : ""} rows=${res.rows.length}`);
  }

  // Column "filter by values" lists (Sheets-style menus).
  for (const [label, field, extra] of [
    ["Big client, City values", "a:city", {}],
    ["Big client, Platforms values (multi-select)", "a:platforms", {}],
    ["Big client, Status values + 30 days", "status", { range: "30d" as const }],
  ] as const) {
    const query = q({ clientId: "c1", ...extra });
    const defs = await leadFieldDefs(clientAdmin, { clientId: "c1" });
    const [ms, res] = await time(() => columnValues(clientAdmin, query, defs, field));
    console.log(`${ms.toFixed(0).padStart(6)} ms  ${label.padEnd(48)} values=${res?.values.length}${res?.sampled ? " (sampled)" : ""}`);
  }

  // Concurrent ingest into the same LP of the big client (registry contention) and spread across clients.
  for (const spread of [false, true]) {
    const n = 300;
    const t = performance.now();
    let next = 0;
    await Promise.all(
      Array.from({ length: 20 }, async () => {
        while (next < n) {
          const i = next++;
          const c = spread ? 1 + (i % 12) : 1;
          const lp = { id: `lp${c}_1`, clientId: `c${c}`, currentFormVersion: null };
          await ingestLead(lp, ingestPayloadSchema.parse({
            submission_id: `bench-${spread}-${Date.now()}-${i}`,
            fields: [
              { key: "name", role: "name", value: `Bench ${i}` },
              { key: "phone", type: "tel", value: `97${String(i).padStart(8, "0")}` },
              { key: "city", value: "Pune" }, { key: "budget", type: "select", options: ["<1L", "1-5L", "5L+"], value: "5L+" },
              { key: "q1", type: "radio", options: ["Never", "Weekly", "Daily"], value: "Daily", score: 3 },
              { key: "goal", type: "textarea", value: "Launch a course" },
              { key: "platforms", type: "checkbox", options: ["Instagram", "YouTube", "LinkedIn"], value: ["YouTube"] },
            ],
          }));
        }
      }),
    );
    const s = (performance.now() - t) / 1000;
    console.log(`\ningest ${n} leads, 20 concurrent, ${spread ? "spread over 12 clients" : "all into one LP"}: ${s.toFixed(1)}s → ${(n / s).toFixed(0)} leads/s`);
  }
  await prisma.$disconnect();
}

main();
