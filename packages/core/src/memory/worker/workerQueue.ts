import { Logger } from "../../logging";
import { IdleScheduler } from "./idleScheduler";
import { PendingTurnsStore } from "./persistence";
import { WorkerJob, WorkerJobRunner } from "./types";

export interface MemoryWorkerQueueOptions {
  logger?: Logger;
  /** Backoff delays for retry attempts 1..N. Default: 1 min, 5 min, 15 min. */
  retryBackoffsMs?: number[];
  /** Optional audit-log store for batches that exhaust their retry cap. */
  persistence?: PendingTurnsStore;
  /** Override the timer scheduler — used in tests to drive retries synchronously. */
  scheduleRetry?: (callback: () => void, delayMs: number) => () => void;
}

interface QueuedJob extends WorkerJob {
  attempts: number;
}

const DEFAULT_BACKOFFS_MS = [60_000, 300_000, 900_000];

const defaultScheduleRetry = (cb: () => void, delayMs: number): (() => void) => {
  const t = setTimeout(cb, delayMs);
  if (typeof t.unref === "function") t.unref();
  return () => clearTimeout(t);
};

/**
 * Global FIFO that drains worker jobs one at a time, regardless of channel.
 * Concurrency is 1 by design: every worker run rewrites the shared Telegram
 * pinned memory message, so parallel runs would race on writes.
 *
 * Retry policy: failed jobs are re-enqueued with exponential backoff (default
 * 1 min / 5 min / 15 min, up to 3 retries). After the cap is exhausted the
 * batch is dropped from pendingTurns to avoid a permanent stuck state and an
 * audit entry is written via the optional persistence store.
 */
export class MemoryWorkerQueue {
  private readonly queue: QueuedJob[] = [];
  private draining = false;
  private stopped = false;
  private readonly logger?: Logger;
  private readonly retryBackoffsMs: number[];
  private readonly persistence?: PendingTurnsStore;
  private readonly scheduleRetry: (cb: () => void, delayMs: number) => () => void;
  private readonly pendingRetryCancels = new Set<() => void>();

  constructor(
    private readonly runner: WorkerJobRunner,
    private readonly scheduler: IdleScheduler,
    options: MemoryWorkerQueueOptions = {},
  ) {
    this.logger = options.logger;
    this.retryBackoffsMs = options.retryBackoffsMs ?? DEFAULT_BACKOFFS_MS;
    this.persistence = options.persistence;
    this.scheduleRetry = options.scheduleRetry ?? defaultScheduleRetry;
  }

  enqueue(job: WorkerJob): void {
    if (this.stopped) return;
    this.queue.push({ ...job, attempts: 0 });
    this.logger?.info("Memory worker job enqueued.", {
      channelId: job.channelId,
      chatId: job.chatId,
      turnCount: job.turns.length,
      attempts: 0,
    });
    void this.drain();
  }

  /** Stop accepting new work and cancel any pending retry timers. */
  stop(): void {
    this.stopped = true;
    for (const cancel of this.pendingRetryCancels) cancel();
    this.pendingRetryCancels.clear();
  }

  /** Number of jobs currently waiting (excluding the one being processed). */
  pendingCount(): number {
    return this.queue.length;
  }

  private requeueForRetry(job: QueuedJob): void {
    if (this.stopped) return;
    this.queue.unshift(job); // retry runs before any newer jobs added meanwhile
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        if (this.stopped) return;
        const job = this.queue.shift()!;
        const startedAt = Date.now();
        try {
          await this.runner.run(job);
          this.scheduler.markSuccess(job.channelId, job.chatId, job.dispatchedAt);
          this.logger?.info("Memory worker job succeeded.", {
            channelId: job.channelId,
            chatId: job.chatId,
            turnCount: job.turns.length,
            attempts: job.attempts,
            durationMs: Date.now() - startedAt,
            outcome: "success",
          });
        } catch (err) {
          const reason = err instanceof Error ? err.message : "unknown";
          const nextAttempt = job.attempts + 1;

          if (nextAttempt <= this.retryBackoffsMs.length) {
            const delayMs = this.retryBackoffsMs[job.attempts];
            this.logger?.warn("Memory worker job failed; scheduling retry.", {
              channelId: job.channelId,
              chatId: job.chatId,
              turnCount: job.turns.length,
              attempts: job.attempts,
              nextAttempt,
              delayMs,
              durationMs: Date.now() - startedAt,
              outcome: "retry",
              reason,
            });
            const retryJob: QueuedJob = { ...job, attempts: nextAttempt };
            let cancel: (() => void) | undefined;
            cancel = this.scheduleRetry(() => {
              if (cancel) this.pendingRetryCancels.delete(cancel);
              this.requeueForRetry(retryJob);
            }, delayMs);
            this.pendingRetryCancels.add(cancel);
          } else {
            // Retry cap exhausted — write audit entry and drop the batch
            // (markSuccess for the scheduler so it doesn't re-dispatch).
            this.logger?.error("Memory worker job exhausted retries; dropping batch.", {
              channelId: job.channelId,
              chatId: job.chatId,
              turnCount: job.turns.length,
              attempts: job.attempts,
              durationMs: Date.now() - startedAt,
              outcome: "dropped",
              reason,
            });
            try {
              this.persistence?.appendFailedAttempt({
                channelId: job.channelId,
                chatId: job.chatId,
                dispatchedAt: job.dispatchedAt,
                attempts: job.attempts,
                turnCount: job.turns.length,
                lastError: reason,
                droppedAt: Date.now(),
              });
            } catch (auditErr) {
              this.logger?.warn("Memory worker: failed to append audit entry.", {
                channelId: job.channelId,
                chatId: job.chatId,
                reason: auditErr instanceof Error ? auditErr.message : "unknown",
              });
            }
            this.scheduler.markSuccess(job.channelId, job.chatId, job.dispatchedAt);
          }
        }
      }
    } finally {
      this.draining = false;
    }
  }
}
