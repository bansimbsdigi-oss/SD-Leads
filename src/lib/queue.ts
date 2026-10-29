// BullMQ producer. Without REDIS_URL (local dev, tests) jobs are logged and dropped.
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { logger } from "./logger";

export const QUEUE_NAME = "sabhi-jobs";

export type JobMap = {
  "lead.created": { leadId: string };
};

let queue: Queue | null | undefined;

export function redisConnection() {
  const url = process.env.REDIS_URL;
  return url ? new IORedis(url, { maxRetriesPerRequest: null }) : null;
}

function getQueue(): Queue | null {
  if (queue === undefined) {
    const connection = redisConnection();
    queue = connection ? new Queue(QUEUE_NAME, { connection }) : null;
  }
  return queue;
}

export async function enqueue<K extends keyof JobMap>(name: K, data: JobMap[K]): Promise<void> {
  const q = getQueue();
  if (!q) {
    logger.debug({ job: name, data }, "queue disabled, job skipped");
    return;
  }
  try {
    await q.add(name, data, { attempts: 5, backoff: { type: "exponential", delay: 5000 }, removeOnComplete: 1000 });
  } catch (err) {
    // The lead is already saved; a queue outage must not fail the submission.
    logger.error({ err, job: name }, "enqueue failed");
  }
}
