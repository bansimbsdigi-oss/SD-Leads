// Client branding: a small logo shown on the client's pages, in their users' sidebar and on their own
// login link (/login?c=<slug>). SVG isn't accepted: it can carry scripts.
import { prisma } from "@/lib/db";
import { can, canSeeClient, ForbiddenError, NotFoundError, type Ctx } from "@/lib/tenant";

const MAX_BYTES = 300 * 1024;
const TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

/** Recognise the image from its first bytes, not the name or the browser's claim. */
function sniff(buf: Buffer): string | null {
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length > 12 && buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

function assertBrand(ctx: Ctx, clientId: string) {
  if (!canSeeClient(ctx, clientId)) throw new NotFoundError("Client not found");
  if (!can.manageLps(ctx, clientId)) throw new ForbiddenError();
}

export async function saveLogo(ctx: Ctx, clientId: string, file: File) {
  assertBrand(ctx, clientId);
  if (!file || file.size === 0) throw new Error("Choose an image first.");
  if (file.size > MAX_BYTES) throw new Error("The logo must be 300 KB or smaller. Try a PNG around 400 × 400 px.");
  const buf = Buffer.from(await file.arrayBuffer());
  const type = sniff(buf);
  if (!type || !TYPES.has(type)) throw new Error("Use a PNG, JPEG or WebP image.");
  await prisma.client.update({ where: { id: clientId }, data: { logo: buf, logoType: type, logoUpdatedAt: new Date() } });
  await prisma.auditLog.create({ data: { actorId: ctx.userId, clientId, action: "client.logo", target: clientId } });
}

export async function removeLogo(ctx: Ctx, clientId: string) {
  assertBrand(ctx, clientId);
  await prisma.client.update({ where: { id: clientId }, data: { logo: null, logoType: null, logoUpdatedAt: null } });
  await prisma.auditLog.create({ data: { actorId: ctx.userId, clientId, action: "client.logo_remove", target: clientId } });
}

/** Public URL of a client's logo (cache-busted by its update time), or null. */
export const logoUrl = (c: { slug: string; logoUpdatedAt: Date | null }) =>
  c.logoUpdatedAt ? `/api/brand/${encodeURIComponent(c.slug)}/logo?v=${c.logoUpdatedAt.getTime()}` : null;

/** Name and logo for a client login link. Only active clients. */
export async function brandBySlug(slug: string) {
  if (!slug || slug.length > 80) return null;
  const c = await prisma.client.findUnique({ where: { slug }, select: { name: true, slug: true, status: true, logoUpdatedAt: true } });
  return c && c.status === "active" ? { name: c.name, logo: logoUrl(c) } : null;
}
