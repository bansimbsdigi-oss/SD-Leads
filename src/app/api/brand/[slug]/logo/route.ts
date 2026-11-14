import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

/** GET /api/brand/{slug}/logo → the client's logo. Public, so it can show on the client's login link. */
export async function GET(_: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const c = await prisma.client.findUnique({ where: { slug }, select: { logo: true, logoType: true, status: true } });
  if (!c?.logo || !c.logoType || c.status !== "active") return new NextResponse(null, { status: 404 });
  return new NextResponse(new Uint8Array(c.logo), {
    headers: {
      "Content-Type": c.logoType,
      "Cache-Control": "public, max-age=86400, immutable", // the URL changes (?v=) when the logo does
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'",
    },
  });
}
