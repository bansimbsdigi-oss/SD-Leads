// Public ingest protection: origin allow-list, rate limits, Turnstile (plan section 6.3 steps 2–4).

/** Origin must match an allowed domain exactly or be a subdomain of it (www.example.com for example.com). */
export function isOriginAllowed(origin: string | null, allowedDomains: string[]): boolean {
  if (!origin) return false;
  let host: string;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }
  return allowedDomains.some((d) => {
    const domain = d.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/:\d+$/, "");
    return domain !== "" && (host === domain || host.endsWith(`.${domain}`));
  });
}

// In-memory fixed-window limiter. Fine for a single app process; move to Redis when scaling out.
const buckets = new Map<string, { count: number; resetAt: number }>();

export function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    if (buckets.size > 50_000) for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
    return true;
  }
  bucket.count += 1;
  return bucket.count <= limit;
}

export const RATE_LIMITS = {
  perIp: { limit: 20, windowMs: 60_000 },
  perLp: { limit: 600, windowMs: 60_000 },
};

/** Verifies a Cloudflare Turnstile token. Skipped when TURNSTILE_SECRET_KEY is unset (local dev). */
export async function verifyTurnstile(token: string | null | undefined, ip: string | null): Promise<boolean> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return true;
  if (!token) return false;
  const body = new URLSearchParams({ secret, response: token, ...(ip ? { remoteip: ip } : {}) });
  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body });
    const json = (await res.json()) as { success?: boolean };
    return json.success === true;
  } catch {
    return false;
  }
}
