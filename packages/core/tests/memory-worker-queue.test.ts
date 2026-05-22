import assert from "assert";
import test from "node:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { EventBus } from "../src/events/eventBus";
import { IdleScheduler } from "../src/memory/worker/idleScheduler";
import { MemoryWorkerQueue } from "../src/memory/worker/workerQueue";
import { PendingTurnsStore } from "../src/memory/worker/persistence";
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

/** Test helper that fires retry callbacks synchronously, so we don't depend on real wallclock. */
const syncRetry = (callbacks: Array<() => void>) => (cb: () => void, _delayMs: number): (() => void) => {
  callbacks.push(cb);
  return () => {
    const idx = callbacks.indexOf(cb);
    if (idx >= 0) callbacks.splice(idx, 1);
  };
};

test("MemoryWorkerQueue drains jobs in FIFO order, one at a time", async () => {
  const runner = new StubRunner("slow-ok", 25);
  const scheduler = new IdleScheduler({ logger });
  scheduler.start(new EventBus(), () => {});

  const queue = new MemoryWorkerQueue(runner, scheduler, { logger });
  queue.enqueue(makeJob("tg", "a", 1));
  queue.enqueue(makeJob("tg", "b", 2));
  queue.enqueue(makeJob("tg", "c", 3));

  await sleep(150);

  assert.equal(runner.runs.length, 3);
  assert.deepEqual(runner.runs.map((j) => j.chatId), ["a", "b", "c"]);
  assert.equal(runner.peakConcurrent, 1, "concurrency=1 by design");
  scheduler.stop();
});

test("MemoryWorkerQueue calls markSuccess on the scheduler on success", async () => {
  const runner = new StubRunner("ok");
  const scheduler = new IdleScheduler({ logger });
  scheduler.start(new EventBus(), () => {});

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

test("MemoryWorkerQueue retries failed jobs with backoff up to the cap, then drops", async () => {
  const runner = new StubRunner("throw");
  const scheduler = new IdleScheduler({ logger });
  scheduler.start(new EventBus(), () => {});
  scheduler.recordTurn("tg", "a", turn(100));

  // Buffer retry callbacks so we can fire them synchronously.
  const retries: Array<() => void> = [];
  const auditDir = mkdtempSync(join(tmpdir(), "memq-test-"));
  const persistence = new PendingTurnsStore(auditDir, logger);

  const queue = new MemoryWorkerQueue(runner, scheduler, {
    logger,
    persistence,
    retryBackoffsMs: [1, 2, 3], // any non-zero ints; we drive timing manually
    scheduleRetry: syncRetry(retries),
  });
  queue.enqueue(makeJob("tg", "a", 200, [turn(100)]));

  // Initial attempt + 3 retries = 4 total runs after firing all callbacks.
  await sleep(10);
  assert.equal(runner.runs.length, 1, "initial attempt runs immediately");
  assert.equal(retries.length, 1, "first retry scheduled");

  // Fire retry 1
  retries.shift()!();
  await sleep(10);
  assert.equal(runner.runs.length, 2);
  assert.equal(retries.length, 1, "second retry scheduled");

  // Fire retry 2
  retries.shift()!();
  await sleep(10);
  assert.equal(runner.runs.length, 3);
  assert.equal(retries.length, 1, "third retry scheduled");

  // Fire retry 3 — final attempt, also fails → audit + drop
  retries.shift()!();
  await sleep(10);
  assert.equal(runner.runs.length, 4, "final retry runs");
  assert.equal(retries.length, 0, "no further retries scheduled past the cap");

  // After cap exhausted, the dispatched batch is dropped.
  const state = scheduler.getChannelState("tg", "a");
  assert.ok(state);
  assert.equal(state!.pendingTurns.length, 0, "exhausted batch is dropped from pendingTurns");

  // Audit entry written
  const audit = persistence.readFailedAttempts("tg", "a");
  assert.equal(audit.length, 1, "one audit entry per dropped batch");
  assert.equal(audit[0].attempts, 3);
  assert.equal(audit[0].turnCount, 1);
  assert.ok(audit[0].lastError.includes("simulated worker failure"));

  scheduler.stop();
  rmSync(auditDir, { recursive: true, force: true });
});

test("MemoryWorkerQueue.stop cancels pending retry timers and stops accepting work", async () => {
  const runner = new StubRunner("throw");
  const scheduler = new IdleScheduler({ logger });
  scheduler.start(new EventBus(), () => {});
  const retries: Array<() => void> = [];
  const queue = new MemoryWorkerQueue(runner, scheduler, {
    logger,
    scheduleRetry: syncRetry(retries),
  });
  queue.enqueue(makeJob("tg", "a", 1));
  await sleep(10);
  assert.equal(retries.length, 1);

  queue.stop();
  // Firing a cancelled retry should be a no-op (retry timer was cancelled).
  // We can't easily verify that without exposing internals; instead, verify
  // that new enqueues are ignored after stop.
  queue.enqueue(makeJob("tg", "b", 2));
  await sleep(10);
  assert.equal(runner.runs.length, 1, "queue rejects work after stop");
  scheduler.stop();
});

test("MemoryWorkerQueue keeps draining across a one-off failure (retried once)", async () => {
  // First job throws once then we let the retry succeed by swapping the stub.
  let count = 0;
  const flaky: WorkerJobRunner = {
    async run() {
      count++;
      if (count === 1) throw new Error("first fails");
    },
    async shutdown() {},
  };
  const scheduler = new IdleScheduler({ logger });
  scheduler.start(new EventBus(), () => {});
  const retries: Array<() => void> = [];
  const queue = new MemoryWorkerQueue(flaky, scheduler, {
    logger,
    scheduleRetry: syncRetry(retries),
  });
  queue.enqueue(makeJob("tg", "a", 1));
  queue.enqueue(makeJob("tg", "b", 2));
  await sleep(10);

  // First attempt failed, retry scheduled, then second job ran.
  assert.equal(count, 2, "second job runs even after first's initial failure");
  assert.equal(retries.length, 1);

  // Fire retry of first job — succeeds now.
  retries.shift()!();
  await sleep(10);
  assert.equal(count, 3);
  assert.equal(retries.length, 0, "no further retries needed after success");

  scheduler.stop();
});
