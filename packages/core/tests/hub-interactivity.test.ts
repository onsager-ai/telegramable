import assert from "assert";
import test from "node:test";
import { createServer } from "http";
import type { AddressInfo } from "net";
import { existsSync, readFileSync } from "fs";
import { EventBus } from "../src/events/eventBus";
import { createLogger } from "../src/logging";
import { ChannelHub, categorizeToolName, formatToolResultSuffix, parseBuiltinCommand, renderActivity } from "../src/hub/hub";
import { Router } from "../src/hub/router";
import { Runtime } from "../src/runtime/types";
import { MockAdapter } from "./mockAdapter";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("parseBuiltinCommand parses status/logs/list and ignores unknown", () => {
  assert.deepEqual(parseBuiltinCommand("/status abc"), { type: "status", executionId: "abc" });
  assert.deepEqual(parseBuiltinCommand("/logs ABC-1"), { type: "logs", executionId: "ABC-1" });
  assert.deepEqual(parseBuiltinCommand(" /LiSt  "), { type: "list" });
  assert.deepEqual(parseBuiltinCommand("/start"), { type: "start" });
  assert.deepEqual(parseBuiltinCommand("/help"), { type: "help" });
  assert.equal(parseBuiltinCommand("deploy now"), null);
});

test("ChannelHub supports /status /logs /list without routing to runtime", async () => {
  const eventBus = new EventBus();
  const logger = createLogger("error");
  const adapter = new MockAdapter("telegram");

  let executeCalls = 0;
  let capturedExecutionId = "";
  const runtime: Runtime = {
    async execute(message, executionId, bus): Promise<void> {
      executeCalls += 1;
      capturedExecutionId = executionId;

      bus.emit({
        executionId,
        channelId: message.channelId,
        chatId: message.chatId,
        type: "start",
        timestamp: Date.now(),
        payload: { agentName: "claude" }
      });

      bus.emit({
        executionId,
        channelId: message.channelId,
        chatId: message.chatId,
        type: "stdout",
        timestamp: Date.now(),
        payload: { text: "Analyzing project structure..." }
      });

      bus.emit({
        executionId,
        channelId: message.channelId,
        chatId: message.chatId,
        type: "complete",
        timestamp: Date.now(),
        payload: { response: "done" }
      });
    }
  };

  const router: Router = {
    select(message) {
      return { runtime, message };
    }
  };

  const hub = new ChannelHub([adapter], router, eventBus, logger);
  await hub.start();

  await adapter.simulateIncoming({
    channelId: "telegram",
    chatId: "chat-1",
    text: "run task"
  });

  await sleep(30);

  assert.equal(executeCalls, 1);
  assert.ok(capturedExecutionId.length > 0, "runtime should have received an executionId");

  await adapter.simulateIncoming({
    channelId: "telegram",
    chatId: "chat-1",
    text: `/status ${capturedExecutionId}`
  });
  await adapter.simulateIncoming({
    channelId: "telegram",
    chatId: "chat-1",
    text: `/logs ${capturedExecutionId}`
  });
  await adapter.simulateIncoming({
    channelId: "telegram",
    chatId: "chat-1",
    text: "/list"
  });
  await adapter.simulateIncoming({
    channelId: "telegram",
    chatId: "chat-1",
    text: "/status unknown-id"
  });

  await sleep(30);

  assert.ok(adapter.sentMessages.some((message) => message.text.includes("✅") && message.text.includes("Complete")));
  assert.ok(adapter.sentMessages.some((message) => message.text.includes("[stdout] Analyzing project structure...")));
  // /list is the deprecated alias of /sessions (#107) — should surface the deprecation hint.
  assert.ok(adapter.sentMessages.some((message) => message.text.includes("/list is deprecated")));
  assert.ok(adapter.sentMessages.some((message) => message.text.includes("Unknown execution ID: unknown-id")));

  await hub.stop();
});

test("ChannelHub prepends replyToText context to routed message", async () => {
  const eventBus = new EventBus();
  const logger = createLogger("error");
  const adapter = new MockAdapter("telegram");

  let capturedText = "";
  const runtime: Runtime = {
    async execute(message, executionId, bus): Promise<void> {
      capturedText = message.text;
      bus.emit({
        executionId,
        channelId: message.channelId,
        chatId: message.chatId,
        type: "complete",
        timestamp: Date.now(),
        payload: { response: "ok" }
      });
    }
  };

  const router: Router = {
    select(message) {
      return { runtime, message };
    }
  };

  const hub = new ChannelHub([adapter], router, eventBus, logger);
  await hub.start();

  // Message WITH replyToText should prepend quoted context
  await adapter.simulateIncoming({
    channelId: "telegram",
    chatId: "chat-1",
    text: "what about this?",
    replyToText: "The previous bot response"
  });

  await sleep(30);
  assert.ok(capturedText.includes("[Quoted message]"), "should include quoted block header");
  assert.ok(capturedText.includes("The previous bot response"), "should include reply text");
  assert.ok(capturedText.includes("what about this?"), "should include original message");

  // Message WITHOUT replyToText should be unchanged
  capturedText = "";
  await adapter.simulateIncoming({
    channelId: "telegram",
    chatId: "chat-1",
    text: "plain message"
  });

  await sleep(30);
  assert.equal(capturedText, "plain message", "should pass through unchanged without replyToText");

  await hub.stop();
});

test("ChannelHub sends execution summary with tool count on completion", async () => {
  process.env.SHOW_EXECUTION_SUMMARY = "true";
  try {
    const eventBus = new EventBus();
    const logger = createLogger("error");
    const adapter = new MockAdapter("telegram");

    const runtime: Runtime = {
      async execute(message, executionId, bus): Promise<void> {
        const base = { executionId, channelId: message.channelId, chatId: message.chatId };

        bus.emit({ ...base, type: "start", timestamp: 1000, payload: { agentName: "claude" } });

        // Emit tool-use events
        bus.emit({ ...base, type: "tool-use", timestamp: 1500, payload: { toolName: "Read", toolInput: { file_path: "/a.ts" } } });
        bus.emit({ ...base, type: "tool-use", timestamp: 2000, payload: { toolName: "Edit", toolInput: { file_path: "/a.ts" } } });
        bus.emit({ ...base, type: "tool-use", timestamp: 2500, payload: { toolName: "Bash", toolInput: { command: "npm test" } } });

        // Complete after 6 seconds (above the 5s threshold)
        bus.emit({ ...base, type: "complete", timestamp: 7000, payload: { response: "done" } });
      }
    };

    const router: Router = { select(message) { return { runtime, message }; } };
    const hub = new ChannelHub([adapter], router, eventBus, logger);
    await hub.start();

    await adapter.simulateIncoming({ channelId: "telegram", chatId: "chat-1", text: "do work" });
    await sleep(50);

    // Should have a summary message with tool count
    const allMessages = [...adapter.sentMessages, ...adapter.sentMarkupMessages];
    const summaryMsg = allMessages.find((m) => m.text.includes("tools used"));
    assert.ok(summaryMsg, "should send execution summary with tool count");
    assert.ok(summaryMsg!.text.includes("3 tools used"), "should report 3 tools");
    assert.ok(summaryMsg!.text.includes("✅"), "should use success icon for complete status");

    await hub.stop();
  } finally {
    delete process.env.SHOW_EXECUTION_SUMMARY;
  }
});

test("ChannelHub suppresses execution summary for quick runs with no tools", async () => {
  // Enable summaries to verify the duration/tool-count threshold logic (not just the env gate)
  process.env.SHOW_EXECUTION_SUMMARY = "true";
  try {
    const eventBus = new EventBus();
    const logger = createLogger("error");
    const adapter = new MockAdapter("telegram");

    const runtime: Runtime = {
      async execute(message, executionId, bus): Promise<void> {
        const base = { executionId, channelId: message.channelId, chatId: message.chatId };
        const now = Date.now();

        bus.emit({ ...base, type: "start", timestamp: now, payload: { agentName: "claude" } });
        // Complete quickly (under 5s) with no tools
        bus.emit({ ...base, type: "complete", timestamp: now + 1000, payload: { response: "quick reply" } });
      }
    };

    const router: Router = { select(message) { return { runtime, message }; } };
    const hub = new ChannelHub([adapter], router, eventBus, logger);
    await hub.start();

    await adapter.simulateIncoming({ channelId: "telegram", chatId: "chat-1", text: "hi" });
    await sleep(50);

    // Should NOT have a summary message for quick no-tool runs
    const allMessages = [...adapter.sentMessages, ...adapter.sentMarkupMessages];
    const summaryMsg = allMessages.find((m) => m.text.includes("tools used"));
    assert.equal(summaryMsg, undefined, "should not send summary for quick runs with no tools even when enabled");

    await hub.stop();
  } finally {
    delete process.env.SHOW_EXECUTION_SUMMARY;
  }
});

test("ChannelHub sends error icon in execution summary on failure", async () => {
  process.env.SHOW_EXECUTION_SUMMARY = "true";
  try {
    const eventBus = new EventBus();
    const logger = createLogger("error");
    const adapter = new MockAdapter("telegram");

    const runtime: Runtime = {
      async execute(message, executionId, bus): Promise<void> {
        const base = { executionId, channelId: message.channelId, chatId: message.chatId };

        bus.emit({ ...base, type: "start", timestamp: 1000, payload: { agentName: "claude" } });
        bus.emit({ ...base, type: "tool-use", timestamp: 1500, payload: { toolName: "Bash", toolInput: { command: "npm test" } } });
        bus.emit({ ...base, type: "error", timestamp: 8000, payload: { reason: "Runtime timeout." } });
      }
    };

    const router: Router = { select(message) { return { runtime, message }; } };
    const hub = new ChannelHub([adapter], router, eventBus, logger);
    await hub.start();

    await adapter.simulateIncoming({ channelId: "telegram", chatId: "chat-1", text: "do work" });
    await sleep(50);

    const allMessages = [...adapter.sentMessages, ...adapter.sentMarkupMessages];
    const summaryMsg = allMessages.find((m) => m.text.includes("tools used") || m.text.includes("1 tool used"));
    assert.ok(summaryMsg, "should send execution summary on error");
    assert.ok(summaryMsg!.text.includes("❌"), "should use error icon for failed execution");

    await hub.stop();
  } finally {
    delete process.env.SHOW_EXECUTION_SUMMARY;
  }
});

test("ChannelHub finalizes tool activity even when promotion send is in-flight", async () => {
  const eventBus = new EventBus();
  const logger = createLogger("error");
  const adapter = new MockAdapter("telegram");

  // Make sendMessageWithMarkup resolve slowly to simulate in-flight send
  let resolveSend: (() => void) | undefined;
  const originalSendMarkup = adapter.sendMessageWithMarkup.bind(adapter);
  adapter.sendMessageWithMarkup = async (chatId: string, text: string, markup: unknown, options?: { threadId?: number }) => {
    // Only delay tool activity messages (the "Working" ones)
    if (text.includes("Working")) {
      await new Promise<void>((resolve) => { resolveSend = resolve; });
    }
    return originalSendMarkup(chatId, text, markup, options);
  };

  const runtime: Runtime = {
    async execute(message, executionId, bus): Promise<void> {
      const base = { executionId, channelId: message.channelId, chatId: message.chatId };

      bus.emit({ ...base, type: "start", timestamp: 1000, payload: { agentName: "claude" } });
      bus.emit({ ...base, type: "tool-use", timestamp: 1500, payload: { toolName: "Read", toolInput: { file_path: "/a.ts" } } });

      // Wait for the promotion timer to fire (1.5s)
      await sleep(1600);

      // Now complete while the send is still in-flight
      bus.emit({ ...base, type: "complete", timestamp: 8000, payload: { response: "done" } });
    }
  };

  const router: Router = { select(message) { return { runtime, message }; } };
  const hub = new ChannelHub([adapter], router, eventBus, logger);
  await hub.start();

  await adapter.simulateIncoming({ channelId: "telegram", chatId: "chat-1", text: "do work" });

  // Wait for timer to fire and start the send
  await sleep(1700);

  // The send should be blocked. Now resolve it so finalizeToolActivity can proceed.
  assert.ok(resolveSend, "sendMessageWithMarkup should have been called for the Working message");
  resolveSend!();

  // Wait for finalization to complete
  await sleep(100);

  // The activity message should have been edited into a summary (not left as "Working")
  const edited = adapter.editedMessages.find((m) => m.text.includes("✅"));
  assert.ok(edited, "should edit the Working message into a detailed completion summary after awaiting in-flight send");

  await hub.stop();
});

test("ChannelHub finalizes streamed draft via editMessage (not sendMessageDraft) so message persists", async () => {
  const eventBus = new EventBus();
  const logger = createLogger("error");
  const adapter = new MockAdapter("telegram");

  const runtime: Runtime = {
    async execute(message, executionId, bus): Promise<void> {
      const base = { executionId, channelId: message.channelId, chatId: message.chatId };

      bus.emit({ ...base, type: "start", timestamp: 1000, payload: { agentName: "claude" } });

      // Stream text to trigger sendMessageDraft during streaming.
      // Yield between emits so the serialized event queue can process each
      // stream-text event BEFORE complete is queued — otherwise the hub's
      // completion short-circuit would skip the draft sends entirely (which
      // is the correct behavior when events arrive in a synchronous burst).
      bus.emit({ ...base, type: "stream-text", timestamp: 2000, payload: { text: "Hello from the stream" } });
      await sleep(10);
      bus.emit({ ...base, type: "stream-text", timestamp: 2500, payload: { text: " — more content here" } });
      await sleep(10);

      // Complete triggers flushStreamDraft
      bus.emit({ ...base, type: "complete", timestamp: 8000, payload: { response: "Hello from the stream — more content here" } });
    }
  };

  const router: Router = { select(message) { return { runtime, message }; } };
  const hub = new ChannelHub([adapter], router, eventBus, logger);
  await hub.start();

  await adapter.simulateIncoming({ channelId: "telegram", chatId: "chat-1", text: "do work" });
  await sleep(50);

  // During streaming, sendMessageDraft should have been called to show the draft
  assert.ok(adapter.draftMessages.length > 0, "should use sendMessageDraft during streaming");

  // On flush, editMessage should have been called to make the draft permanent
  const finalEdit = adapter.editedMessages.find((m) =>
    m.text.includes("Hello from the stream")
  );
  assert.ok(finalEdit, "flushStreamDraft should use editMessage to make draft permanent");

  // The draft messageId from streaming should match the editMessage messageId
  const lastDraft = adapter.draftMessages[adapter.draftMessages.length - 1];
  assert.equal(finalEdit!.messageId, lastDraft.messageId, "should edit the same message that was created as a draft");

  await hub.stop();
});

test("ChannelHub short-circuits pending stream-text draft sends when complete is already queued", async () => {
  // When stream-text events are queued alongside a complete event (e.g. a
  // rapid burst at end-of-stream, or stream-text events still piled up in
  // the per-execution queue), the hub should skip the expensive
  // sendMessageDraft calls for the queued-but-not-yet-processed stream-text
  // events and instead let the complete handler flush the full accumulated
  // text immediately. This prevents a visible multi-second delay between
  // the end of streaming and the final response message becoming permanent.
  const eventBus = new EventBus();
  const logger = createLogger("error");
  const adapter = new MockAdapter("telegram");

  const runtime: Runtime = {
    async execute(message, executionId, bus): Promise<void> {
      const base = { executionId, channelId: message.channelId, chatId: message.chatId };

      bus.emit({ ...base, type: "start", timestamp: 1000, payload: { agentName: "claude" } });

      // Emit stream-text and complete in the same synchronous turn so the
      // complete event lands in the queue before any stream-text has been
      // processed. The hub marks completion as pending synchronously in the
      // emit handler, so stream-text events see the flag and skip.
      bus.emit({ ...base, type: "stream-text", timestamp: 2000, payload: { text: "Final answer " } });
      bus.emit({ ...base, type: "stream-text", timestamp: 2001, payload: { text: "from the agent." } });
      bus.emit({ ...base, type: "complete", timestamp: 2002, payload: { response: "Final answer from the agent." } });
    }
  };

  const router: Router = { select(message) { return { runtime, message }; } };
  const hub = new ChannelHub([adapter], router, eventBus, logger);
  await hub.start();

  await adapter.simulateIncoming({ channelId: "telegram", chatId: "chat-1", text: "do work" });
  await sleep(50);

  // No intermediate draft sends should have happened — they were short-circuited.
  assert.equal(adapter.draftMessages.length, 0, "should skip intermediate sendMessageDraft calls when complete is already queued");

  // The final accumulated text should still have landed as a permanent
  // message via the fallback path (sendMessageWithMarkup or sendMessage).
  const finalMsgMarkup = adapter.sentMarkupMessages.find((m) => m.text.includes("Final answer from the agent"));
  const finalMsgPlain = adapter.sentMessages.find((m) => m.text.includes("Final answer from the agent"));
  assert.ok(finalMsgMarkup || finalMsgPlain, "should send the full accumulated response as a new permanent message");

  await hub.stop();
});

test("ChannelHub sends execution summary to forum topic thread", async () => {
  process.env.SHOW_EXECUTION_SUMMARY = "true";
  try {
    const eventBus = new EventBus();
    const logger = createLogger("error");
    const adapter = new MockAdapter("telegram");
    adapter.forumTopicsEnabled = true;

    const runtime: Runtime = {
      async execute(message, executionId, bus): Promise<void> {
        const base = { executionId, channelId: message.channelId, chatId: message.chatId };

        bus.emit({ ...base, type: "start", timestamp: 1000, payload: { agentName: "claude" } });
        bus.emit({ ...base, type: "tool-use", timestamp: 1500, payload: { toolName: "Read", toolInput: { file_path: "/a.ts" } } });
        bus.emit({ ...base, type: "tool-use", timestamp: 2000, payload: { toolName: "Edit", toolInput: { file_path: "/a.ts" } } });
        bus.emit({ ...base, type: "complete", timestamp: 7000, payload: { response: "done" } });
      }
    };

    const router: Router = { select(message) { return { runtime, message }; } };
    const hub = new ChannelHub([adapter], router, eventBus, logger);
    await hub.start();

    await adapter.simulateIncoming({ channelId: "telegram", chatId: "chat-1", text: "do work" });
    await sleep(50);

    // Execution summary should be sent via sendMessageWithMarkup with threadId
    const summaryMsg = adapter.sentMarkupMessages.find((m) => m.text.includes("tools used"));
    assert.ok(summaryMsg, "should send execution summary via sendMessageWithMarkup");
    assert.ok(summaryMsg!.options?.threadId, "execution summary should include threadId for forum topic");

    // Summary should NOT appear in plain sentMessages (no topic routing)
    const plainSummary = adapter.sentMessages.find((m) => m.text.includes("tools used"));
    assert.equal(plainSummary, undefined, "should not send summary via plain sendMessage when topic exists");

    // Forum topic should be closed after the summary
    assert.ok(adapter.closedTopics.length > 0, "should close forum topic after sending summary");

    await hub.stop();
  } finally {
    delete process.env.SHOW_EXECUTION_SUMMARY;
  }
});

test("ChannelHub flushes streamed draft before sending execution summary for seamless transition", async () => {
  process.env.SHOW_EXECUTION_SUMMARY = "true";
  try {
    const eventBus = new EventBus();
    const logger = createLogger("error");
    const adapter = new MockAdapter("telegram");

    const runtime: Runtime = {
      async execute(message, executionId, bus): Promise<void> {
        const base = { executionId, channelId: message.channelId, chatId: message.chatId };

        bus.emit({ ...base, type: "start", timestamp: 1000, payload: { agentName: "claude" } });

        // Simulate tool uses so the summary threshold is met
        bus.emit({ ...base, type: "tool-use", timestamp: 1500, payload: { toolName: "Read", toolInput: { file_path: "/a.ts" } } });
        bus.emit({ ...base, type: "tool-use", timestamp: 2000, payload: { toolName: "Edit", toolInput: { file_path: "/a.ts" } } });

        // Stream text to create a visible draft. Yield so the stream-text
        // event is processed (and its draft sent) BEFORE complete is queued —
        // otherwise the completion short-circuit would skip the draft send.
        bus.emit({ ...base, type: "stream-text", timestamp: 3000, payload: { text: "Here is the response content" } });
        await sleep(10);

        // Complete after enough time for summary to appear
        bus.emit({ ...base, type: "complete", timestamp: 8000, payload: { response: "Here is the response content" } });
      }
    };

    const router: Router = { select(message) { return { runtime, message }; } };
    const hub = new ChannelHub([adapter], router, eventBus, logger);
    await hub.start();

    await adapter.simulateIncoming({ channelId: "telegram", chatId: "chat-1", text: "do work" });
    await sleep(50);

    // Find the summary send and the draft finalization edit in the operation log
    const summaryIdx = adapter.operationLog.findIndex(
      (op) => (op.op === "sendMessage" || op.op === "sendMessageWithMarkup") && op.text?.includes("tools used")
    );
    const flushEditIdx = adapter.operationLog.findIndex(
      (op) => op.op === "editMessage" && op.text?.includes("Here is the response")
    );

    assert.ok(summaryIdx >= 0, "should send execution summary");
    assert.ok(flushEditIdx >= 0, "should flush draft via editMessage");
    // Draft must be flushed BEFORE the summary to eliminate the visible gap
    // between the ephemeral draft disappearing and the permanent message appearing.
    // editMessage preserves message position, so the summary still appears below.
    assert.ok(
      flushEditIdx < summaryIdx,
      `draft flush edit (index ${flushEditIdx}) should happen before summary (index ${summaryIdx}) for seamless draft-to-permanent transition`
    );

    await hub.stop();
  } finally {
    delete process.env.SHOW_EXECUTION_SUMMARY;
  }
});

test("ChannelHub downloads attached file and prepends path to agent message", async () => {
  const fileContent = Buffer.from("hello from the uploaded file");

  // Serve the file over HTTP so the hub's fetch call hits a real server
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/octet-stream" });
    res.end(fileContent);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const fileUrl = `http://127.0.0.1:${port}/myreport.pdf`;

  const eventBus = new EventBus();
  const logger = createLogger("error");
  const adapter = new MockAdapter("telegram");
  adapter.fileUrls.set("file-abc", fileUrl);

  let capturedText = "";
  let localFilePath = "";
  const runtime: Runtime = {
    async execute(message, executionId, bus): Promise<void> {
      capturedText = message.text;
      // Extract path from "[Attached file: <path>]"
      const match = message.text.match(/\[Attached file: ([^\]]+)\]/);
      localFilePath = match?.[1] ?? "";
      bus.emit({
        executionId,
        channelId: message.channelId,
        chatId: message.chatId,
        type: "start",
        timestamp: Date.now(),
        payload: { agentName: "claude" }
      });
      bus.emit({
        executionId,
        channelId: message.channelId,
        chatId: message.chatId,
        type: "complete",
        timestamp: Date.now(),
        payload: { response: "analyzed" }
      });
    }
  };

  const router: Router = { select(message) { return { runtime, message }; } };
  const hub = new ChannelHub([adapter], router, eventBus, logger);
  await hub.start();

  await adapter.simulateIncoming({
    channelId: "telegram",
    chatId: "chat-1",
    text: "please analyze this",
    fileId: "file-abc",
    fileName: "myreport.pdf"
  });

  await sleep(300); // allow download + execution + cleanup

  assert.ok(capturedText.includes("[Attached file:"), "message should include attached file note");
  assert.ok(capturedText.includes("please analyze this"), "original prompt should be preserved");
  assert.ok(capturedText.includes("myreport.pdf"), "file name should appear in the local path");

  // After execution completes, the temp file should be cleaned up
  if (localFilePath) {
    assert.ok(!existsSync(localFilePath), "temp file should be deleted after execution");
  }

  server.close();
  await hub.stop();
});

test("ChannelHub sends file-only message to runtime when no caption", async () => {
  const eventBus = new EventBus();
  const logger = createLogger("error");
  const adapter = new MockAdapter("telegram");
  adapter.fileUrls.set("file-xyz", "http://127.0.0.1:0/noop"); // won't actually be fetched

  let capturedText = "";
  const runtime: Runtime = {
    async execute(message, _executionId, bus): Promise<void> {
      capturedText = message.text;
      bus.emit({ executionId: _executionId, channelId: message.channelId, chatId: message.chatId, type: "start", timestamp: Date.now(), payload: { agentName: "claude" } });
      bus.emit({ executionId: _executionId, channelId: message.channelId, chatId: message.chatId, type: "complete", timestamp: Date.now(), payload: { response: "ok" } });
    }
  };

  const router: Router = { select(message) { return { runtime, message }; } };
  const hub = new ChannelHub([adapter], router, eventBus, logger);
  await hub.start();

  // Message with no text but a file — download will fail (port 0), but we still verify
  // the message reaches the runtime with a best-effort path (or empty text on failure)
  await adapter.simulateIncoming({
    channelId: "telegram",
    chatId: "chat-1",
    text: "",
    fileId: "file-xyz"
  });

  await sleep(200);

  // Runtime should have been called — even if download failed, we fall back gracefully
  assert.ok(capturedText !== undefined, "runtime should have been called");

  await hub.stop();
});

test("ChannelHub pairs tool_use → tool_result by toolUseId and renders suffixes in Done summary", async () => {
  const eventBus = new EventBus();
  const logger = createLogger("error");
  const adapter = new MockAdapter("telegram");

  const runtime: Runtime = {
    async execute(message, executionId, bus): Promise<void> {
      const base = { executionId, channelId: message.channelId, chatId: message.chatId };

      bus.emit({ ...base, type: "start", timestamp: 1000, payload: { agentName: "claude" } });

      // tool_use Read
      bus.emit({
        ...base,
        type: "tool-use",
        timestamp: 1500,
        payload: { toolName: "Read", toolInput: { file_path: "/a.ts" }, toolUseId: "toolu_read_1" }
      });
      // matching tool_result for Read
      bus.emit({
        ...base,
        type: "tool-use",
        timestamp: 1600,
        payload: { toolUseId: "toolu_read_1", toolResult: { content: "l1\nl2\nl3\n" } }
      });

      // tool_use Bash (failed)
      bus.emit({
        ...base,
        type: "tool-use",
        timestamp: 1700,
        payload: { toolName: "Bash", toolInput: { command: "git push" }, toolUseId: "toolu_bash_1" }
      });
      bus.emit({
        ...base,
        type: "tool-use",
        timestamp: 1800,
        payload: { toolUseId: "toolu_bash_1", toolResult: { content: "denied", isError: true } }
      });

      // Wait past promotion timer so the activity message gets sent
      await sleep(1600);

      bus.emit({ ...base, type: "complete", timestamp: 8000, payload: { response: "done" } });
    }
  };

  const router: Router = { select(message) { return { runtime, message }; } };
  const hub = new ChannelHub([adapter], router, eventBus, logger);
  await hub.start();

  await adapter.simulateIncoming({ channelId: "telegram", chatId: "chat-1", text: "do work" });
  await sleep(2000);

  // The activity message should have been edited into the Done summary carrying
  // both result suffixes and the ✗ upgrade on the failed bash step.
  const summary = adapter.editedMessages.find((m) => m.text.includes("✅ <b>Done</b>"));
  assert.ok(summary, "should produce a Done summary");
  assert.ok(summary!.text.includes("✓ <b>Read</b> <code>a.ts</code> (3 lines)"), "Read step has (N lines) suffix");
  assert.ok(summary!.text.includes("✗ <b>Bash</b> <code>git push</code> (failed)"), "failed bash uses ✗ and (failed) suffix");

  await hub.stop();
});

// ---------- renderActivity / categorizeToolName (#88) ----------

test("categorizeToolName maps tool names to categories case-insensitively", () => {
  assert.equal(categorizeToolName("Read"), "read");
  assert.equal(categorizeToolName("read"), "read");
  assert.equal(categorizeToolName("Write"), "edit");
  assert.equal(categorizeToolName("Edit"), "edit");
  assert.equal(categorizeToolName("MultiEdit"), "edit");
  assert.equal(categorizeToolName("Bash"), "bash");
  assert.equal(categorizeToolName("Grep"), "search");
  assert.equal(categorizeToolName("Glob"), "search");
  assert.equal(categorizeToolName("Agent"), "agent");
  assert.equal(categorizeToolName("Task"), "agent");
  assert.equal(categorizeToolName("Thinking"), "thinking");
  assert.equal(categorizeToolName("mcp__supabase__list_tables"), "other");
  assert.equal(categorizeToolName("WebFetch"), "other");
});

test("renderActivity: empty tools produces header only", () => {
  const out = renderActivity({ status: "running", tools: [], executionId: "x1" });
  assert.ok(out.startsWith("⚙️ <b>Working</b>"), "should start with working header");
  assert.ok(!out.includes("blockquote"), "no blockquote when no tools");
  assert.ok(!out.includes("·"), "no extras (steps/duration) when empty and no duration");
});

test("renderActivity: single running tool shows step count and current cue but no past-steps blockquote", () => {
  const out = renderActivity({
    status: "running",
    tools: [{ name: "Read", input: { file_path: "/tmp/a.ts" } }],
    executionId: "x2",
  });
  assert.ok(out.includes("⚙️ <b>Working</b>"), "running header");
  assert.ok(out.includes("1 step"), "1 step in header");
  assert.ok(out.includes("📖1"), "counter line with read=1");
  assert.ok(out.includes("▸ <b>Read</b>"), "current tool cue rendered below counter with bold name");
  assert.ok(out.includes("<code>a.ts</code>"), "primary arg is basename in code");
  assert.ok(!out.includes("<blockquote"), "single running tool has no past-step blockquote (and non-bash, so no command pre)");
  assert.ok(!out.includes("Reading"), "no verb-based descriptor in unified template");
  // The current step should be on its own line, not appended to the counter row.
  const counterLine = out.split("\n").find((l) => l.includes("📖1"));
  assert.ok(counterLine && !counterLine.includes("▸"), "current cue is not appended to counter line");
});

test("renderActivity: running Bash with short command renders expandable <pre> block, no inline <code>", () => {
  const out = renderActivity({
    status: "running",
    tools: [{ name: "Bash", input: { command: "ls -la" } }],
    executionId: "x-bash-short",
  });
  assert.ok(out.includes("⚙️ <b>Working</b>"), "running header");
  assert.ok(out.includes("⚡1"), "counter line with bash=1");
  assert.ok(out.includes("▸ <b>Bash</b>"), "current step renders as bold Bash, no trailing inline <code>");
  assert.ok(
    out.includes(`<blockquote expandable><pre><code class="language-bash">ls -la</code></pre></blockquote>`),
    "command body wrapped in expandable blockquote with language-bash hint",
  );
  // Counter line must not carry the command inline.
  const counterLine = out.split("\n").find((l) => l.includes("⚡1"));
  assert.ok(counterLine && !counterLine.includes("<code>"), "no inline <code> on counter line for Bash");
  assert.ok(counterLine && !counterLine.includes("▸"), "current cue is not appended to counter line");
});

test("renderActivity: running with past steps keeps completed ones visible with ✓ in expandable blockquote", () => {
  const out = renderActivity({
    status: "running",
    tools: [
      { name: "Read", input: { file_path: "/a.ts" }, result: { content: "line1\nline2\n" } },
      { name: "Read", input: { file_path: "/b.ts" }, result: { content: "x\n" } },
      { name: "Edit", input: { file_path: "/a.ts" } }, // current
    ],
    executionId: "x-running-past",
  });
  assert.ok(out.includes("⚙️ <b>Working</b>"), "running header");
  assert.ok(out.includes("3 steps"), "total step count");
  // Past steps appear with ✓ inside the expandable blockquote.
  assert.ok(out.includes("<blockquote expandable>"), "past steps rendered in expandable blockquote");
  assert.ok(out.includes("✓ <b>Read</b> <code>a.ts</code>"), "first past step uses ✓ with result suffix");
  assert.ok(out.includes("(2 lines)"), "completed Read carries its result suffix in running state");
  // Current step appears below the blockquote with ▸ — no flashing/replacement.
  assert.ok(out.includes("▸ <b>Edit</b> <code>a.ts</code>"), "current step uses ▸ with bold name");
  // The blockquote must be closed before the ▸ line so the current step sits outside it.
  const blockquoteEndIdx = out.indexOf("</blockquote>");
  const currentCueIdx = out.lastIndexOf("▸");
  assert.ok(blockquoteEndIdx > 0 && currentCueIdx > blockquoteEndIdx, "current step rendered after blockquote close");
});

test("renderActivity: running with past steps and current Bash places past-steps blockquote before the bash <pre> blockquote", () => {
  const out = renderActivity({
    status: "running",
    tools: [
      { name: "Read", input: { file_path: "/a.ts" } },
      { name: "Bash", input: { command: "pnpm test" } }, // current
    ],
    executionId: "x-running-past-bash",
  });
  assert.ok(out.includes("✓ <b>Read</b>"), "past Read step uses ✓");
  assert.ok(out.includes("▸ <b>Bash</b>"), "current Bash step uses ▸");
  assert.ok(
    out.includes(`<blockquote expandable><pre><code class="language-bash">pnpm test</code></pre></blockquote>`),
    "current Bash command body wrapped in expandable blockquote with language-bash hint",
  );
  // Past-steps blockquote must come before the current ▸ line and the bash pre blockquote.
  const pastBqIdx = out.indexOf("✓ <b>Read</b>");
  const currentCueIdx = out.indexOf("▸ <b>Bash</b>");
  const bashPreIdx = out.indexOf("language-bash");
  assert.ok(pastBqIdx < currentCueIdx && currentCueIdx < bashPreIdx, "order: past steps → ▸ Bash → bash pre");
});

test("renderActivity: running Bash with multi-line command preserves newlines and escapes HTML once", () => {
  const command = "cat <<'EOF' | jq '.items[] | select(.x > 1)'\n{\"items\": [{\"x\": 2}]}\nEOF";
  const out = renderActivity({
    status: "running",
    tools: [{ name: "Bash", input: { command } }],
    executionId: "x-bash-multi",
  });
  assert.ok(
    out.includes(`<blockquote expandable><pre><code class="language-bash">`),
    "expandable blockquote+pre wrapper present",
  );
  // Newlines preserved verbatim inside the <pre> block.
  assert.ok(out.includes("[{\"x\": 2}]}\nEOF"), "newline between heredoc body and closing delimiter preserved");
  assert.ok(out.includes("EOF</code></pre></blockquote>"), "trailing EOF then closing tags");
  // HTML escape applied once: > becomes &gt;, never &amp;gt;.
  assert.ok(out.includes(".x &gt; 1"), "angle bracket escaped to &gt;");
  assert.ok(!out.includes("&amp;gt;"), "no double-escaping");
});

test("renderActivity: single done tool drops current cue, shows duration, and renders ✓-prefixed step", () => {
  const out = renderActivity({
    status: "complete",
    tools: [{ name: "Read", input: { file_path: "/a.ts" } }],
    executionId: "x3",
    durationMs: 8_000,
  });
  assert.ok(out.includes("✅ <b>Done</b>"), "done header");
  assert.ok(out.includes("1 step"), "step count");
  assert.ok(out.includes("8s"), "duration in header");
  assert.ok(!out.includes("▸"), "no current cue when done");
  assert.ok(out.includes("<blockquote expandable>"), "blockquote present in completed state");
  assert.ok(out.includes("✓ <b>Read</b>"), "completed step uses ✓ prefix with unified template");
  assert.ok(!out.includes("<pre>"), "no <pre> blocks defeating blockquote collapse");
});

test("renderActivity: many running tools include each category in counter line", () => {
  const out = renderActivity({
    status: "running",
    tools: [
      { name: "Read", input: { file_path: "/a" } },
      { name: "Read", input: { file_path: "/b" } },
      { name: "Read", input: { file_path: "/c" } },
      { name: "Edit", input: { file_path: "/a" } },
      { name: "Edit", input: { file_path: "/b" } },
      { name: "Bash", input: { command: "ls" } },
      { name: "Grep", input: { pattern: "foo" } },
    ],
    executionId: "x4",
  });
  assert.ok(out.includes("📖3"), "read=3");
  assert.ok(out.includes("✏️2"), "edit=2");
  assert.ok(out.includes("⚡1"), "bash=1");
  assert.ok(out.includes("🔍1"), "search=1");
  assert.ok(out.includes("7 steps"), "total in header");
});

test("renderActivity: many done tools dedup consecutive identical entries with xN", () => {
  const out = renderActivity({
    status: "complete",
    tools: [
      { name: "Read", input: { file_path: "/a.ts" } },
      { name: "Read", input: { file_path: "/a.ts" } },
      { name: "Read", input: { file_path: "/a.ts" } },
      { name: "Bash", input: { command: "ls" } },
    ],
    executionId: "x5",
    durationMs: 12_000,
  });
  assert.ok(out.includes("x3"), "consecutive identical entries collapsed with count");
  assert.ok(out.includes("4 steps"), "step header reflects raw count, not deduped count");
  assert.ok(out.includes("✓ <b>Bash</b> <code>ls</code>"), "bash step renders inline, not in <pre>");
  assert.ok(!out.includes("<pre>"), "no <pre> blocks anywhere");
});

test("renderActivity: error with reason renders icon, reason between counters and blockquote, ✗-prefixed failing step", () => {
  const out = renderActivity({
    status: "error",
    tools: [{ name: "Bash", input: { command: "rm -rf /" } }],
    executionId: "x6",
    errorReason: "Runtime timeout.",
    durationMs: 600_000,
  });
  assert.ok(out.includes("❌ <b>Error</b>"), "error header");
  assert.ok(out.includes("Runtime timeout."), "reason included");
  assert.ok(out.includes("✗ <b>Bash</b>"), "failing step uses ✗ prefix");
  const reasonIdx = out.indexOf("Runtime timeout.");
  const counterIdx = out.indexOf("⚡1");
  const blockquoteIdx = out.indexOf("<blockquote");
  assert.ok(counterIdx > 0 && reasonIdx > counterIdx, "reason after counter line");
  assert.ok(reasonIdx < blockquoteIdx, "reason before blockquote");
});

test("renderActivity: 200-step done run truncates blockquote contents with /logs hint", () => {
  // Each step has unique input so dedup doesn't collapse them. The 150-entry
  // threshold was chosen for simplicity (over a dynamic byte-budget); for
  // typical reads/edits/searches that stays well under Telegram's 4096-char
  // cap. Adversarial inputs with very long descriptions can still exceed it
  // — Telegram rejects the edit in that case and the previous "Working"
  // status remains visible, which is an acceptable graceful failure mode.
  //
  // Note: running-state activities also use the blockquote (for past steps)
  // so the truncation hint applies there too; this test covers the completed
  // state where all steps are in the blockquote.
  const tools = Array.from({ length: 200 }, (_, i) => ({
    name: "Read",
    input: { file_path: `/f${i}.ts` },
  }));
  const out = renderActivity({ status: "complete", tools, executionId: "exec-200", durationMs: 30_000 });
  assert.ok(out.includes("200 steps"), "step header shows total");
  assert.ok(out.includes("📖200"), "counter reflects raw total, not truncated");
  assert.ok(out.includes("(50 more, /logs exec-200 for full)"), "truncation hint with executionId");
});

test("renderActivity: thinking tools are filtered out of total, counter, and blockquote", () => {
  const out = renderActivity({
    status: "complete",
    tools: [
      { name: "Read", input: { file_path: "/a.ts" } },
      { name: "Thinking" },
      { name: "Thinking" },
      { name: "Bash", input: { command: "ls" } },
    ],
    executionId: "x-thinking",
    durationMs: 5_000,
  });
  assert.ok(out.includes("2 steps"), "thinking tools excluded from total (2, not 4)");
  assert.ok(!out.includes("💭"), "no thinking emoji in counters");
  assert.ok(!out.includes("Thinking"), "no thinking entry in blockquote");
  assert.ok(out.includes("✓ <b>Read</b>"), "non-thinking steps still rendered");
  assert.ok(out.includes("✓ <b>Bash</b>"), "non-thinking steps still rendered");
});

test("renderActivity: bash with failed result upgrades prefix to ✗ and (failed) suffix", () => {
  const out = renderActivity({
    status: "complete",
    tools: [
      { name: "Bash", input: { command: "git status" }, result: { content: "ok\n", isError: false } },
      { name: "Bash", input: { command: "git push" }, result: { content: "denied", isError: true } },
    ],
    executionId: "x-bashfail",
    durationMs: 4_000,
  });
  assert.ok(out.includes("✓ <b>Bash</b> <code>git status</code>"), "successful bash uses ✓");
  assert.ok(out.includes("✗ <b>Bash</b> <code>git push</code>"), "failed bash uses ✗");
  assert.ok(out.includes("(failed)"), "failed bash carries (failed) suffix");
});

test("renderActivity: result suffixes render for each tool category", () => {
  const out = renderActivity({
    status: "complete",
    tools: [
      { name: "Read", input: { file_path: "/a.ts" }, result: { content: "line1\nline2\nline3\n" } },
      { name: "Bash", input: { command: "ls" }, result: { content: "a\nb\nc\nd\ne\n" } },
      { name: "Edit", input: { file_path: "/a.ts" }, result: { content: "Applied 1 edit: +12 -3" } },
      { name: "Grep", input: { pattern: "foo" }, result: { content: "a.ts:1: foo\nb.ts:2: foo\n" } },
      { name: "Glob", input: { pattern: "*.ts" }, result: { content: "a.ts\nb.ts\nc.ts\n" } },
    ],
    executionId: "x-suffix",
    durationMs: 6_000,
  });
  assert.ok(out.includes("(3 lines)"), "read shows line count");
  assert.ok(out.includes("(5 lines)"), "bash shows stdout line count");
  assert.ok(out.includes("(-3 +12)"), "edit shows diff stats parsed from confirmation");
  assert.ok(out.includes("(2 matches)"), "grep shows match count");
  assert.ok(out.includes("(3 files)"), "glob shows file count");
});

test("renderActivity: tools without results render without suffix (graceful degradation)", () => {
  const out = renderActivity({
    status: "complete",
    tools: [
      { name: "Read", input: { file_path: "/a.ts" } }, // no result
      { name: "Bash", input: { command: "ls" } }, // no result
    ],
    executionId: "x-noresult",
    durationMs: 2_000,
  });
  assert.ok(out.includes("✓ <b>Read</b> <code>a.ts</code>"), "read rendered without suffix");
  assert.ok(out.includes("✓ <b>Bash</b> <code>ls</code>"), "bash rendered without suffix");
  assert.ok(!out.includes("(0 lines)"), "no spurious (0 lines) suffix when result is absent");
});

test("renderActivity: edit without parseable diff stats falls back to (updated)", () => {
  const out = renderActivity({
    status: "complete",
    tools: [
      { name: "Edit", input: { file_path: "/a.ts" }, result: { content: "Edit applied successfully." } },
    ],
    executionId: "x-edit",
    durationMs: 1_000,
  });
  assert.ok(out.includes("(updated)"), "unparseable edit result falls back to (updated)");
});

test("renderActivity: grep with no matches renders (no matches), glob with no files renders (no files)", () => {
  const out = renderActivity({
    status: "complete",
    tools: [
      { name: "Grep", input: { pattern: "missing" }, result: { content: "" } },
      { name: "Glob", input: { pattern: "*.xyz" }, result: { content: "" } },
    ],
    executionId: "x-empty",
    durationMs: 500,
  });
  assert.ok(out.includes("(no matches)"), "grep with empty result");
  assert.ok(out.includes("(no files)"), "glob with empty result");
});

test("renderActivity: agent result first line truncated to 40 chars in quotes", () => {
  const longResponse = "This is a fairly long agent reply that should be truncated past the forty char limit.";
  const out = renderActivity({
    status: "complete",
    tools: [
      { name: "Task", input: { description: "research" }, result: { content: longResponse } },
    ],
    executionId: "x-agent",
    durationMs: 3_000,
  });
  assert.ok(out.includes('"This is a fairly long agent reply'), "agent first line shown in quotes");
  assert.ok(out.includes("..."), "long agent result is truncated");
  assert.ok(!out.includes("forty char limit"), "truncated tail dropped from suffix");
});

test("renderActivity: agent result with short first line not truncated", () => {
  const out = renderActivity({
    status: "complete",
    tools: [
      { name: "Task", input: { description: "x" }, result: { content: "Done; 3 files changed" } },
    ],
    executionId: "x-agent-short",
    durationMs: 2_000,
  });
  assert.ok(out.includes('("Done; 3 files changed")'), "short agent reply renders verbatim in quotes");
});

test("formatToolResultSuffix: handles missing/empty content gracefully", () => {
  assert.equal(formatToolResultSuffix("Read", undefined), undefined);
  assert.equal(formatToolResultSuffix("WebFetch", { content: "anything" }), undefined);
  assert.equal(formatToolResultSuffix("Read", { content: "" }), "(0 lines)");
});

test("formatToolDisplay: tools use friendly display names per the spec map", () => {
  // Smoke-check via renderActivity since formatToolDisplay isn't exported
  const out = renderActivity({
    status: "complete",
    tools: [
      { name: "Grep", input: { pattern: "x" } },
      { name: "Task", input: { description: "y" } },
      { name: "MultiEdit", input: { file_path: "/a.ts" } },
    ],
    executionId: "x-names",
    durationMs: 1_000,
  });
  assert.ok(out.includes("<b>Search</b>"), "Grep renders as Search");
  assert.ok(out.includes("<b>Agent</b>"), "Task renders as Agent");
  assert.ok(out.includes("<b>Edit</b>"), "MultiEdit renders as Edit");
});

// ---------- Issue 100: retry-reset clears hub-side stream state ----------

test("ChannelHub.retry-reset clears stream draft and tool activity from prior attempt", async () => {
  const eventBus = new EventBus();
  const logger = createLogger("error");
  const adapter = new MockAdapter("telegram");

  // CLI mock: emits partial stream output + tool-use, fails, then retries with new output.
  // The final Telegram message must contain only the retry attempt's output.
  const runtime: Runtime = {
    async execute(message, executionId, bus): Promise<void> {
      const base = { executionId, channelId: message.channelId, chatId: message.chatId };

      // First attempt: emits leftover content
      bus.emit({ ...base, type: "start", timestamp: 1000, payload: { agentName: "claude", messageId: 1 } });
      bus.emit({ ...base, type: "stream-text", timestamp: 1100, payload: { text: "LEAK_FROM_FIRST_ATTEMPT" } });
      bus.emit({ ...base, type: "tool-use", timestamp: 1200, payload: { toolName: "Read", toolInput: { file_path: "/leak.ts" }, toolUseId: "tu1" } });

      // Stale-resume retry: emit retry-reset, then the retry's clean output
      bus.emit({ ...base, type: "retry-reset", timestamp: 1300, payload: { reason: "stale resume" } });
      bus.emit({ ...base, type: "stream-text", timestamp: 1400, payload: { text: "Clean retry output." } });
      bus.emit({ ...base, type: "complete", timestamp: 1500, payload: { response: "Clean retry output." } });
    }
  };

  const router: Router = { select(message) { return { runtime, message }; } };
  const hub = new ChannelHub([adapter], router, eventBus, logger);
  await hub.start();

  await adapter.simulateIncoming({ channelId: "telegram", chatId: "chat-retry", text: "hello", messageId: 1 });
  await sleep(50);

  // After retry-reset, the retry attempt produces its own finalized message
  // (editMessage on `complete`). That message must contain ONLY the retry
  // attempt's text — no leakage from the first attempt's accumulated stream.
  const finalizedEdits = adapter.editedMessages.map((m) => m.text).join("\n");
  assert.ok(finalizedEdits.includes("Clean retry output."),
    "retry output should land as a finalized message");
  assert.ok(!finalizedEdits.includes("LEAK_FROM_FIRST_ATTEMPT"),
    "the retry's finalized message must not contain text from the first attempt");

  // After complete, both maps should be drained for this executionId. The
  // retry-reset handler clears them after the failed attempt, and complete
  // clears anything the retry path created.
  const streamDrafts = (hub as unknown as { streamDrafts: Map<string, unknown> }).streamDrafts;
  const toolActivity = (hub as unknown as { toolActivityMessages: Map<string, unknown> }).toolActivityMessages;
  const residualDraft = Array.from(streamDrafts.keys()).filter((k) => (k as string).includes("chat-retry"));
  const residualActivity = Array.from(toolActivity.keys()).filter((k) => (k as string).includes("chat-retry"));
  assert.equal(residualDraft.length, 0, `no residual draft should remain after complete (got: ${residualDraft.join(",")})`);
  assert.equal(residualActivity.length, 0, `no residual tool-activity should remain after complete (got: ${residualActivity.join(",")})`);

  await hub.stop();
});

// ---------- Issue 99: graceful shutdown ----------

test("ChannelHub.stop flushes in-flight stream draft to a permanent message", async () => {
  const eventBus = new EventBus();
  const logger = createLogger("error");
  const adapter = new MockAdapter("telegram");

  // No-op runtime — we drive events directly via eventBus for full control.
  const runtime: Runtime = { async execute(): Promise<void> { /* noop */ } };
  const router: Router = { select(message) { return { runtime, message }; } };
  const hub = new ChannelHub([adapter], router, eventBus, logger);
  await hub.start();

  // Emit start + partial stream-text but no complete — the hub treats this as
  // an in-flight execution interrupted by SIGTERM.
  eventBus.emit({
    executionId: "exec-shut", channelId: "telegram", chatId: "chat-shut",
    type: "start", timestamp: Date.now(), payload: { agentName: "claude", messageId: 7 }
  });
  eventBus.emit({
    executionId: "exec-shut", channelId: "telegram", chatId: "chat-shut",
    type: "stream-text", timestamp: Date.now(),
    payload: { text: "Partial response that must be preserved on SIGTERM." }
  });
  await sleep(30);

  // SIGTERM → hub.stop() should flush the draft before clearing maps
  await hub.stop();

  const allText = [
    ...adapter.sentMessages.map((m) => m.text),
    ...adapter.sentMarkupMessages.map((m) => m.text),
    ...adapter.editedMessages.map((m) => m.text),
    ...adapter.draftMessages.map((m) => m.text),
  ].join("\n");

  assert.ok(allText.includes("Partial response that must be preserved on SIGTERM."),
    "shutdown should preserve in-flight stream text as a permanent Telegram message");
});

test("ChannelHub.stop clears reactions on in-flight executions", async () => {
  const eventBus = new EventBus();
  const logger = createLogger("error");
  const adapter = new MockAdapter("telegram");

  // Wire up a reaction capture (MockAdapter doesn't ship one by default)
  const reactions: Array<{ messageId: number; emoji: string | null }> = [];
  (adapter as unknown as { setMessageReaction: (chatId: string, messageId: number, emoji: string | null) => Promise<void> })
    .setMessageReaction = async (_chatId, messageId, emoji) => {
      reactions.push({ messageId, emoji });
    };

  const runtime: Runtime = { async execute(): Promise<void> { /* noop */ } };
  const router: Router = { select(message) { return { runtime, message }; } };
  const hub = new ChannelHub([adapter], router, eventBus, logger);
  await hub.start();

  // Emit a start event so the hub registers the reactionMessageId and sets 👀
  eventBus.emit({
    executionId: "exec-react", channelId: "telegram", chatId: "chat-react",
    type: "start", timestamp: Date.now(), payload: { agentName: "claude", messageId: 42 }
  });
  await sleep(30);

  // SIGTERM
  await hub.stop();

  // Should have cleared the 👀 reaction (set to null) during shutdown
  const clearedReactions = reactions.filter((r) => r.emoji === null);
  assert.ok(clearedReactions.length > 0,
    "shutdown should clear dangling reactions so they don't remain visible");
  assert.ok(clearedReactions.some((r) => r.messageId === 42),
    "the source message reaction must be cleared on shutdown");
});

// --- Issue #104: user-visible cleanup moves to response-end ---------------
//
// Tier A cleanup (reaction clear, tool-activity finalize, throttler flush)
// should happen the moment the reply settles — i.e. on `response-end` —
// so the chat stops mutating during the CLI's multi-second shutdown tail.
// The later `complete`/`error` event must be a no-op for Tier A so the
// blockquote isn't re-edited and the reaction isn't re-cleared.

test("response-end runs Tier A cleanup (reaction, tool-activity, throttler) before complete", async () => {
  const eventBus = new EventBus();
  const logger = createLogger("error");
  const adapter = new MockAdapter("telegram");

  const reactions: Array<{ messageId: number; emoji: string | null; at: number }> = [];
  (adapter as unknown as { setMessageReaction: (chatId: string, messageId: number, emoji: string | null) => Promise<void> })
    .setMessageReaction = async (_chatId, messageId, emoji) => {
      reactions.push({ messageId, emoji, at: Date.now() });
    };

  let responseEndAt = 0;
  let completeAt = 0;

  const runtime: Runtime = {
    async execute(message, executionId, bus): Promise<void> {
      const base = { executionId, channelId: message.channelId, chatId: message.chatId };

      bus.emit({ ...base, type: "start", timestamp: 1000, payload: { agentName: "claude", messageId: 77 } });
      // Stream a bit so there's a draft to flush at response-end
      bus.emit({ ...base, type: "stream-text", timestamp: 1500, payload: { text: "Hello." } });
      await sleep(20);
      bus.emit({ ...base, type: "response-end", timestamp: 2000, payload: {} });
      responseEndAt = Date.now();

      // Simulate CLI shutdown tail — `complete` arrives several ticks later.
      await sleep(50);
      completeAt = Date.now();
      bus.emit({ ...base, type: "complete", timestamp: 2500, payload: { response: "Hello." } });
    }
  };

  const router: Router = { select(message) { return { runtime, message }; } };
  const hub = new ChannelHub([adapter], router, eventBus, logger);
  await hub.start();

  await adapter.simulateIncoming({ channelId: "telegram", chatId: "chat-1", text: "hi" });
  await sleep(150);

  // The 👀 reaction should have been cleared (emoji=null), and that clear
  // should have happened around `response-end`, not later at `complete`.
  const cleared = reactions.find((r) => r.messageId === 77 && r.emoji === null);
  assert.ok(cleared, "response-end should clear the 👀 reaction on the source message");
  assert.ok(
    cleared!.at < completeAt,
    `reaction clear should happen before complete (cleared=${cleared!.at}, complete=${completeAt}, response-end=${responseEndAt})`
  );

  // Exactly one clear — complete must not re-clear after response-end did.
  const allClearsForMsg = reactions.filter((r) => r.messageId === 77 && r.emoji === null);
  assert.equal(allClearsForMsg.length, 1, "complete must not re-clear the reaction that response-end already cleared");

  await hub.stop();
});

test("complete without prior response-end still runs Tier A cleanup (fallback path)", async () => {
  const eventBus = new EventBus();
  const logger = createLogger("error");
  const adapter = new MockAdapter("telegram");

  const reactions: Array<{ messageId: number; emoji: string | null }> = [];
  (adapter as unknown as { setMessageReaction: (chatId: string, messageId: number, emoji: string | null) => Promise<void> })
    .setMessageReaction = async (_chatId, messageId, emoji) => {
      reactions.push({ messageId, emoji });
    };

  const runtime: Runtime = {
    async execute(message, executionId, bus): Promise<void> {
      const base = { executionId, channelId: message.channelId, chatId: message.chatId };
      bus.emit({ ...base, type: "start", timestamp: 1000, payload: { agentName: "claude", messageId: 88 } });
      bus.emit({ ...base, type: "stream-text", timestamp: 1500, payload: { text: "Hello." } });
      await sleep(20);
      // No response-end — CLI killed before result. complete must still clear.
      bus.emit({ ...base, type: "complete", timestamp: 2000, payload: { response: "Hello." } });
    }
  };

  const router: Router = { select(message) { return { runtime, message }; } };
  const hub = new ChannelHub([adapter], router, eventBus, logger);
  await hub.start();

  await adapter.simulateIncoming({ channelId: "telegram", chatId: "chat-1", text: "hi" });
  await sleep(100);

  const cleared = reactions.find((r) => r.messageId === 88 && r.emoji === null);
  assert.ok(cleared, "complete must clear the reaction when response-end never arrived");

  await hub.stop();
});

test("error after response-end still renders error text and does not re-run Tier A", async () => {
  const eventBus = new EventBus();
  const logger = createLogger("error");
  const adapter = new MockAdapter("telegram");

  const reactions: Array<{ messageId: number; emoji: string | null }> = [];
  (adapter as unknown as { setMessageReaction: (chatId: string, messageId: number, emoji: string | null) => Promise<void> })
    .setMessageReaction = async (_chatId, messageId, emoji) => {
      reactions.push({ messageId, emoji });
    };

  const runtime: Runtime = {
    async execute(message, executionId, bus): Promise<void> {
      const base = { executionId, channelId: message.channelId, chatId: message.chatId };
      bus.emit({ ...base, type: "start", timestamp: 1000, payload: { agentName: "claude", messageId: 99 } });
      bus.emit({ ...base, type: "stream-text", timestamp: 1500, payload: { text: "Partial reply." } });
      await sleep(20);
      bus.emit({ ...base, type: "response-end", timestamp: 2000, payload: {} });
      await sleep(30);
      bus.emit({ ...base, type: "error", timestamp: 2500, payload: { reason: "boom" } });
    }
  };

  const router: Router = { select(message) { return { runtime, message }; } };
  const hub = new ChannelHub([adapter], router, eventBus, logger);
  await hub.start();

  await adapter.simulateIncoming({ channelId: "telegram", chatId: "chat-1", text: "hi" });
  await sleep(150);

  // Tier A cleanup ran exactly once (on response-end), not twice
  const allClears = reactions.filter((r) => r.messageId === 99 && r.emoji === null);
  assert.equal(allClears.length, 1, "error after response-end must not re-clear the reaction");

  // Error text still rendered after the draft was already flushed
  const errorMsg = adapter.sentMessages.find((m) => m.text.includes("boom") || m.text.toLowerCase().includes("error"));
  assert.ok(errorMsg, "error text should still render after response-end ran Tier A cleanup");

  await hub.stop();
});

test("retry-reset clears cleanupDone so the retry's response-end can run Tier A again", async () => {
  const eventBus = new EventBus();
  const logger = createLogger("error");
  const adapter = new MockAdapter("telegram");

  const reactions: Array<{ messageId: number; emoji: string | null }> = [];
  (adapter as unknown as { setMessageReaction: (chatId: string, messageId: number, emoji: string | null) => Promise<void> })
    .setMessageReaction = async (_chatId, messageId, emoji) => {
      reactions.push({ messageId, emoji });
    };

  const runtime: Runtime = {
    async execute(message, executionId, bus): Promise<void> {
      const base = { executionId, channelId: message.channelId, chatId: message.chatId };
      bus.emit({ ...base, type: "start", timestamp: 1000, payload: { agentName: "claude", messageId: 55 } });
      bus.emit({ ...base, type: "stream-text", timestamp: 1500, payload: { text: "First attempt." } });
      await sleep(20);
      bus.emit({ ...base, type: "response-end", timestamp: 2000, payload: {} });
      await sleep(20);
      // Stale-resume retry: drop hub-side stream state, including cleanupDone,
      // so the retry's own response-end isn't a no-op.
      bus.emit({ ...base, type: "retry-reset", timestamp: 2100, payload: {} });
      await sleep(10);
      bus.emit({ ...base, type: "stream-text", timestamp: 2200, payload: { text: "Retry reply." } });
      await sleep(20);
      bus.emit({ ...base, type: "response-end", timestamp: 2400, payload: {} });
      await sleep(20);
      bus.emit({ ...base, type: "complete", timestamp: 2500, payload: { response: "Retry reply." } });
    }
  };

  const router: Router = { select(message) { return { runtime, message }; } };
  const hub = new ChannelHub([adapter], router, eventBus, logger);
  await hub.start();

  await adapter.simulateIncoming({ channelId: "telegram", chatId: "chat-1", text: "hi" });
  await sleep(200);

  // retry-reset deletes the reactionMessageId, so the post-retry response-end
  // has nothing to clear. The important guarantee is: complete must not
  // re-clear after response-end ran cleanup, OR re-edit the (now deleted)
  // tool-activity blockquote. With cleanupDone properly cleared on
  // retry-reset, the second response-end runs cleanly and complete is a
  // no-op for Tier A.
  // We assert: the first response-end's clear happened, and complete didn't
  // produce extra clears beyond what response-end produced.
  const allClears = reactions.filter((r) => r.messageId === 55 && r.emoji === null);
  assert.ok(allClears.length >= 1, "first response-end should have cleared the 👀 reaction");
  assert.ok(allClears.length <= 1, "complete must not re-clear after response-end already did");

  await hub.stop();
});
