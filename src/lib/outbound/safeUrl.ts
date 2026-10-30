// Outbound webhook URLs are typed in by users, so the server must never be tricked into calling
// itself or other services on the VPS (SSRF). Only public https endpoints are allowed.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const PRIVATE_V4: [number, number][] = [
  [0x0a000000, 8], // 10/8
  [0x7f000000, 8], // 127/8
  [0xa9fe0000, 16], // 169.254/16 (cloud metadata)
  [0xac100000, 12], // 172.16/12
  [0xc0a80000, 16], // 192.168/16
  [0x64400000, 10], // 100.64/10 (carrier NAT)
  [0x00000000, 8], // 0/8
  [0xe0000000, 4], // multicast
];

function isPrivateV4(ip: string): boolean {
  const n = ip.split(".").reduce((a, b) => (a << 8) + Number(b), 0) >>> 0;
  return PRIVATE_V4.some(([base, bits]) => (n >>> (32 - bits)) === (base >>> (32 - bits)));
}

function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 4) return isPrivateV4(ip);
  const v6 = ip.toLowerCase();
  if (v6.startsWith("::ffff:")) return isPrivateV4(v6.slice(7));
  return v6 === "::" || v6 === "::1" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe80");
}

/** Local development and tests may point at localhost; never in production. */
const allowPrivate = () => process.env.ALLOW_PRIVATE_WEBHOOKS === "1" && process.env.NODE_ENV !== "production";

/** Shape check for the form: returns an error message, or null when the URL is acceptable. */
export function webhookUrlProblem(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return "Enter a full URL, starting with https://";
  }
  if (url.protocol !== "https:" && !(allowPrivate() && url.protocol === "http:")) return "The URL must start with https://";
  if (url.username || url.password) return "The URL can't contain a username or password";
  if (!allowPrivate() && (url.hostname === "localhost" || url.hostname.endsWith(".local") || (isIP(url.hostname) && isPrivateIp(url.hostname)))) {
    return "The URL must be a public internet address";
  }
  if (raw.length > 2000) return "The URL is too long";
  return null;
}

/** Full check right before sending: also resolves DNS, so a public name can't point at a private IP. */
export async function assertSafeWebhookUrl(raw: string): Promise<URL> {
  const problem = webhookUrlProblem(raw);
  if (problem) throw new Error(problem);
  const url = new URL(raw.trim());
  if (allowPrivate()) return url;
  const addresses = isIP(url.hostname) ? [{ address: url.hostname }] : await lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some((a) => isPrivateIp(a.address))) throw new Error("The URL resolves to a private address");
  return url;
}
