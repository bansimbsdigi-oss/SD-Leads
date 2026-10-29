// Local seed: two demo clients with LPs and one user per role. Password from SEED_PASSWORD.
import { PrismaClient, type Role } from "@prisma/client";
import { DEFAULT_STAGES } from "../src/lib/data";
import { hashPassword } from "../src/lib/password";
import { newWebhookToken } from "../src/lib/crypto";

const prisma = new PrismaClient();
const password = process.env.SEED_PASSWORD ?? "sabhi-demo-2026";

async function user(email: string, name: string, role: Role, clientId: string | null) {
  return prisma.user.upsert({
    where: { email },
    update: {},
    create: { email, name, role, clientId, passwordHash: await hashPassword(password) },
  });
}

async function client(name: string, slug: string, lps: { name: string; lpKey: string; domains: string[] }[]) {
  const c = await prisma.client.upsert({
    where: { slug },
    update: {},
    create: { name, slug, webhookToken: newWebhookToken(), pipelineStages: { create: DEFAULT_STAGES } },
  });
  for (const lp of lps) {
    await prisma.landingPage.upsert({
      where: { lpKey: lp.lpKey },
      update: {},
      create: { clientId: c.id, name: lp.name, lpKey: lp.lpKey, allowedDomains: lp.domains },
    });
  }
  return c;
}

async function main() {
  const ritu = await client("Ritu Agarwal", "ritu-agarwal", [
    { name: "Webinar Jan 2027", lpKey: "webinar-jan-2027", domains: ["localhost", "ritu-agarwal.example.com"] },
    { name: "Social Media Quiz", lpKey: "social-quiz", domains: ["localhost"] },
  ]);
  const fit = await client("FitWithNeha", "fit-with-neha", [
    { name: "Bootcamp Feb", lpKey: "bootcamp-feb", domains: ["localhost"] },
  ]);

  await user("admin@sabhi.test", "Sabhi Admin", "SUPER_ADMIN", null);
  const am = await user("am@sabhi.test", "Account Manager", "ACCOUNT_MANAGER", null);
  await prisma.clientManager.upsert({
    where: { userId_clientId: { userId: am.id, clientId: ritu.id } },
    update: {},
    create: { userId: am.id, clientId: ritu.id },
  });
  await user("ritu.admin@client.test", "Ritu (client admin)", "CLIENT_ADMIN", ritu.id);
  await user("ritu.member@client.test", "Ritu team member", "CLIENT_MEMBER", ritu.id);
  await user("neha.admin@client.test", "Neha (client admin)", "CLIENT_ADMIN", fit.id);

  console.log(`Seeded. All demo users share the password from SEED_PASSWORD (default in prisma/seed.ts).`);
}

main().finally(() => prisma.$disconnect());
