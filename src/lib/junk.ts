// Spots leads that look fake: test names, made-up numbers, throwaway emails. Only flags them (with the
// reasons); nothing is hidden or deleted unless someone chooses to.

const TEST_NAMES = new Set([
  "test", "testing", "tester", "asdf", "asd", "qwerty", "abc", "abcd", "xyz", "dummy", "demo", "fake", "aaa", "aaaa",
  "na", "n/a", "none", "nil", "null", "no name", "noname", "xxx", "zzz", "hello", "hi",
]);
const THROWAWAY_DOMAINS = new Set([
  "example.com", "example.org", "test.com", "testing.com", "mailinator.com", "yopmail.com", "tempmail.com", "temp-mail.org",
  "guerrillamail.com", "10minutemail.com", "sharklasers.com", "trashmail.com", "getnada.com", "dispostable.com", "fakeinbox.com",
]);

/** Last 10 digits look made up: one digit repeated, a run like 1234567890, or a short pattern repeated. */
function fakePhone(phone: string): boolean {
  const d = phone.replace(/\D/g, "").slice(-10);
  if (d.length < 10) return false;
  if (/^(\d)\1+$/.test(d)) return true;
  if ("01234567890123456789".includes(d) || "98765432109876543210".includes(d)) return true;
  return /^(\d{2})\1{4}$/.test(d) || /^(\d{5})\1$/.test(d);
}

export function junkReasons(lead: { name?: string | null; phone?: string | null; email?: string | null }): string[] {
  const reasons: string[] = [];
  const name = (lead.name ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  if (name) {
    const letters = name.replace(/[^a-z]/g, "");
    if (TEST_NAMES.has(name)) reasons.push("Test name");
    else if (/^[\d\s+()-]+$/.test(name)) reasons.push("Name is a number");
    else if (letters.length >= 5 && !/[aeiouy]/.test(letters)) reasons.push("Name looks like random typing");
    else if (/(.)\1{3,}/.test(letters)) reasons.push("Name looks like random typing");
  }
  if (lead.phone && fakePhone(lead.phone)) reasons.push("Phone looks made up");
  if (lead.email) {
    const [local = "", domain = ""] = lead.email.toLowerCase().split("@");
    if (THROWAWAY_DOMAINS.has(domain)) reasons.push("Throwaway or test email");
    else if (TEST_NAMES.has(local)) reasons.push("Test email");
  }
  return reasons;
}
