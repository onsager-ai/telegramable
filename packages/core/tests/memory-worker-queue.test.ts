import assert from "assert";
import test from "node:test";
import { IdleScheduler } from "../src/memory/worker/idleScheduler";
import { MemoryWorkerQueue } from "../src/memory/worker/workerQueue";
import { TurnRecord, WorkerJob, WorkerJobRunner } from "../src/memory/worker/types";
import { createLogger } from "../src/logging";

const logger = createLogger("error");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const turn = (ts: number): TurnRecord => ({ userText: "u", response: "r", timestamp: ts });

const makeJob = (channelId: string, chatId: string, dispatchedAt: number, turns: TurnRecord[] = []): WorkerJob => ({
  channelId,
  chatId,
  dispatchedAt,
  turns,
});

class StubRunner implements WorkerJobRunner {
  public runs: WorkerJob[] = [];
  public concurrent = 0;
  public peakConcurrent = 0;
  constructor(
    private readonly behavior: "ok" | "throw" | "slow-ok",
    private readonly delayMs = 0,
  ) {}
  async run(job: WorkerJob): Promise<void> {
    this.concurrent++;
    if (this.concurrent > this.peakConcurrent) this.peakConcurrent = this.concurrent;
    this.runs.push(job);
    try {
      if (this.delayMs > 0) await sleep(this.delayMs);
      if (this.behavior === "throw") throw new Error("simulated worker failure");
    } finally {
      this.concurrent--;
    }
  }
  async shutdown(): Promise<void> { /* noop */ }
}

test("MemoryWorkerQueue drains jobs in FIFO order, one at a time", async () => {
  const runner = new StubRunner("slow-ok", 25);
  const scheduler = new IdleScheduler({ logger });
  scheduler.start(new (await import("../src/events/eventBus")).EventBus(), () => {});

  const queue = new MemoryWorkerQueue(runner, scheduler, { logger });
  queue.enqueue(makeJob("tg", "a", 1));
  queue.enqueue(makeJob("tg", "b", 2));
  queue.enqueue(makeJob("tg", "c", 3));

  // Wait long enough for all three slow-ok jobs to drain.
  await sleep(150);

  assert.equal(runner.runs.length, 3);
  assert.deepEqual(runner.runs.map((j) => j.chatId), ["a", "b", "c"]);
  assert.equal(runner.peakConcurrent, 1, "concurrency=1 by design");
  scheduler.stop();
});

test("MemoryWorkerQueue calls markSuccess on the scheduler on success", async () => {
  const runner = new StubRunner("ok");
  const scheduler = new IdleScheduler({ logger });
  scheduler.start(new (await import("../src/events/eventBus")).EventBus(), () => {});

  // Seed scheduler state so markSuccess has something to clear.
  scheduler.recordTurn("tg", "a", turn(100));
  const job = makeJob("tg", "a", 200, [turn(100)]);

  const queue = new MemoryWorkerQueue(runner, scheduler, { logger });
  queue.enqueue(job);
  await sleep(20);

  const state = scheduler.getChannelState("tg", "a");
  assert.ok(state);
  assert.equal(state!.pendingTurns.length, 0, "successful run clears the dispatched batch");
  scheduler.stop();
});

test("MemoryWorkerQueue calls markFailure on the scheduler on error, leaving pendingTurns intact", async () => {
  const runner = new StubRunner("throw");
  const scheduler = new IdleScheduler({ logger });
  scheduler.start(new (await import("../src/events/eventBus")).EventBus(), () => {});

  scheduler.recordTurn("tg", "a", turn(100));
  const queue = new MemoryWorkerQueue(runner, scheduler, { logger });
  queue.enqueue(makeJob("tg", "a", 200, [turn(100)]));
  await sleep(20);

  const state = scheduler.getChannelState("tg", "a");
  assert.ok(state);
  assert.equal(state!.pendingTurns.length, 1, "failed run preserves pending turns");
  scheduler.stop();
});

test("MemoryWorkerQueue keeps draining the queue across a failed job", async () => {
  // First job throws, then a second job should still run.
  let count = 0;
  const flakyRunner: WorkerJobRunner = {
    async run(_job) {
      count++;
      if (count === 1) throw new Error("first one fails");
      // second one succeeds silently
    },
    async shutdown() {},
  };
  const scheduler = new IdleScheduler({ logger });
  scheduler.start(new (await import("../src/events/eventBus")).EventBus(), () => {});

  const queue = new MemoryWorkerQueue(flakyRunner, scheduler, { logger });
  queue.enqueue(makeJob("tg", "a", 1));
  queue.enqueue(makeJob("tg", "b", 2));
  await sleep(20);

  assert.equal(count, 2, "queue should not stop on a failure");
  scheduler.stop();
});
