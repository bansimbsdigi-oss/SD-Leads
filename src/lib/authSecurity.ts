// Sign-in protection: attempt limits, password changes and one-time reset links.
import { createHash, randomBytes } from "node:crypto";
import { prisma } from "@/lib/db";
import { sendMail } from "@/lib/mail";
import { hashPassword, verifyPassword } from "@/lib/password";

const WINDOW_MS = 15 * 60_000;
const MAX_FAILS_PER_EMAIL = 5;
const MAX_FAILS_PER_IP = 20;
const MIN_PASSWORD = 10;

export const normaliseEmail = (email: string) => email.trim().toLowerCase();

/** Minutes until sign-in is allowed again, or 0 when it isn't blocked. */
export async function loginBlockedFor(email: string, ip: string): Promise<number> {
  const since = new Date(Date.now() - WINDOW_MS);
  const [byEmail, byIp] = await Promise.all([
    prisma.loginAttempt.findMany({ where: { email, success: false, createdAt: { gte: since } }, orderBy: { createdAt: "asc" }, select: { createdAt: true } }),
    prisma.loginAttempt.count({ where: { ip, success: false, createdAt: { gte: since } } }),
  ]);
  if (byEmail.length < MAX_FAILS_PER_EMAIL && byIp < MAX_FAILS_PER_IP) return 0;
  const oldest = byEmail[0]?.createdAt.getTime() ?? Date.now();
  return Math.max(1, Math.ceil((oldest + WINDOW_MS - Date.now()) / 60_000));
}

export async function recordLogin(email: string, ip: string, success: boolean) {
  await prisma.loginAttempt.create({ data: { email, ip, success } });
  // A successful sign-in clears that email's failures; old rows are trimmed now and then.
  if (success) await prisma.loginAttempt.deleteMany({ where: { email, success: false } });
  if (Math.random() < 0.02) await prisma.loginAttempt.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - 7 * 86_400_000) } } });
}

export function passwordProblem(password: string, confirm?: string): string | null {
  if (password.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (password.length > 200) return "That password is too long.";
  if (confirm !== undefined && password !== confirm) return "The two passwords don't match.";
  return null;
}

/** Sets a new password and signs out every existing session of that user. */
export async function setPassword(userId: string, password: string) {
  await prisma.user.update({ where: { id: userId }, data: { passwordHash: await hashPassword(password), passwordChangedAt: new Date() } });
}

export async function changeOwnPassword(userId: string, current: string, next: string, confirm: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (!(await verifyPassword(user.passwordHash, current))) throw new Error("Your current password isn't right.");
  const problem = passwordProblem(next, confirm);
  if (problem) throw new Error(problem);
  if (await verifyPassword(user.passwordHash, next)) throw new Error("Pick a password you haven't used here.");
  await setPassword(userId, next);
  await prisma.auditLog.create({ data: { actorId: userId, clientId: user.clientId, action: "user.password_change", target: userId } });
}

// ---------- Forgot password ----------

const RESET_TTL_MS = 60 * 60_000;
const MAX_RESETS_PER_HOUR = 3;
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/**
 * Emails a one-time reset link when the email belongs to an active login. Always resolves the same way,
 * so the form never reveals which emails exist.
 */
export async function requestPasswordReset(rawEmail: string, appUrl: string): Promise<void> {
  const email = normaliseEmail(rawEmail);
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || user.status !== "active") return;
  const recent = await prisma.passwordReset.count({ where: { userId: user.id, createdAt: { gte: new Date(Date.now() - 60 * 60_000) } } });
  if (recent >= MAX_RESETS_PER_HOUR) return;

  const token = randomBytes(32).toString("base64url");
  await prisma.$transaction([
    // Only the newest link works. Older ones are expired, not deleted, so they still count towards the hourly limit.
    prisma.passwordReset.updateMany({ where: { userId: user.id, usedAt: null, expiresAt: { gt: new Date() } }, data: { expiresAt: new Date() } }),
    prisma.passwordReset.create({ data: { userId: user.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + RESET_TTL_MS) } }),
  ]);
  const link = `${appUrl.replace(/\/$/, "")}/reset?token=${token}`;
  await sendMail({
    to: user.email,
    subject: "Reset your Sabhi Leads password",
    text: `Hi ${user.name},\n\nSomeone asked to reset the password for ${user.email} on Sabhi Leads.\nOpen this link within 1 hour to choose a new one:\n\n${link}\n\nIf it wasn't you, ignore this email: your password stays the same.\n\nSabhi Digital`,
    html: `<p>Hi ${escapeHtml(user.name)},</p><p>Someone asked to reset the password for <b>${escapeHtml(user.email)}</b> on Sabhi Leads.</p><p><a href="${link}" style="display:inline-block;padding:10px 18px;background:#1b3461;color:#fff;border-radius:8px;text-decoration:none">Choose a new password</a></p><p style="color:#666">The link works once, for 1 hour. If it wasn't you, ignore this email: your password stays the same.</p><p>Sabhi Digital</p>`,
  });
}

/** The user a reset link belongs to, while it's still unused and unexpired. */
export async function resetTokenUser(token: string) {
  if (!token || token.length > 200) return null;
  const reset = await prisma.passwordReset.findUnique({ where: { tokenHash: hashToken(token) }, include: { user: { select: { id: true, email: true, status: true, clientId: true } } } });
  if (!reset || reset.usedAt || reset.expiresAt < new Date() || reset.user.status !== "active") return null;
  return { resetId: reset.id, ...reset.user };
}

export async function resetPassword(token: string, password: string, confirm: string) {
  const found = await resetTokenUser(token);
  if (!found) throw new Error("This reset link has expired or was already used. Ask for a new one.");
  const problem = passwordProblem(password, confirm);
  if (problem) throw new Error(problem);
  // Claim the link first, so two quick submits can't both use it.
  const claimed = await prisma.passwordReset.updateMany({ where: { id: found.resetId, usedAt: null }, data: { usedAt: new Date() } });
  if (claimed.count === 0) throw new Error("This reset link was already used. Ask for a new one.");
  await setPassword(found.id, password);
  await prisma.auditLog.create({ data: { actorId: found.id, clientId: found.clientId, action: "user.password_reset", target: found.id } });
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
