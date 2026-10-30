// Creates a super admin, or resets an existing one's password. Prints only the new password.
// In production (worker container): node_modules/.bin/tsx scripts/create-admin.ts you@example.com "Your Name"
import { randomBytes } from "node:crypto";
import { prisma } from "../src/lib/db";
import { hashPassword } from "../src/lib/password";

async function main() {
  const [rawEmail, name = "Super admin"] = process.argv.slice(2);
  const email = rawEmail?.trim().toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    console.error("Usage: create-admin.ts <email> [name]");
    process.exit(1);
  }
  const password = randomBytes(12).toString("base64url");
  const passwordHash = await hashPassword(password);
  await prisma.user.upsert({
    where: { email },
    update: { passwordHash, role: "SUPER_ADMIN", status: "active", clientId: null },
    create: { email, name, role: "SUPER_ADMIN", clientId: null, passwordHash },
  });
  await prisma.auditLog.create({ data: { action: "user.create", target: email } });
  console.log(password);
}

main().finally(() => prisma.$disconnect());
