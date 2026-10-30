// Background worker: slow or unreliable work (notifications, Meta, webhooks). Run with `pnpm worker`.
import { Worker } from "bullmq";
import { prisma } from "@/lib/db";
import { runJob } from "@/lib/jobs";
import { logger } from "@/lib/logger";
import { QUEUE_NAME, redisConnection, type JobMap } from "@/lib/queue";

const connection = redisConnection();
if (!connection) {
  logger.error("REDIS_URL is not set; worker has nothing to do");
  process.exit(1);
}

const worker = new Worker(
  QUEUE_NAME,
  (job) => runJob(job.name as keyof JobMap, job.data, job.attemptsMade + 1),
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
