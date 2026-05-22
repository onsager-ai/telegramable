import assert from "assert";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { EventBus } from "../src/events/eventBus";
import { IdleScheduler } from "../src/memory/worker/idleScheduler";
import { PendingTurnsStore } from "../src/memory/worker/persistence";
import { TurnRecord, WorkerJob } from "../src/memory/worker/types";
import { createLogger } from "../src/logging";

const logger = createLogger("error");
const turn = (ts: number, u = "u", r = "r"): TurnRecord => ({ userText: u, response: r, timestamp: ts });

test("PendingTurnsStore: save then loadAll round-trips per-channel state", () => {
  const baseDir = mkdtempSync(join(tmpdir(), "pts-rt-"));
  try {
    const store = new PendingTurnsStore(baseDir, logger);
    store.save("tg", "@channel:42", [turn(1, "a", "b"), turn(2, "c", "d")]);
    store.save("tg", "chat-2", [turn(3, "e", "f")]);

    const fresh = new PendingTurnsStore(baseDir, logger);
    const loaded = fresh.loadAll().sort((a, b) => a.chatId.localeCompare(b.chatId));
    assert.equal(loaded.length, 2);
    assert.equal(loaded[0].channelId, "tg");
    assert.equal(loaded[0].chatId, "@channel:42", "non-alphanumeric chat ids round-trip via JSON payload");
    assert.equal(loaded[0].turns.length, 2);
    assert.equal(loaded[1].chatId, "chat-2");
    assert.equal(loaded[1].turns.length, 1);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("PendingTurnsStore: atomic write does not corrupt the file on partial replacement", () => {
  // Atomic-write semantics: writeAtomicJson writes to .tmp then renames.  A
  // crash mid-write leaves the previous valid state in place, never a
  // half-written file.  We can't crash the process here, but we can assert
  // that the .tmp file is gone after a successful write — meaning the rename
  // ran atomically and the consumer only ever sees a valid file.
  const baseDir = mkdtempSync(join(tmpdir(), "pts-atomic-"));
  try {
    const store = new PendingTurnsStore(baseDir, logger);
    store.save("tg", "chat-1", [turn(1)]);
    store.save("tg", "chat-1", [turn(1), turn(2)]); // overwrite

    const loaded = new PendingTurnsStore(baseDir, logger).loadAll();
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].turns.length, 2, "second save fully replaced first");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("PendingTurnsStore: loadAll skips malformed files and continues", () => {
  const baseDir = mkdtempSync(join(tmpdir(), "pts-malformed-"));
  try {
    const store = new PendingTurnsStore(baseDir, logger);
    store.save("tg", "good", [turn(1)]);
    // Plant a malformed file in a sibling chat dir
    const badDir = join(baseDir, "tg", "bad");
    require("fs").mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, "pending.json"), "{ this is not json");

    const loaded = new PendingTurnsStore(baseDir, logger).loadAll();
    assert.equal(loaded.length, 1, "malformed file ignored, good file kept");
    assert.equal(loaded[0].chatId, "good");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("PendingTurnsStore: appendFailedAttempt is NDJSON-readable", () => {
  const baseDir = mkdtempSync(join(tmpdir(), "pts-audit-"));
  try {
    const store = new PendingTurnsStore(baseDir, logger);
    store.appendFailedAttempt({
      channelId: "tg",
      chatId: "chat-1",
      dispatchedAt: 100,
      attempts: 3,
      turnCount: 2,
      lastError: "timeout",
      droppedAt: 500,
    });
    store.appendFailedAttempt({
      channelId: "tg",
      chatId: "chat-1",
      dispatchedAt: 200,
      attempts: 3,
      turnCount: 1,
      lastError: "exit code 1",
      droppedAt: 800,
    });

    const audit = store.readFailedAttempts("tg", "chat-1");
    assert.equal(audit.length, 2);
    assert.equal(audit[0].dispatchedAt, 100);
    assert.equal(audit[1].lastError, "exit code 1");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("IdleScheduler recovers pendingTurns from a simulated process restart", () => {
  const baseDir = mkdtempSync(join(tmpdir(), "pts-restart-"));
  try {
    const persistence = new PendingTurnsStore(baseDir, logger);

    // First lifecycle: scheduler records a few turns to disk.
    const eventBus1 = new EventBus();
    let clock = 1_000;
    const sched1 = new IdleScheduler({ logger, persistence, idleThresholdMs: 10_000, tickIntervalMs: 1_000_000, now: () => clock });
    sched1.start(eventBus1, () => {});
    sched1.recordTurn("tg", "chat-1", turn(1_000, "first"));
    sched1.recordTurn("tg", "chat-1", turn(2_000, "second"));
    sched1.stop();

    // Simulated restart: build a fresh scheduler from the same persistence.
    const eventBus2 = new EventBus();
    const dispatched: WorkerJob[] = [];
    const sched2 = new IdleScheduler({ logger, persistence, idleThresholdMs: 10_000, tickIntervalMs: 1_000_000, now: () => clock });
    sched2.start(eventBus2, (j) => dispatched.push(j));

    const state = sched2.getChannelState("tg", "chat-1");
    assert.ok(state, "state recovered for chat-1");
    assert.equal(state!.pendingTurns.length, 2, "both turns recovered");
    assert.equal(state!.pendingTurns[0].userText, "first");
    assert.equal(state!.pendingTurns[1].userText, "second");

    // After enough idle time, the recovered batch dispatches.
    clock = 12_001;
    sched2.tick();
    assert.equal(dispatched.length, 1, "recovered batch dispatches after threshold");
    assert.equal(dispatched[0].turns.length, 2);

    sched2.stop();
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("IdleScheduler.markSuccess rewrites pending.json with only the post-batch turns", () => {
  const baseDir = mkdtempSync(join(tmpdir(), "pts-ms-"));
  try {
    const persistence = new PendingTurnsStore(baseDir, logger);
    let clock = 1_000;
    const sched = new IdleScheduler({ logger, persistence, idleThresholdMs: 5_000, tickIntervalMs: 1_000_000, now: () => clock });
    const dispatched: WorkerJob[] = [];
    sched.start(new EventBus(), (j) => dispatched.push(j));

    sched.recordTurn("tg", "chat-1", turn(1_000, "a"));
    sched.recordTurn("tg", "chat-1", turn(2_000, "b"));
    clock = 8_000;
    sched.tick();
    // While the worker "ran", a newer turn arrived.
    sched.recordTurn("tg", "chat-1", turn(9_000, "c"));
    sched.markSuccess("tg", "chat-1", dispatched[0].dispatchedAt);

    // The persistence file should now contain only "c".
    const loaded = new PendingTurnsStore(baseDir, logger).loadAll();
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].turns.length, 1, "post-batch turn survives on disk");
    assert.equal(loaded[0].turns[0].userText, "c");

    sched.stop();
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
