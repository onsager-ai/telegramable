import assert from "assert";
import test from "node:test";
import { ClaudeSession } from "../src/runtime/session/claudeSession";
import { ExecutionEvent } from "../src/events/types";
import { EventBus } from "../src/events/eventBus";
import { NdjsonRunner } from "../src/runtime/session/utils";

const collectingBus = (): { bus: EventBus; events: ExecutionEvent[] } => {
  const events: ExecutionEvent[] = [];
  const bus = {
    emit: (event: ExecutionEvent) => {
      events.push(event);
    },
    on: () => () => { /* no-op for tests */ }
  } as unknown as EventBus;
  return { bus, events };
};

const STREAM_JSON_ARGS = ["--output-format", "stream-json", "--verbose", "--include-partial-messages"];

test("ClaudeSession first call uses stream-json -p; second call adds --resume", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];

  const run: NdjsonRunner = async (command, args, _opts, onJson) => {
    calls.push({ command, args });
    if (calls.length === 1) {
      onJson?.({ type: "system", subtype: "init", session_id: "claude-123" });
      onJson?.({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } },
        session_id: "claude-123"
      });
      onJson?.({ type: "result", subtype: "success", is_error: false, result: "Hello", session_id: "claude-123" });
      return { code: 0, stderr: "" };
    }
    onJson?.({ type: "system", subtype: "init", session_id: "claude-123" });
    onJson?.({ type: "result", subtype: "success", is_error: false, result: "Hi again", session_id: "claude-123" });
    return { code: 0, stderr: "" };
  };

  const session = new ClaudeSession("telegram", "chat-1", { name: "claude", command: "claude" }, run);
  const { bus: bus1, events: events1 } = collectingBus();
  const first = await session.send("hello", "exec-1", bus1);
  const { bus: bus2 } = collectingBus();
  await session.send("follow up", "exec-2", bus2);

  assert.equal(first, "Hello");
  assert.deepEqual(calls[0]?.args, [...STREAM_JSON_ARGS, "-p", "hello"]);
  assert.deepEqual(calls[1]?.args, ["--resume", "claude-123", ...STREAM_JSON_ARGS, "-p", "follow up"]);

  // Stream delta and response-end events should both have been emitted on the first call.
  assert.ok(events1.some((e) => e.type === "stream-text" && e.payload?.text === "Hello"));
  const responseEnd = events1.find((e) => e.type === "response-end");
  assert.ok(responseEnd, "response-end event expected");
  assert.equal(responseEnd?.payload?.text, "Hello");
});

test("ClaudeSession retries as a fresh session when resume fails", async () => {
  const calls: Array<string[]> = [];

  const run: NdjsonRunner = async (_command, args, _opts, onJson) => {
    calls.push(args);
    if (calls.length === 1) {
      onJson?.({ type: "system", subtype: "init", session_id: "claude-xyz" });
      onJson?.({ type: "result", subtype: "success", is_error: false, result: "ready", session_id: "claude-xyz" });
      return { code: 0, stderr: "" };
    }

    if (calls.length === 2) {
      throw new Error("resume failed");
    }

    onJson?.({ type: "system", subtype: "init", session_id: "claude-new" });
    onJson?.({ type: "result", subtype: "success", is_error: false, result: "fresh response", session_id: "claude-new" });
    return { code: 0, stderr: "" };
  };

  const session = new ClaudeSession("telegram", "chat-1", { name: "claude", command: "claude" }, run);
  const { bus: bus1 } = collectingBus();
  await session.send("first", "exec-1", bus1);
  const { bus: bus2 } = collectingBus();
  const response = await session.send("second", "exec-2", bus2);

  assert.equal(response, "fresh response");
  assert.deepEqual(calls[1], ["--resume", "claude-xyz", ...STREAM_JSON_ARGS, "-p", "second"]);
  assert.deepEqual(calls[2], [...STREAM_JSON_ARGS, "-p", "second"]);
});

test("ClaudeSession surfaces error when result event marks is_error", async () => {
  // No session_id captured — state stays undefined so the send() catch path
  // throws "Failed to start Claude session." instead of retrying.
  const run: NdjsonRunner = async (_command, _args, _opts, onJson) => {
    onJson?.({ type: "result", subtype: "error", is_error: true, result: "rate limited" });
    return { code: 0, stderr: "" };
  };

  const session = new ClaudeSession("telegram", "chat-1", { name: "claude", command: "claude" }, run);
  const { bus } = collectingBus();
  await assert.rejects(
    () => session.send("hi", "exec-1", bus),
    /Failed to start Claude session/
  );
});

test("ClaudeSession throws when CLI exits without a result event", async () => {
  const run: NdjsonRunner = async () => ({ code: 0, stderr: "" });

  const session = new ClaudeSession("telegram", "chat-1", { name: "claude", command: "claude" }, run);
  const { bus } = collectingBus();
  await assert.rejects(
    () => session.send("hi", "exec-1", bus),
    /Failed to start Claude session/
  );
});
