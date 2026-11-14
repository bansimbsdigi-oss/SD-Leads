// Background worker: slow or unreliable work (notifications, Meta, webhooks). Run with `pnpm worker`.
import { Worker } from "bullmq";
import { prisma } from "@/lib/db";
import { runJob } from "@/lib/jobs";
import { logger } from "@/lib/logger";
import { recordError } from "@/lib/errors";
import { checkQuietLandingPages } from "@/lib/notifications";
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

worker.on("failed", (job, err) => {
  logger.error({ err, job: job?.name, id: job?.id }, "job failed");
  // Out of retries: into the error log. Webhook deliveries are left out (they alert on their own and a
  // client's endpoint being down isn't an app error).
  const lastTry = (job?.attemptsMade ?? 0) >= (job?.opts.attempts ?? 1);
  if (lastTry && err.name !== "DeliveryError") void recordError(err, { source: "job", path: job?.name, context: { jobId: job?.id } });
});
logger.info("worker started");

// Hourly: landing pages that usually get leads but have had none for a day.
const quietCheck = () =>
  checkQuietLandingPages()
    .then((n) => n && logger.info({ pages: n }, "quiet landing page alerts sent"))
    .catch((err) => logger.error({ err }, "quiet landing page check failed"));
setTimeout(quietCheck, 60_000);
const quietTimer = setInterval(quietCheck, 3_600_000);

const shutdown = async () => {
  clearInterval(quietTimer);
  await worker.close();
  await prisma.$disconnect();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
