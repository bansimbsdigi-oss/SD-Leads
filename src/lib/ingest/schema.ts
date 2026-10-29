import { z } from "zod";

export const MAX_FIELDS = 100;
export const MAX_VALUE_LENGTH = 5000;
export const MAX_BODY_BYTES = 256 * 1024;

const shortText = z.string().max(500);
const value = z.union([
  z.string().max(MAX_VALUE_LENGTH),
  z.array(z.string().max(MAX_VALUE_LENGTH)).max(100),
  z.number(),
  z.boolean(),
  z.null(),
]);

export const ingestFieldSchema = z.object({
  key: z.string().min(1).max(200),
  type: z.string().max(40).default("text"),
  label: shortText.optional(),
  role: z.enum(["name", "phone", "email"]).optional().nullable(),
  options: z.array(shortText).max(200).optional(),
  value,
  score: z.number().finite().optional().nullable(),
});

export const ingestPayloadSchema = z.object({
  submission_id: z.string().min(8).max(100),
  turnstile_token: z.string().max(4096).optional().nullable(),
  fields: z.array(ingestFieldSchema).min(1).max(MAX_FIELDS),
  tracking: z.record(z.string().max(2000)).optional().default({}),
  consent: z
    .object({ given: z.boolean(), text: z.string().max(2000).optional(), at: z.string().max(40).optional() })
    .optional()
    .nullable(),
});

export type IngestPayload = z.infer<typeof ingestPayloadSchema>;
export type IngestField = z.infer<typeof ingestFieldSchema>;
