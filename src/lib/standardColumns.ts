// The fixed lead column layout, the same for every client (matches Sabhi's lead sheets).
// Each column lists the stored keys that can fill it; a value is taken from the form answers or the
// tracking data, whichever has it first. Keys are compared after the usual normalisation (lowercase,
// underscores), so "Pixel_ID", "pixel id" and "PIXEL_ID" all land in Pixel_ID.
// Anything a form sends that isn't listed here gets its own column at the end.
import { normalisePhone } from "@/lib/ingest/normalise";

export type StandardColumn = {
  id: string;
  header: string;
  keys: string[];
  /** Used when no key has a value. */
  fallback?: "whatsapp_from_phone" | "received_via";
};

const col = (id: string, header: string, keys: string[], fallback?: StandardColumn["fallback"]): StandardColumn => ({
  id: `s:${id}`,
  header,
  keys,
  fallback,
});

/** Shown after Date of Registration, name, Mobile and email (which come from the lead itself). */
export const STANDARD_COLUMNS: StandardColumn[] = [
  col("tag", "tag", ["tag", "tags", "lead_tag"]),
  col("whatsapp", "Formatted WhatsApp Number", ["formatted_whatsapp_number", "whatsapp_formatted", "formatted_whatsapp", "whatsapp"], "whatsapp_from_phone"),
  col("source", "Source", ["source", "lead_source"], "received_via"),
  col("utm_term", "utm_term", ["utm_term"]),
  col("utm_source", "utm_source", ["utm_source"]),
  col("utm_content", "utm_content", ["utm_content"]),
  col("utm_campaign", "utm_campaign", ["utm_campaign"]),
  col("utm_placement", "utm_placement", ["utm_placement"]),
  col("fbclid", "fbclid", ["fbclid"]),
  col("gclid", "gclid", ["gclid"]),
  col("utm_medium", "utm_medium", ["utm_medium"]),
  col("zoom_direct_link", "Zoom Direct LInk", ["zoom_direct_link"]),
  col("zoom_direct_button", "Zoom Direct Button", ["zoom_direct_button"]),
  col("zoom_webinar_link", "Zoom Webinar Link", ["zoom_webinar_link"]),
  col("zoom_webinar_button", "Zoom Webinar Button", ["zoom_webinar_button"]),
  col("new_zoom_direct_link", "New Zoom Direct Link", ["new_zoom_direct_link"]),
  col("new_zoom_direct_button", "New Zoom Direct Button", ["new_zoom_direct_button"]),
  col("fbc", "Fbc", ["fbc", "_fbc"]),
  col("fbp", "Fbp", ["fbp", "_fbp"]),
  col("pixel_id", "Pixel_ID", ["pixel_id", "pixelid"]),
  col("source_platform", "Source_Platform", ["source_platform"]),
  col("timestamp", "Timestamp", ["timestamp", "event_time", "submitted_at", "submittedat"]),
  col("ip_address", "IP Address", ["ip_address", "client_ip_address", "ip", "remote_ip"]),
  col("useragent", "UserAgent", ["useragent", "user_agent", "client_user_agent"]),
  col("accesst", "AccessT", ["accesst", "access_t"]),
  col("campaign_id", "Campaign_ID", ["campaign_id"]),
  col("adset_id", "Adset_ID", ["adset_id", "ad_set_id"]),
  col("ad_id", "Ad_ID", ["ad_id"]),
];

/** Keys already shown by a fixed column; they don't get an extra column at the end. */
export const STANDARD_KEYS = new Set(STANDARD_COLUMNS.flatMap((c) => c.keys));

/**
 * Keys to read for a column: its own keys plus the "_2"/"_3" copies older leads may have (the same field
 * sent twice used to be stored under a suffixed key).
 */
export const readKeys = (c: StandardColumn) => c.keys.flatMap((k) => [k, `${k}_2`, `${k}_3`]);

/** "+91 98765 43210" / "9876543210" -> "919876543210" (the format WhatsApp links use). */
export function formatWhatsApp(raw: string): string {
  const e164 = normalisePhone(raw);
  return e164 ? e164.slice(1) : raw.trim();
}

export const RECEIVED_VIA_LABEL: Record<string, string> = { lp: "LP snippet", webhook: "Webhook", meta_instant_form: "Meta form" };

/** Value of a fixed column for one lead. */
export function standardValue(
  c: StandardColumn,
  lead: { answers: unknown; tracking: unknown; phoneNormalised: string | null; source: string },
  format: (v: unknown) => string,
): string {
  const answers = (lead.answers ?? {}) as Record<string, unknown>;
  const tracking = (lead.tracking ?? {}) as Record<string, unknown>;
  for (const k of readKeys(c)) {
    for (const v of [answers[k], tracking[k]]) {
      const s = format(v);
      if (s.trim()) return c.fallback === "whatsapp_from_phone" ? formatWhatsApp(s) : s;
    }
  }
  if (c.fallback === "whatsapp_from_phone") return lead.phoneNormalised?.replace(/^\+/, "") ?? "";
  if (c.fallback === "received_via") return RECEIVED_VIA_LABEL[lead.source] ?? lead.source;
  return "";
}
