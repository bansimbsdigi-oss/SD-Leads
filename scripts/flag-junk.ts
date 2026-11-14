// One-off: flags existing leads that look fake (new leads are flagged as they arrive).
// In production (worker container): node_modules/.bin/tsx scripts/flag-junk.ts
import { prisma } from "../src/lib/db";
import { junkReasons } from "../src/lib/junk";

async function main() {
  let cursor: string | undefined;
  let flagged = 0;
  let seen = 0;
  for (;;) {
    const batch = await prisma.lead.findMany({
      where: { junkReasons: { isEmpty: true } },
      orderBy: { id: "asc" },
      take: 1000,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true, name: true, phoneNormalised: true, emailNormalised: true },
    });
    if (!batch.length) break;
    seen += batch.length;
    cursor = batch[batch.length - 1].id;
    for (const l of batch) {
      const reasons = junkReasons({ name: l.name, phone: l.phoneNormalised, email: l.emailNormalised });
      if (reasons.length) {
        await prisma.lead.update({ where: { id: l.id }, data: { junkReasons: reasons } });
        flagged++;
      }
    }
  }
  console.log(`checked ${seen} leads, flagged ${flagged} as possible junk`);
}

main().finally(() => prisma.$disconnect());
