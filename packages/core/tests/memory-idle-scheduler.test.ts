import assert from "assert";
import test from "node:test";
import { EventBus } from "../src/events/eventBus";
import { IdleScheduler } from "../src/memory/worker/idleScheduler";
import { TurnRecord, WorkerJob } from "../src/memory/worker/types";
import { createLogger } from "../src/logging";

const logger = createLogger("error");

const makeScheduler = (now: () => number, idleThresholdMs = 5_000) => {
  return new IdleScheduler({ idleThresholdMs, tickIntervalMs: 1_000_000, now, logger });
};

const turn = (timestamp: number, userText = "u", response = "r"): TurnRecord => ({
  userText,
  response,
  timestamp,
});

test("IdleScheduler does not dispatch when channel is not yet idle", () => {
  let clock = 1_000;
  const scheduler = makeScheduler(() => clock);
  const dispatched: WorkerJob[] = [];
  scheduler.start(new EventBus(), (j) => dispatched.push(j));

  scheduler.recordTurn("tg", "chat-1", turn(clock));
  clock += 1_000; // 1s — well under 5s threshold
  scheduler.tick();

  assert.equal(dispatched.length, 0, "should not dispatch while channel is active");
  scheduler.stop();
});

test("IdleScheduler dispatches once channel has been idle past threshold", () => {
  let clock = 1_000;
  const scheduler = makeScheduler(() => clock);
  const dispatched: WorkerJob[] = [];
  scheduler.start(new EventBus(), (j) => dispatched.push(j));

  scheduler.recordTurn("tg", "chat-1", turn(clock, "hello", "hi"));
  clock += 6_000; // 6s — past 5s threshold
  scheduler.tick();

  assert.equal(dispatched.length, 1, "should dispatch once idle");
  assert.equal(dispatched[0].channelId, "tg");
  assert.equal(dispatched[0].chatId, "chat-1");
  assert.equal(dispatched[0].turns.length, 1);
  assert.equal(dispatched[0].turns[0].userText, "hello");
  scheduler.stop();
});

test("IdleScheduler does not re-dispatch the same batch on subsequent ticks", () => {
  let clock = 1_000;
  const scheduler = makeScheduler(() => clock);
  const dispatched: WorkerJob[] = [];
  scheduler.start(new EventBus(), (j) => dispatched.push(j));

  scheduler.recordTurn("tg", "chat-1", turn(clock));
  clock += 6_000;
  scheduler.tick();
  clock += 1_000;
  scheduler.tick();
  clock += 1_000;
  scheduler.tick();

  assert.equal(dispatched.length, 1, "should only dispatch the first time");
  scheduler.stop();
});

test("IdleScheduler retains pendingTurns when dispatch fails (markFailure)", () => {
  let clock = 1_000;
  const scheduler = makeScheduler(() => clock);
  const dispatched: WorkerJob[] = [];
  scheduler.start(new EventBus(), (j) => dispatched.push(j));

  scheduler.recordTurn("tg", "chat-1", turn(clock));
  clock += 6_000;
  scheduler.tick();
  assert.equal(dispatched.length, 1);

  // Simulate worker failure
  scheduler.markFailure("tg", "chat-1", dispatched[0].dispatchedAt);
  // After failure, the channel state should be eligible to retry once threshold passes again.
  clock += 6_000;
  scheduler.tick();

  assert.equal(dispatched.length, 2, "should retry the same batch after failure once idle again");
  scheduler.stop();
});

test("IdleScheduler.markSuccess only clears turns from the dispatched batch", () => {
  let clock = 1_000;
  const scheduler = makeScheduler(() => clock);
  const dispatched: WorkerJob[] = [];
  scheduler.start(new EventBus(), (j) => dispatched.push(j));

  scheduler.recordTurn("tg", "chat-1", turn(1_000, "first"));
  scheduler.recordTurn("tg", "chat-1", turn(2_000, "second"));
  clock = 10_000; // 8s idle
  scheduler.tick();

  // While the worker was "running", a new turn arrives.
  scheduler.recordTurn("tg", "chat-1", turn(11_000, "third"));

  // Worker reports success for the batch dispatched at clock=10_000.
  scheduler.markSuccess("tg", "chat-1", dispatched[0].dispatchedAt);
  const state = scheduler.getChannelState("tg", "chat-1");
  assert.ok(state, "channel state exists");
  assert.equal(state!.pendingTurns.length, 1, "only the post-dispatch turn should remain");
  assert.equal(state!.pendingTurns[0].userText, "third");
  scheduler.stop();
});

test("IdleScheduler subscribes to EventBus turn-complete events", () => {
  let clock = 1_000;
  const scheduler = makeScheduler(() => clock);
  const eventBus = new EventBus();
  const dispatched: WorkerJob[] = [];
  scheduler.start(eventBus, (j) => dispatched.push(j));

  eventBus.emit({
    executionId: "e1",
    channelId: "tg",
    chatId: "chat-1",
    type: "turn-complete",
    timestamp: clock,
    payload: { userText: "hi", response: "hey" },
  });

  // Other event types are ignored.
  eventBus.emit({
    executionId: "e1",
    channelId: "tg",
    chatId: "chat-1",
    type: "complete",
    timestamp: clock,
    payload: { response: "hey" },
  });

  const state = scheduler.getChannelState("tg", "chat-1");
  assert.ok(state);
  assert.equal(state!.pendingTurns.length, 1, "only turn-complete should accumulate");
  scheduler.stop();
});

test("IdleScheduler stop unsubscribes and stops the tick timer", () => {
  let clock = 1_000;
  const scheduler = makeScheduler(() => clock);
  const eventBus = new EventBus();
  const dispatched: WorkerJob[] = [];
  scheduler.start(eventBus, (j) => dispatched.push(j));
  scheduler.stop();

  // After stop, new turn-complete events should NOT be recorded.
  eventBus.emit({
    executionId: "e1",
    channelId: "tg",
    chatId: "chat-1",
    type: "turn-complete",
    timestamp: clock,
    payload: { userText: "hi", response: "hey" },
  });

  const state = scheduler.getChannelState("tg", "chat-1");
  assert.equal(state, undefined, "stop should drop the subscription");
});
