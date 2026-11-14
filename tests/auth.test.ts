import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { hashPassword, verifyPassword } from "@/lib/password";
import { resetDb } from "./helpers";

const sent: { to: string; text: string }[] = [];
vi.mock("@/lib/mail", () => ({
  mailConfigured: () => true,
  sendMail: async (m: { to: string; text: string }) => {
    sent.push(m);
    return true;
  },
}));

async function user(email = "asha@sabhi.test", password = "old-password-123") {
  return prisma.user.create({ data: { email, name: "Asha", role: "ACCOUNT_MANAGER", passwordHash: await hashPassword(password) } });
}
const linkToken = () => /token=([\w-]+)/.exec(sent.at(-1)?.text ?? "")?.[1] ?? "";

describe("sign-in protection", () => {
  beforeEach(async () => {
    await resetDb();
    await prisma.loginAttempt.deleteMany();
    sent.length = 0;
  });

  it("blocks an email after 5 wrong passwords in 15 minutes; a success clears it", async () => {
    const { loginBlockedFor, recordLogin } = await import("@/lib/authSecurity");
    for (let i = 0; i < 4; i++) await recordLogin("a@x.test", "1.1.1.1", false);
    expect(await loginBlockedFor("a@x.test", "1.1.1.1")).toBe(0);
    await recordLogin("a@x.test", "1.1.1.1", false);
    const wait = await loginBlockedFor("a@x.test", "2.2.2.2");
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(15);
    expect(await loginBlockedFor("someone-else@x.test", "3.3.3.3")).toBe(0);
    await recordLogin("a@x.test", "1.1.1.1", true);
    expect(await loginBlockedFor("a@x.test", "1.1.1.1")).toBe(0);
  });

  it("change password: needs the current one, rejects short or mismatched, signs out old sessions", async () => {
    const { changeOwnPassword } = await import("@/lib/authSecurity");
    const u = await user();
    await expect(changeOwnPassword(u.id, "wrong", "new-password-456", "new-password-456")).rejects.toThrow(/current password/);
    await expect(changeOwnPassword(u.id, "old-password-123", "short", "short")).rejects.toThrow(/10 characters/);
    await expect(changeOwnPassword(u.id, "old-password-123", "new-password-456", "different-456")).rejects.toThrow(/match/);
    await changeOwnPassword(u.id, "old-password-123", "new-password-456", "new-password-456");
    const after = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(await verifyPassword(after.passwordHash, "new-password-456")).toBe(true);
    expect(after.passwordChangedAt).not.toBeNull();
    expect(await prisma.auditLog.count({ where: { action: "user.password_change", target: u.id } })).toBe(1);
  });

  it("forgot password: emails a one-time link that works once, within the hour", async () => {
    const { requestPasswordReset, resetPassword, resetTokenUser } = await import("@/lib/authSecurity");
    const u = await user();
    await requestPasswordReset("nobody@sabhi.test", "https://app.test");
    expect(sent).toHaveLength(0); // unknown email: nothing sent, same answer on screen
    await requestPasswordReset("  ASHA@sabhi.test ", "https://app.test");
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("https://app.test/reset?token=");
    const token = linkToken();
    expect((await resetTokenUser(token))?.id).toBe(u.id);
    expect(await prisma.passwordReset.findFirst({ where: { tokenHash: token } })).toBeNull(); // only the hash is stored

    await expect(resetPassword(token, "brand-new-pass-1", "nope")).rejects.toThrow(/match/);
    await resetPassword(token, "brand-new-pass-1", "brand-new-pass-1");
    expect(await verifyPassword((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).passwordHash, "brand-new-pass-1")).toBe(true);
    await expect(resetPassword(token, "another-pass-22", "another-pass-22")).rejects.toThrow(/expired|used/);

    // A newer link replaces the old one; an expired link is refused.
    await requestPasswordReset(u.email, "https://app.test");
    const first = linkToken();
    await requestPasswordReset(u.email, "https://app.test");
    expect(await resetTokenUser(first)).toBeNull();
    await prisma.passwordReset.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await resetTokenUser(linkToken())).toBeNull();
  });

  it("at most 3 reset emails per hour per login, and none for disabled logins", async () => {
    const { requestPasswordReset } = await import("@/lib/authSecurity");
    const u = await user();
    for (let i = 0; i < 5; i++) await requestPasswordReset(u.email, "https://app.test");
    expect(sent).toHaveLength(3);
    await prisma.user.update({ where: { id: u.id }, data: { status: "disabled" } });
    await prisma.passwordReset.deleteMany();
    await requestPasswordReset(u.email, "https://app.test");
    expect(sent).toHaveLength(3);
  });

  it("an admin setting a new password also signs that user out", async () => {
    const { updateUser } = await import("@/lib/data");
    const { makeUser } = await import("./helpers");
    const admin = await makeUser("SUPER_ADMIN", null);
    const u = await user();
    await updateUser(admin, u.id, { name: "Asha", email: u.email, role: "ACCOUNT_MANAGER", status: "active", password: "admin-set-pass-1" });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).passwordChangedAt).not.toBeNull();
  });
});
