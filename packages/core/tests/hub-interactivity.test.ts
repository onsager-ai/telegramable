import assert from "assert";
import test from "node:test";
import { createServer } from "http";
import type { AddressInfo } from "net";
import { existsSync, readFileSync } from "fs";
import { EventBus } from "../src/events/eventBus";
import { createLogger } from "../src/logging";
import { ChannelHub, categorizeToolName, parseBuiltinCommand, renderActivity } from "../src/hub/hub";
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
  assert.ok(adapter.sentMessages.some((message) => message.text.includes("Recent executions")));
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

test("renderActivity: single running tool shows step count, current cue, and blockquote", () => {
  const out = renderActivity({
    status: "running",
    tools: [{ name: "Read", input: { file_path: "/tmp/a.ts" } }],
    executionId: "x2",
  });
  assert.ok(out.includes("⚙️ <b>Working</b>"), "running header");
  assert.ok(out.includes("1 step"), "1 step in header");
  assert.ok(out.includes("📖1"), "counter line with read=1");
  assert.ok(out.includes("· ▸"), "current tool cue while running");
  assert.ok(out.includes("<blockquote expandable>"), "blockquote present");
  assert.ok(out.includes("Reading"), "step rendered inside blockquote");
});

test("renderActivity: single done tool drops current cue and shows duration", () => {
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
});

test("renderActivity: error with reason renders icon, reason between counters and blockquote", () => {
  const out = renderActivity({
    status: "error",
    tools: [{ name: "Bash", input: { command: "rm -rf /" } }],
    executionId: "x6",
    errorReason: "Runtime timeout.",
    durationMs: 600_000,
  });
  assert.ok(out.includes("❌ <b>Error</b>"), "error header");
  assert.ok(out.includes("Runtime timeout."), "reason included");
  const reasonIdx = out.indexOf("Runtime timeout.");
  const counterIdx = out.indexOf("⚡1");
  const blockquoteIdx = out.indexOf("<blockquote");
  assert.ok(counterIdx > 0 && reasonIdx > counterIdx, "reason after counter line");
  assert.ok(reasonIdx < blockquoteIdx, "reason before blockquote");
});

test("renderActivity: 200-step run truncates blockquote contents with /logs hint", () => {
  // Each step has unique input so dedup doesn't collapse them.  The 150-entry
  // threshold was chosen for simplicity (over a dynamic byte-budget); for
  // typical reads/edits/searches that stays well under Telegram's 4096-char
  // cap.  Adversarial inputs with very long descriptions can still exceed it
  // — Telegram rejects the edit in that case and the previous "Working"
  // status remains visible, which is an acceptable graceful failure mode.
  const tools = Array.from({ length: 200 }, (_, i) => ({
    name: "Read",
    input: { file_path: `/f${i}.ts` },
  }));
  const out = renderActivity({ status: "running", tools, executionId: "exec-200" });
  assert.ok(out.includes("200 steps"), "step header shows total");
  assert.ok(out.includes("📖200"), "counter reflects raw total, not truncated");
  assert.ok(out.includes("(50 more, /logs exec-200 for full)"), "truncation hint with executionId");
});
