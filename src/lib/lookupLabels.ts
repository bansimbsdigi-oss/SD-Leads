// Lead lookup result names, shared by the lookup itself and the lead webhook payload (kept apart to
// avoid an import cycle between lib/lookup and lib/outbound/webhooks).
export type LeadType = "mentor" | "sub_mentor" | "none";

export const LEAD_TYPE_LABEL: Record<LeadType, string> = { mentor: "Mentor's lead", sub_mentor: "Sub-mentor's lead", none: "None of the above" };
