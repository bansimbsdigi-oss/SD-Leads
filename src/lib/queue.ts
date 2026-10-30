// BullMQ producer. Without REDIS_URL (local dev, tests) jobs are dropped, or run in-process when
// INLINE_JOBS=1 (handy for trying webhooks locally; no retries there).
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { logger } from "./logger";

export const QUEUE_NAME = "sabhi-jobs";

export type JobMap = {
  "lead.created": { leadId: string };
  "webhook.deliver": { integrationId: string; leadId: string };
};

/** `jobId` makes the queue ignore a second copy of the same job (e.g. a retried fan-out). */
export type EnqueueOptions = { attempts?: number; backoffMs?: number; jobId?: string };

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

export async function enqueue<K extends keyof JobMap>(name: K, data: JobMap[K], opts: EnqueueOptions = {}): Promise<void> {
  const q = getQueue();
  if (!q) {
    if (process.env.INLINE_JOBS === "1") {
      setImmediate(() => {
        import("./jobs")
          .then(({ runJob }) => runJob(name, data, 1))
          .catch((err) => logger.warn({ err, job: name }, "inline job failed"));
      });
      return;
    }
    logger.debug({ job: name, data }, "queue disabled, job skipped");
    return;
  }
  try {
    await q.add(name, data, {
      attempts: opts.attempts ?? 5,
      backoff: { type: "exponential", delay: opts.backoffMs ?? 5000 },
      removeOnComplete: 1000,
      removeOnFail: 5000,
      ...(opts.jobId ? { jobId: opts.jobId } : {}),
    });
  } catch (err) {
    // The lead is already saved; a queue outage must not fail the submission.
    logger.error({ err, job: name }, "enqueue failed");
  }
}
