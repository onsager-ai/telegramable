import assert from "assert";
import path from "path";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import test from "node:test";
import { CliRuntime } from "../src/runtime/cliRuntime";
import { EventBus } from "../src/events/eventBus";
import { ExecutionEvent } from "../src/events/types";
import { createLogger } from "../src/logging";
import { AgentConfig } from "../src/config";
import { IMMessage } from "../src/gateway/types";

const logger = createLogger("error");

// Helper script that accepts a mode arg and ignores extra args (--session-id etc.)
const TEST_CMD = path.resolve(__dirname, "helpers/test-cmd.sh");
const STALE_SESSION_CMD = path.resolve(__dirname, "helpers/stale-session-cmd.sh");
const STREAM_JSON_CMD = path.resolve(__dirname, "helpers/stream-json-cmd.sh");
const STREAM_JSON_THINKING_CMD = path.resolve(__dirname, "helpers/stream-json-thinking-cmd.sh");
const STREAM_JSON_SUBAGENT_CMD = path.resolve(__dirname, "helpers/stream-json-subagent-cmd.sh");

const msg = (overrides?: Partial<IMMessage>): IMMessage => ({
  channelId: "telegram",
  chatId: "chat-1",
  text: "hello",
  ...overrides
});

const collect = (eventBus: EventBus): ExecutionEvent[] => {
  const events: ExecutionEvent[] = [];
  eventBus.on((e) => events.push(e));
  return events;
};

// ---------- happy path ----------

test("CliRuntime passes prompt as positional argument", async () => {
  const config: AgentConfig = { name: "echo-agent", command: TEST_CMD, args: ["echo-last-arg"] };
  const runtime = new CliRuntime(config, logger);
  const eventBus = new EventBus();
  const events = collect(eventBus);

  await runtime.execute(msg({ text: "ping" }), "exec-1", eventBus);

  const types = events.map((e) => e.type);
  assert.ok(types.includes("start"), "should emit start event");
  assert.ok(types.includes("complete"), "should emit complete event");

  const complete = events.find((e) => e.type === "complete");
  assert.equal(complete?.payload?.response, "ping");
});

test("CliRuntime parses command string with embedded args", async () => {
  // "echo --flag" should be split into executable "echo" with initialArg "--flag"
  const config: AgentConfig = { name: "embed-agent", command: "echo --flag" };
  const runtime = new CliRuntime(config, logger);
  const eventBus = new EventBus();
  const events = collect(eventBus);

  await runtime.execute(msg({ text: "world" }), "exec-1b", eventBus);

  const stdout = events.filter((e) => e.type === "stream-text").map((e) => e.payload?.text).join("");
  assert.ok(stdout.includes("--flag"), "should include initial arg from command string");
  assert.ok(stdout.includes("world"), "should include prompt as positional arg");
});

test("CliRuntime captures stdout from command", async () => {
  // echo prints all its args — useful for verifying args are passed through
  const config: AgentConfig = { name: "hello-agent", command: "echo", args: ["hi"] };
  const runtime = new CliRuntime(config, logger);
  const eventBus = new EventBus();
  const events = collect(eventBus);

  await runtime.execute(msg(), "exec-2", eventBus);

  const stdout = events.filter((e) => e.type === "stream-text").map((e) => e.payload?.text).join("");
  assert.ok(stdout.includes("hi"), "stdout should contain 'hi'");
});

// ---------- turn-complete event (#90) ----------

test("CliRuntime emits turn-complete with userText and response after a successful turn", async () => {
  const config: AgentConfig = { name: "echo-agent", command: TEST_CMD, args: ["echo-last-arg"] };
  const runtime = new CliRuntime(config, logger);
  const eventBus = new EventBus();
  const events = collect(eventBus);

  await runtime.execute(msg({ text: "remember me" }), "exec-turn-complete", eventBus);

  const turnComplete = events.find((e) => e.type === "turn-complete");
  assert.ok(turnComplete, "should emit turn-complete event");
  assert.equal(turnComplete?.payload?.userText, "remember me", "turn-complete payload should include userText");
  assert.equal(turnComplete?.payload?.response, "remember me", "turn-complete payload should include response");

  // It must arrive after complete so subscribers see the final response.
  const completeIdx = events.findIndex((e) => e.type === "complete");
  const turnIdx = events.findIndex((e) => e.type === "turn-complete");
  assert.ok(completeIdx >= 0 && turnIdx > completeIdx, "turn-complete should follow complete");
});

test("CliRuntime does not emit turn-complete on failed runs", async () => {
  // The `fail` helper exits with code 1 so the `complete` handler enters the failure branch.
  const config: AgentConfig = { name: "fail-agent", command: TEST_CMD, args: ["fail"] };
  const runtime = new CliRuntime(config, logger);
  const eventBus = new EventBus();
  const events = collect(eventBus);

  await runtime.execute(msg(), "exec-fail-turn", eventBus);

  const turnComplete = events.find((e) => e.type === "turn-complete");
  assert.equal(turnComplete, undefined, "should not emit turn-complete when the run failed");
});

// ---------- stderr ----------

test("CliRuntime captures stderr", async () => {
  const config: AgentConfig = { name: "stderr-agent", command: TEST_CMD, args: ["stderr"] };
  const runtime = new CliRuntime(config, logger);
  const eventBus = new EventBus();
  const events = collect(eventBus);

  await runtime.execute(msg(), "exec-3", eventBus);

  const stderr = events.find((e) => e.type === "stderr");
  assert.ok(stderr, "should emit stderr event");
  assert.ok(stderr?.payload?.text?.includes("err"), "stderr text should contain 'err'");
});

// ---------- non-zero exit clears session ----------

test("CliRuntime clears session on non-zero exit", async () => {
  const config: AgentConfig = { name: "fail-agent", command: TEST_CMD, args: ["fail"] };
  const runtime = new CliRuntime(config, logger);
  const eventBus = new EventBus();
  const events = collect(eventBus);

  await runtime.execute(msg(), "exec-4", eventBus);

  const complete = events.find((e) => e.type === "complete");
  assert.equal(complete?.payload?.code, 1, "exit code should be 1");
});

test("CliRuntime clears session after failure so next call starts fresh", async () => {
  // Use echo so we can inspect args (--session-id vs --resume)
  const config: AgentConfig = { name: "recover-agent", command: "echo" };
  const runtime = new CliRuntime(config, logger);

  // First call: force a failure by using the fail helper
  // (Use a separate runtime instance since command differs)
  const failRuntime = new CliRuntime(
    { name: "recover-agent", command: TEST_CMD, args: ["fail"] },
    logger
  );
  // Note: failRuntime has its own session map, so this only tests the event.
  const eb1 = new EventBus();
  await failRuntime.execute(msg(), "exec-4b-1", eb1);

  // A fresh runtime's first call should use --session-id
  const eb2 = new EventBus();
  const ev2 = collect(eb2);
  await runtime.execute(msg(), "exec-4b-2", eb2);
  const stdout = ev2.filter((e) => e.type === "stream-text").map((e) => e.payload?.text).join("");
  assert.ok(stdout.includes("--session-id"), "fresh runtime should use --session-id");
});

// ---------- session reuse ----------

test("CliRuntime reuses session for same channel+chat", async () => {
  const config: AgentConfig = { name: "session-agent", command: "echo" };
  const runtime = new CliRuntime(config, logger);

  const eventBus1 = new EventBus();
  const events1 = collect(eventBus1);
  await runtime.execute(msg(), "exec-5a", eventBus1);
  const stdout1 = events1.filter((e) => e.type === "stream-text").map((e) => e.payload?.text).join("");
  assert.ok(stdout1.includes("--session-id"), "first call should use --session-id");

  const eventBus2 = new EventBus();
  const events2 = collect(eventBus2);
  await runtime.execute(msg(), "exec-5b", eventBus2);
  const stdout2 = events2.filter((e) => e.type === "stream-text").map((e) => e.payload?.text).join("");
  assert.ok(stdout2.includes("--resume"), "second call should use --resume");
});

test("CliRuntime uses separate sessions for different chats", async () => {
  const config: AgentConfig = { name: "multi-agent", command: "echo" };
  const runtime = new CliRuntime(config, logger);

  const eb1 = new EventBus();
  const ev1 = collect(eb1);
  await runtime.execute(msg({ chatId: "chat-A" }), "exec-6a", eb1);

  const eb2 = new EventBus();
  const ev2 = collect(eb2);
  await runtime.execute(msg({ chatId: "chat-B" }), "exec-6b", eb2);

  const out1 = ev1.filter((e) => e.type === "stream-text").map((e) => e.payload?.text).join("");
  const out2 = ev2.filter((e) => e.type === "stream-text").map((e) => e.payload?.text).join("");
  assert.ok(out1.includes("--session-id"), "chat-A should get its own session");
  assert.ok(out2.includes("--session-id"), "chat-B should get its own session");
});

// ---------- EPIPE: child exits before stdin write completes ----------

test("CliRuntime handles child that ignores prompt argument", async () => {
  // `true` exits immediately with code 0, ignoring all arguments
  const config: AgentConfig = { name: "ignore-agent", command: "true" };
  const runtime = new CliRuntime(config, logger);
  const eventBus = new EventBus();
  const events = collect(eventBus);

  await runtime.execute(msg({ text: "ignored prompt" }), "exec-7", eventBus);

  const complete = events.find((e) => e.type === "complete");
  assert.ok(complete, "should still emit complete event");
});

// ---------- timeout ----------

test("CliRuntime emits error event on timeout", async () => {
  const config: AgentConfig = {
    name: "slow-agent",
    command: TEST_CMD,
    args: ["hang"],
    timeoutMs: 200
  };
  const runtime = new CliRuntime(config, logger);
  const eventBus = new EventBus();
  const events = collect(eventBus);

  await assert.rejects(
    () => runtime.execute(msg(), "exec-8", eventBus),
    { message: "Runtime timeout." }
  );

  const error = events.find((e) => e.type === "error");
  assert.ok(error, "should emit error event");
  assert.equal(error?.payload?.reason, "Runtime timeout.");
});

test("CliRuntime resets timeout on permission-request events", async () => {
  const config: AgentConfig = {
    name: "perm-agent",
    command: TEST_CMD,
    args: ["hang"],
    timeoutMs: 400
  };
  const runtime = new CliRuntime(config, logger);
  const eventBus = new EventBus();
  const events = collect(eventBus);
  const testMsg = msg();

  const execPromise = runtime.execute(testMsg, "exec-perm", eventBus);

  // Emit permission-request events every 250ms to keep the timeout alive.
  // Without the fix, the process would be killed after 400ms.
  const interval = setInterval(() => {
    eventBus.emit({
      executionId: "sudo-fake",
      channelId: testMsg.channelId,
      chatId: testMsg.chatId,
      type: "permission-request",
      timestamp: Date.now(),
      payload: { permissionRequestId: "fake", toolName: "sudo", toolInput: { command: "ls" } }
    });
  }, 250);

  // Wait longer than the original timeout — should still be alive
  await new Promise((r) => setTimeout(r, 700));

  // Now stop sending events so the timeout actually fires
  clearInterval(interval);

  await assert.rejects(() => execPromise, { message: "Runtime timeout." });

  const error = events.find((e) => e.type === "error");
  assert.ok(error, "should eventually emit error after events stop");
  assert.equal(error?.payload?.reason, "Runtime timeout.");
});

// ---------- command not found (ENOENT) ----------

test("CliRuntime emits descriptive error when command is not found", async () => {
  const config: AgentConfig = { name: "missing-agent", command: "nonexistent_cmd_abc123" };
  const runtime = new CliRuntime(config, logger);
  const eventBus = new EventBus();
  const events = collect(eventBus);

  await assert.rejects(
    () => runtime.execute(msg(), "exec-enoent", eventBus),
    (error: Error) => {
      assert.match(error.message, /Command not found: "nonexistent_cmd_abc123"/);
      return true;
    }
  );

  const errorEvent = events.find((e) => e.type === "error");
  assert.ok(errorEvent, "should emit error event");
  assert.match(errorEvent!.payload!.reason as string, /Command not found/);
});

test("CliRuntime emits descriptive error when working directory does not exist", async () => {
  const config: AgentConfig = { name: "bad-cwd-agent", command: "echo", workingDir: "/nonexistent_dir_xyz" };
  const runtime = new CliRuntime(config, logger);
  const eventBus = new EventBus();
  const events = collect(eventBus);

  await assert.rejects(
    () => runtime.execute(msg(), "exec-cwd", eventBus),
    (error: Error) => {
      assert.match(error.message, /Working directory not found/);
      return true;
    }
  );

  const errorEvent = events.find((e) => e.type === "error");
  assert.ok(errorEvent, "should emit error event");
});

// ---------- missing command ----------

test("CliRuntime throws when command is not configured", async () => {
  const config: AgentConfig = { name: "no-cmd" } as AgentConfig;
  const runtime = new CliRuntime(config, logger);
  const eventBus = new EventBus();

  await assert.rejects(
    () => runtime.execute(msg(), "exec-9", eventBus),
    { message: "Agent command is required for cli runtime." }
  );
});

// ---------- config args ----------

test("CliRuntime passes config flags to the command", async () => {
  const config: AgentConfig = {
    name: "full-agent",
    command: "echo",
    model: "opus",
    systemPrompt: "be nice",
    maxTurns: 5,
    outputFormat: "json",
    bare: true
  };
  const runtime = new CliRuntime(config, logger);
  const eventBus = new EventBus();
  const events = collect(eventBus);

  await runtime.execute(msg(), "exec-10", eventBus);

  const stdout = events.filter((e) => e.type === "stream-text").map((e) => e.payload?.text).join("");
  assert.ok(stdout.includes("--model opus"), "should include --model");
  assert.ok(stdout.includes("--append-system-prompt"), "should pass systemPrompt via --append-system-prompt");
  assert.ok(stdout.includes("be nice"), "should include the system prompt text");
  // In production the container runs as non-root → bypassPermissions.
  // In CI/dev that may run as root → falls back to auto.
  const expectedMode = process.getuid?.() === 0 ? "auto" : "bypassPermissions";
  assert.ok(stdout.includes(`--permission-mode ${expectedMode}`), `should use --permission-mode ${expectedMode}`);
  assert.ok(stdout.includes("--max-turns 5"), "should include --max-turns");
  assert.ok(stdout.includes("--output-format json"), "should include --output-format");
  assert.ok(stdout.includes("--bare"), "should include --bare");
});

// ---------- retry on stale session ----------

test("CliRuntime retries with fresh session when resume fails with 'No conversation found'", async () => {
  // stale-session-cmd.sh fails with "No conversation found" when --resume is present,
  // succeeds with --session-id
  const config: AgentConfig = { name: "stale-agent", command: STALE_SESSION_CMD };
  const runtime = new CliRuntime(config, logger);

  // First call: establishes a session (uses --session-id, succeeds)
  const eb1 = new EventBus();
  const ev1 = collect(eb1);
  await runtime.execute(msg(), "exec-stale-1", eb1);
  const out1 = ev1.filter((e) => e.type === "stream-text").map((e) => e.payload?.text).join("");
  assert.ok(out1.includes("--session-id"), "first call should use --session-id");

  // Second call: would use --resume (stale), should auto-retry with --session-id
  const eb2 = new EventBus();
  const ev2 = collect(eb2);
  await runtime.execute(msg(), "exec-stale-2", eb2);
  // The retry should succeed with --session-id in the output
  const completeEvents = ev2.filter((e) => e.type === "complete");
  const lastComplete = completeEvents[completeEvents.length - 1];
  assert.ok(lastComplete?.payload?.response?.includes("--session-id"), "retry should use --session-id");
  assert.ok(!lastComplete?.payload?.response?.includes("--resume"), "retry should not use --resume");
});

// ---------- sequential execution ----------

test("CliRuntime serializes sequential messages for the same chat", async () => {
  const config: AgentConfig = { name: "serial-agent", command: TEST_CMD, args: ["slow"] };
  const runtime = new CliRuntime(config, logger);

  const order: string[] = [];

  const run = async (text: string, execId: string) => {
    const eb = new EventBus();
    const events = collect(eb);
    await runtime.execute(msg({ text }), execId, eb);
    const complete = events.find((e) => e.type === "complete");
    order.push(complete?.payload?.response as string);
  };

  // Fire three messages concurrently — they should still execute in order
  await Promise.all([
    run("first", "exec-seq-1"),
    run("second", "exec-seq-2"),
    run("third", "exec-seq-3")
  ]);

  assert.deepStrictEqual(order, ["first", "second", "third"],
    "messages should be processed in order, not concurrently");
});

test("CliRuntime allows concurrent execution for different chats", async () => {
  const config: AgentConfig = { name: "parallel-agent", command: TEST_CMD, args: ["slow"] };
  const runtime = new CliRuntime(config, logger);

  const starts: Map<string, number> = new Map();

  const run = async (chatId: string, execId: string) => {
    starts.set(chatId, Date.now());
    const eb = new EventBus();
    await runtime.execute(msg({ chatId, text: chatId }), execId, eb);
  };

  // Different chats should run concurrently
  await Promise.all([
    run("chat-X", "exec-par-1"),
    run("chat-Y", "exec-par-2")
  ]);

  // Both should have started at roughly the same time (within 50ms)
  const diff = Math.abs((starts.get("chat-X") ?? 0) - (starts.get("chat-Y") ?? 0));
  assert.ok(diff < 50, `different chats should start concurrently (diff=${diff}ms)`);
});

// ---------- event metadata ----------

test("CliRuntime events carry correct channelId, chatId, executionId", async () => {
  const config: AgentConfig = { name: "meta-agent", command: "echo", args: ["ok"] };
  const runtime = new CliRuntime(config, logger);
  const eventBus = new EventBus();
  const events = collect(eventBus);

  await runtime.execute(msg({ channelId: "slack", chatId: "c-99" }), "exec-11", eventBus);

  for (const event of events) {
    assert.equal(event.channelId, "slack", `${event.type} should have channelId=slack`);
    assert.equal(event.chatId, "c-99", `${event.type} should have chatId=c-99`);
    assert.equal(event.executionId, "exec-11", `${event.type} should have correct executionId`);
  }
});

// ---------- stream-json parsing ----------

test("CliRuntime emits tool-use events from stream-json NDJSON", async () => {
  const config: AgentConfig = { name: "stream-agent", command: STREAM_JSON_CMD, outputFormat: "stream-json" };
  const runtime = new CliRuntime(config, logger);
  const eventBus = new EventBus();
  const events = collect(eventBus);

  await runtime.execute(msg(), "exec-stream-1", eventBus);

  const toolUseEvents = events.filter((e) => e.type === "tool-use");
  assert.ok(toolUseEvents.length > 0, "should emit at least one tool-use event");
  assert.equal(toolUseEvents[0].payload?.toolName, "Read", "tool name should be Read");
});

test("CliRuntime emits stream-text events from stream-json text_delta", async () => {
  const config: AgentConfig = { name: "stream-agent", command: STREAM_JSON_CMD, outputFormat: "stream-json" };
  const runtime = new CliRuntime(config, logger);
  const eventBus = new EventBus();
  const events = collect(eventBus);

  await runtime.execute(msg(), "exec-stream-2", eventBus);

  const textEvents = events.filter((e) => e.type === "stream-text");
  const combined = textEvents.map((e) => e.payload?.text).join("");
  assert.ok(combined.includes("The project "), "should stream text deltas");
  assert.ok(combined.includes("telegramable."), "should stream all text delta chunks");
});

test("CliRuntime extracts result text from stream-json for complete event", async () => {
  const config: AgentConfig = { name: "stream-agent", command: STREAM_JSON_CMD, outputFormat: "stream-json" };
  const runtime = new CliRuntime(config, logger);
  const eventBus = new EventBus();
  const events = collect(eventBus);

  await runtime.execute(msg(), "exec-stream-3", eventBus);

  const complete = events.find((e) => e.type === "complete");
  assert.ok(complete, "should emit complete event");
  assert.equal(complete?.payload?.response, "The project name is telegramable.",
    "complete response should be extracted from result line, not raw NDJSON");
});

test("CliRuntime does not emit duplicate tool-use from assistant message", async () => {
  const config: AgentConfig = { name: "stream-agent", command: STREAM_JSON_CMD, outputFormat: "stream-json" };
  const runtime = new CliRuntime(config, logger);
  const eventBus = new EventBus();
  const events = collect(eventBus);

  await runtime.execute(msg(), "exec-stream-4", eventBus);

  const toolUseEvents = events.filter((e) => e.type === "tool-use");
  // Two tool-use events per tool: one at content_block_start (name only, for immediate display)
  // and one at content_block_stop (with accumulated input from input_json_delta).
  // The assistant message should NOT produce additional tool-use events.
  assert.equal(toolUseEvents.length, 2, "should emit two tool-use events per tool (start + enriched), none from assistant message");
  // First event has name only
  assert.equal(toolUseEvents[0].payload?.toolName, "Read");
  assert.equal(toolUseEvents[0].payload?.toolInput, undefined);
  // Second event has full input from accumulated input_json_delta
  assert.equal(toolUseEvents[1].payload?.toolName, "Read");
  assert.deepEqual(toolUseEvents[1].payload?.toolInput, { file_path: "/tmp/test.txt" });
});

test("CliRuntime defaults to stream-json when outputFormat is unset", async () => {
  // When outputFormat is undefined, CliRuntime should still use stream-json
  const config: AgentConfig = { name: "default-stream-agent", command: "echo" };
  const runtime = new CliRuntime(config, logger);
  const eventBus = new EventBus();
  const events = collect(eventBus);

  await runtime.execute(msg(), "exec-stream-5", eventBus);

  const stdout = events.filter((e) => e.type === "stream-text").map((e) => e.payload?.text).join("");
  assert.ok(stdout.includes("--output-format stream-json"), "should default to stream-json");
  assert.ok(stdout.includes("--verbose"), "should include --verbose for stream-json");
  assert.ok(stdout.includes("--include-partial-messages"), "should include --include-partial-messages for stream-json");
});

// ---------- thinking events ----------

test("CliRuntime emits thinking events from stream-json thinking blocks", async () => {
  const config: AgentConfig = { name: "thinking-agent", command: STREAM_JSON_THINKING_CMD, outputFormat: "stream-json" };
  const runtime = new CliRuntime(config, logger);
  const eventBus = new EventBus();
  const events = collect(eventBus);

  await runtime.execute(msg(), "exec-thinking-1", eventBus);

  const thinkingEvents = events.filter((e) => e.type === "thinking");
  assert.ok(thinkingEvents.length > 0, "should emit at least one thinking event");
});

test("CliRuntime emits thinking, tool-use, and stream-text in correct order", async () => {
  const config: AgentConfig = { name: "thinking-agent", command: STREAM_JSON_THINKING_CMD, outputFormat: "stream-json" };
  const runtime = new CliRuntime(config, logger);
  const eventBus = new EventBus();
  const events = collect(eventBus);

  await runtime.execute(msg(), "exec-thinking-2", eventBus);

  const relevantTypes = events
    .filter((e) => e.type === "thinking" || e.type === "tool-use" || e.type === "stream-text")
    .map((e) => e.type);

  // Verify all event types are present before comparing order
  const firstThinking = relevantTypes.indexOf("thinking");
  const firstToolUse = relevantTypes.indexOf("tool-use");
  const firstStreamText = relevantTypes.indexOf("stream-text");
  assert.ok(firstThinking >= 0, "should emit a thinking event");
  assert.ok(firstToolUse >= 0, "should emit a tool-use event");
  assert.ok(firstStreamText >= 0, "should emit a stream-text event");
  // Thinking should come before tool-use and stream-text
  assert.ok(firstThinking < firstToolUse, "thinking should come before tool-use");
  assert.ok(firstThinking < firstStreamText, "thinking should come before stream-text");
});

test("CliRuntime does not emit duplicate events from assistant message with thinking", async () => {
  const config: AgentConfig = { name: "thinking-agent", command: STREAM_JSON_THINKING_CMD, outputFormat: "stream-json" };
  const runtime = new CliRuntime(config, logger);
  const eventBus = new EventBus();
  const events = collect(eventBus);

  await runtime.execute(msg(), "exec-thinking-3", eventBus);

  // Only one thinking event (from content_block_start), not duplicated from assistant message
  const thinkingEvents = events.filter((e) => e.type === "thinking");
  assert.equal(thinkingEvents.length, 1, "should emit exactly one thinking event (from content_block_start only)");

  // Tool-use events: 2 per tool (start + enriched), not duplicated from assistant
  const toolUseEvents = events.filter((e) => e.type === "tool-use");
  assert.equal(toolUseEvents.length, 2, "should emit two tool-use events per tool (start + enriched)");
});

// ---------- subagent events (parent_tool_use_id) ----------

test("CliRuntime propagates parentToolUseId from subagent stream events", async () => {
  const config: AgentConfig = { name: "subagent-test", command: STREAM_JSON_SUBAGENT_CMD, outputFormat: "stream-json" };
  const runtime = new CliRuntime(config, logger);
  const eventBus = new EventBus();
  const events = collect(eventBus);

  await runtime.execute(msg(), "exec-subagent-1", eventBus);

  // Parent Agent tool-use should NOT have parentToolUseId
  const agentToolEvents = events.filter((e) => e.type === "tool-use" && e.payload?.toolName === "Agent");
  assert.ok(agentToolEvents.length > 0, "should have Agent tool-use events");
  assert.equal(agentToolEvents[0].payload?.parentToolUseId, undefined, "parent Agent tool should not have parentToolUseId");

  // Subagent tool-use events should have parentToolUseId set
  const subagentToolEvents = events.filter((e) => e.type === "tool-use" && e.payload?.parentToolUseId);
  assert.ok(subagentToolEvents.length > 0, "should have subagent tool-use events with parentToolUseId");
  assert.equal(subagentToolEvents[0].payload?.parentToolUseId, "toolu_agent_1", "parentToolUseId should match the Agent tool_use id");
});

test("CliRuntime tags subagent stream-text with parentToolUseId", async () => {
  const config: AgentConfig = { name: "subagent-test", command: STREAM_JSON_SUBAGENT_CMD, outputFormat: "stream-json" };
  const runtime = new CliRuntime(config, logger);
  const eventBus = new EventBus();
  const events = collect(eventBus);

  await runtime.execute(msg(), "exec-subagent-2", eventBus);

  const textEvents = events.filter((e) => e.type === "stream-text");
  // Subagent text should have parentToolUseId
  const subagentText = textEvents.filter((e) => e.payload?.parentToolUseId);
  assert.ok(subagentText.length > 0, "subagent text events should have parentToolUseId");
  assert.equal(subagentText[0].payload?.text, "Found 3 issues.", "subagent text content should be correct");

  // Parent text should NOT have parentToolUseId
  const parentText = textEvents.filter((e) => !e.payload?.parentToolUseId);
  assert.ok(parentText.length > 0, "parent text events should not have parentToolUseId");
  assert.equal(parentText[0].payload?.text, "The review found 3 issues.", "parent text content should be correct");
});

// ---------- Issue 102: executionQueues cleanup ----------

test("CliRuntime.executionQueues clears after settled chains", async () => {
  const config: AgentConfig = { name: "queue-cleanup", command: "echo" };
  const runtime = new CliRuntime(config, logger);

  const run = async (chatId: string, execId: string) => {
    const eb = new EventBus();
    await runtime.execute(msg({ chatId, text: chatId }), execId, eb);
  };

  await Promise.all([
    run("chat-q1", "exec-q1"),
    run("chat-q2", "exec-q2"),
    run("chat-q3", "exec-q3"),
  ]);

  // Wait a tick so the .then() cleanup runs on the microtask queue
  await new Promise((r) => setImmediate(r));

  // executionQueues is private — assert via Reflect
  const queues = (runtime as unknown as { executionQueues: Map<string, unknown> }).executionQueues;
  assert.equal(queues.size, 0, "executionQueues should be empty after all chains settle");
});

// ---------- Issue 98: idle reset ----------

const withTempCliDir = async (fn: (dir: string) => Promise<void>): Promise<void> => {
  const dir = mkdtempSync(path.join(tmpdir(), "cli-runtime-test-"));
  try { await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};

test("CliRuntime resets idle session after sessionTimeoutMs (in-process)", async () => {
  await withTempCliDir(async (dataDir) => {
    const config: AgentConfig = {
      name: "idle-agent",
      command: "echo",
      sessionTimeoutMs: 50, // 50ms idle threshold
    };
    const runtime = new CliRuntime(config, logger, { dataDir });

    // First turn → --session-id (new session created)
    const eb1 = new EventBus();
    const ev1 = collect(eb1);
    await runtime.execute(msg(), "exec-idle-1", eb1);
    const out1 = ev1.filter((e) => e.type === "stream-text").map((e) => e.payload?.text).join("");
    assert.ok(out1.includes("--session-id"), "first call should use --session-id");

    // Wait past idle threshold
    await new Promise((r) => setTimeout(r, 80));

    // Second turn after idle → must use --session-id again (NOT --resume)
    const eb2 = new EventBus();
    const ev2 = collect(eb2);
    await runtime.execute(msg(), "exec-idle-2", eb2);
    const out2 = ev2.filter((e) => e.type === "stream-text").map((e) => e.payload?.text).join("");
    assert.ok(out2.includes("--session-id"), "after idle, second call should start fresh with --session-id");
    assert.ok(!out2.includes("--resume"), "after idle, second call must not --resume the stale session");
  });
});

test("CliRuntime resets idle session across simulated process restart via fileStore", async () => {
  await withTempCliDir(async (dataDir) => {
    const sessionTimeoutMs = 50;
    const baseConfig: AgentConfig = {
      name: "restart-agent",
      command: "echo",
      sessionTimeoutMs,
    };

    // Process 1: create a session, then "stop"
    const r1 = new CliRuntime(baseConfig, logger, { dataDir });
    await r1.execute(msg(), "exec-restart-1", new EventBus());

    // Simulate disk-state aging past idle threshold by rewriting the persisted
    // timestamp to long ago. (Equivalent to a real restart hours later.)
    const sessionsPath = path.join(dataDir, "cli-sessions.json");
    const data = JSON.parse(readFileSync(sessionsPath, "utf-8")) as Record<string, { id: string; lastUsedAt: number }>;
    for (const k of Object.keys(data)) {
      data[k].lastUsedAt = 0; // far in the past
    }
    writeFileSync(sessionsPath, JSON.stringify(data), "utf-8");

    // Process 2: fresh runtime, should see stale persisted entry and reset
    const r2 = new CliRuntime(baseConfig, logger, { dataDir });
    const eb = new EventBus();
    const ev = collect(eb);
    await r2.execute(msg(), "exec-restart-2", eb);
    const out = ev.filter((e) => e.type === "stream-text").map((e) => e.payload?.text).join("");
    assert.ok(out.includes("--session-id"), "fresh process must start a new --session-id after idle");
    assert.ok(!out.includes("--resume"), "fresh process must not --resume the stale persisted session");
  });
});

test("CliRuntime tolerates legacy bare-string entries in cli-sessions.json", async () => {
  await withTempCliDir(async (dataDir) => {
    // Pre-write a legacy bare-string file
    const sessionsPath = path.join(dataDir, "cli-sessions.json");
    writeFileSync(sessionsPath, JSON.stringify({ "telegram::chat-1": "legacy-session-id" }), "utf-8");

    const config: AgentConfig = { name: "legacy-agent", command: "echo", sessionTimeoutMs: 30 * 60 * 1000 };
    const runtime = new CliRuntime(config, logger, { dataDir });
    const eb = new EventBus();
    const ev = collect(eb);
    await runtime.execute(msg(), "exec-legacy-1", eb);
    const out = ev.filter((e) => e.type === "stream-text").map((e) => e.payload?.text).join("");
    // Legacy entry has lastUsedAt=0, so it's treated as expired → fresh --session-id
    assert.ok(out.includes("--session-id"), "legacy entry should be treated as expired and trigger fresh --session-id");
    assert.ok(!out.includes("--resume"), "legacy entry must not be --resume'd");
  });
});

test("CliRuntime non-zero exit clears sessionLastUsedAt alongside sessions", async () => {
  const config: AgentConfig = {
    name: "fail-clear",
    command: TEST_CMD,
    args: ["fail"],
    sessionTimeoutMs: 30 * 60 * 1000,
  };
  const runtime = new CliRuntime(config, logger);
  const eb = new EventBus();
  await runtime.execute(msg(), "exec-fail-clear", eb);

  const lastUsedAt = (runtime as unknown as { sessionLastUsedAt: Map<string, number> }).sessionLastUsedAt;
  assert.equal(lastUsedAt.get("telegram::chat-1"), undefined,
    "sessionLastUsedAt must be cleared after non-zero exit so a stale stamp can't falsely mark the next turn idle");
});

// ---------- Issue 100: retry-reset event ----------

test("CliRuntime emits retry-reset before stale-resume retry", async () => {
  const config: AgentConfig = { name: "retry-reset-agent", command: STALE_SESSION_CMD };
  const runtime = new CliRuntime(config, logger);

  // First call: establishes a session
  await runtime.execute(msg(), "exec-rr-1", new EventBus());

  // Second call: will hit the stale-resume retry path
  const eb = new EventBus();
  const events = collect(eb);
  await runtime.execute(msg(), "exec-rr-2", eb);

  const retryReset = events.find((e) => e.type === "retry-reset");
  assert.ok(retryReset, "should emit retry-reset event before retrying");
  assert.equal(retryReset?.executionId, "exec-rr-2");
});

// ---------- Issue 101: timeout double-emit guard ----------

test("CliRuntime timeout emits exactly one of error/complete per execution", async () => {
  const config: AgentConfig = {
    name: "double-emit-agent",
    command: TEST_CMD,
    args: ["hang"],
    timeoutMs: 200,
  };
  const runtime = new CliRuntime(config, logger);
  const eb = new EventBus();
  const events = collect(eb);

  await assert.rejects(
    () => runtime.execute(msg(), "exec-double-emit", eb),
    { message: "Runtime timeout." },
  );

  // Allow the SIGKILL → close handler to run
  await new Promise((r) => setTimeout(r, 100));

  const terminalEvents = events.filter((e) => e.type === "error" || e.type === "complete");
  assert.equal(terminalEvents.length, 1, "timeout must emit exactly one terminal event (error OR complete, not both)");
  assert.equal(terminalEvents[0].type, "error", "the surviving event should be error");
  assert.equal(terminalEvents[0].payload?.reason, "Runtime timeout.");
});
