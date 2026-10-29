// Creates (or resets the password of) a super admin. For production, where `db:seed` demo users are not wanted.
//   ADMIN_EMAIL=you@example.com ADMIN_NAME="Your Name" ADMIN_PASSWORD='...' tsx scripts/create-admin.ts
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../src/lib/password";

const prisma = new PrismaClient();
const { ADMIN_EMAIL: email, ADMIN_NAME: name = "Admin", ADMIN_PASSWORD: password } = process.env;

async function main() {
  if (!email || !password) throw new Error("Set ADMIN_EMAIL and ADMIN_PASSWORD");
  if (password.length < 12) throw new Error("ADMIN_PASSWORD must be at least 12 characters");
  const passwordHash = await hashPassword(password);
  await prisma.user.upsert({
    where: { email: email.toLowerCase() },
    update: { passwordHash, role: "SUPER_ADMIN", status: "active" },
    create: { email: email.toLowerCase(), name, passwordHash, role: "SUPER_ADMIN" },
  });
  console.log(`Super admin ready: ${email.toLowerCase()}`);
}

main().finally(() => prisma.$disconnect());
