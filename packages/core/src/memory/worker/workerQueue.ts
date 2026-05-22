import { Logger } from "../../logging";
import { IdleScheduler } from "./idleScheduler";
import { WorkerJob, WorkerJobRunner } from "./types";

export interface MemoryWorkerQueueOptions {
  logger?: Logger;
}

/**
 * Global FIFO that drains worker jobs one at a time, regardless of channel.
 * Concurrency is 1 by design: every worker run rewrites the shared Telegram
 * pinned memory message, so parallel runs would race on writes.
 */
export class MemoryWorkerQueue {
  private readonly queue: WorkerJob[] = [];
  private draining = false;
  private readonly logger?: Logger;

  constructor(
    private readonly runner: WorkerJobRunner,
    private readonly scheduler: IdleScheduler,
    options: MemoryWorkerQueueOptions = {},
  ) {
    this.logger = options.logger;
  }

  enqueue(job: WorkerJob): void {
    this.queue.push(job);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const job = this.queue.shift()!;
        const startedAt = Date.now();
        try {
          await this.runner.run(job);
          this.scheduler.markSuccess(job.channelId, job.chatId, job.dispatchedAt);
          this.logger?.info("Memory worker succeeded.", {
            channelId: job.channelId,
            chatId: job.chatId,
            turnCount: job.turns.length,
            durationMs: Date.now() - startedAt,
            outcome: "success",
          });
        } catch (err) {
          this.scheduler.markFailure(job.channelId, job.chatId, job.dispatchedAt);
          this.logger?.warn("Memory worker failed; pending turns retained for next idle cycle.", {
            channelId: job.channelId,
            chatId: job.chatId,
            turnCount: job.turns.length,
            durationMs: Date.now() - startedAt,
            outcome: "failure",
            reason: err instanceof Error ? err.message : "unknown",
          });
        }
      }
    } finally {
      this.draining = false;
    }
  }

  /** Number of jobs currently waiting (excluding the one being processed). */
  pendingCount(): number {
    return this.queue.length;
  }
}
