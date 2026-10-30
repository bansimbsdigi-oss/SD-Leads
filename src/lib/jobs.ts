// Background job handlers, shared by the BullMQ worker and the in-process fallback (INLINE_JOBS=1).
import { logger } from "@/lib/logger";
import { deliverLead, fanOutLead } from "@/lib/outbound/webhooks";
import type { JobMap } from "@/lib/queue";

type Handlers = { [K in keyof JobMap]: (data: JobMap[K], attempt: number) => Promise<void> };

const handlers: Handlers = {
  async "lead.created"({ leadId }) {
    // Notifications and Meta enrichment will hook in here too.
    await fanOutLead(leadId);
  },
  async "webhook.deliver"({ integrationId, leadId }, attempt) {
    // Throws on failure so BullMQ retries with backoff; every attempt is in the delivery log.
    const result = await deliverLead(integrationId, leadId, attempt);
    logger.info({ integrationId, leadId, status: result.status, attempt }, "webhook delivered");
  },
};

export async function runJob<K extends keyof JobMap>(name: K, data: JobMap[K], attempt: number): Promise<void> {
  const handler = handlers[name] as Handlers[K] | undefined;
  if (!handler) throw new Error(`No handler for job ${name}`);
  await handler(data, attempt);
}
