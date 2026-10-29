// Background worker: slow or unreliable work (notifications, Meta, webhooks). Run with `pnpm worker`.
import { Worker } from "bullmq";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { QUEUE_NAME, redisConnection, type JobMap } from "@/lib/queue";

const connection = redisConnection();
if (!connection) {
  logger.error("REDIS_URL is not set; worker has nothing to do");
  process.exit(1);
}

const handlers: { [K in keyof JobMap]: (data: JobMap[K]) => Promise<void> } = {
  async "lead.created"({ leadId }) {
    const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { id: true, clientId: true, lpId: true } });
    if (!lead) return;
    // Phase 3: in-app / Web Push / email notifications. Phase 5: Meta enrichment. Phase 7: outbound webhooks.
    logger.info({ leadId, clientId: lead.clientId }, "lead.created processed");
  },
};

const worker = new Worker(
  QUEUE_NAME,
  async (job) => {
    const handler = handlers[job.name as keyof JobMap];
    if (!handler) throw new Error(`No handler for job ${job.name}`);
    await handler(job.data);
  },
  { connection, concurrency: 5 },
);

worker.on("failed", (job, err) => logger.error({ err, job: job?.name, id: job?.id }, "job failed"));
logger.info("worker started");

const shutdown = async () => {
  await worker.close();
  await prisma.$disconnect();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
