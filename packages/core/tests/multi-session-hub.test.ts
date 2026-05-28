import assert from "assert";
import test from "node:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { EventBus } from "../src/events/eventBus";
import { createLogger } from "../src/logging";
import { ChannelHub, parseBuiltinCommand } from "../src/hub/hub";
import { Router } from "../src/hub/router";
import { Runtime } from "../src/runtime/types";
import { FileSessionStore } from "../src/runtime/session/fileSessionStore";
import { SessionStore, UNTITLED } from "../src/runtime/session/sessionStore";
import { FileUsageStore } from "../src/runtime/usageStore";
import { MockAdapter } from "./mockAdapter";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const withTempDir = async (fn: (dir: string) => Promise<void>): Promise<void> => {
  const dir = mkdtempSync(join(tmpdir(), "tg-multi-session-"));
  try { await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};

/** Wraps a test in `withTempDir` + builds a hub that's auto-stopped after the test. */
const withHub = (fn: (ctx: BuildResult) => Promise<void>, opts?: BuildOptions): () => Promise<void> => {
  return async () => {
    await withTempDir(async (dir) => {
      const ctx = buildHub(dir, opts);
      await ctx.hub.start();
      try {
        await fn(ctx);
      } finally {
        await ctx.hub.stop();
      }
    });
  };
};

interface BuildResult {
  hub: ChannelHub;
  adapter: MockAdapter;
  sessionStore: SessionStore;
  usageStore?: FileUsageStore;
  eventBus: EventBus;
  executeCalls: number;
}

interface BuildOptions {
  agentName?: string;
  withUsageStore?: boolean;
}

function buildHub(dir: string, opts: BuildOptions = {}): BuildResult {
  const agentName = opts.agentName ?? "claude";
  const adapter = new MockAdapter("telegram");
  const eventBus = new EventBus();
  const logger = createLogger("error");

  const fileStore = new FileSessionStore(dir, `${agentName}-sessions.json`, logger);
  const sessionStore = new SessionStore(fileStore);
  const usageStore = opts.withUsageStore ? new FileUsageStore(dir, "usage.json", logger) : undefined;

  const state = { executeCalls: 0 };

  const runtime: Runtime = {
    agentName,
    sessionStore,
    async execute(_message, executionId, bus) {
      state.executeCalls += 1;
      bus.emit({
        executionId,
        channelId: _message.channelId,
        chatId: _message.chatId,
        type: "complete",
        timestamp: Date.now(),
        payload: { response: "ok" },
      });
    },
  };

  const router: Router = {
    select(message) {
      return { runtime, message };
    },
  };

  const hub = new ChannelHub(
    [adapter],
    router,
    eventBus,
    logger,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    usageStore,
  );

  return Object.assign(state, { hub, adapter, sessionStore, usageStore, eventBus });
}

// --- parser ---

test("parseBuiltinCommand parses /new, /sessions, /stop, /usage, /rename", () => {
  assert.deepEqual(parseBuiltinCommand("/new"), { type: "new" });
  assert.deepEqual(parseBuiltinCommand(" /sessions  "), { type: "sessions" });
  assert.deepEqual(parseBuiltinCommand("/STOP"), { type: "stop" });
  assert.deepEqual(parseBuiltinCommand("/usage"), { type: "usage" });
  assert.deepEqual(parseBuiltinCommand("/rename Weekend trip"), { type: "rename", title: "Weekend trip" });
  assert.deepEqual(parseBuiltinCommand("/RENAME  multi word title  "), { type: "rename", title: "multi word title" });
  assert.equal(parseBuiltinCommand("/rename"), null); // no title → not a valid rename
});

// --- lazy session creation + title backfill ---

test("first user message lazily creates an active session with title from message", withHub(async ({ adapter, sessionStore }) => {
  await adapter.simulateIncoming({ channelId: "telegram", chatId: "chat-1", text: "Plan the weekend trip to Lisbon" });
  await sleep(30);

  const active = sessionStore.getActiveSession("telegram::chat-1::claude");
  assert.ok(active, "first message should create an active session");
  assert.equal(active?.meta.title, "Plan the weekend trip to Lisbon");
}));

test("title backfill truncates long first messages to 40 chars + ellipsis", withHub(async ({ adapter, sessionStore }) => {
  const longMsg = "This is an extremely long opening message that should not become a long title for the session";
  await adapter.simulateIncoming({ channelId: "telegram", chatId: "chat-1", text: longMsg });
  await sleep(30);

  const active = sessionStore.getActiveSession("telegram::chat-1::claude");
  assert.ok(active);
  assert.equal(active!.meta.title.length, 41); // 40 chars + ellipsis
  assert.ok(active!.meta.title.endsWith("…"));
}));

// --- /new ---

test("/new creates a fresh session and switches active; previous one retained", withHub(async ({ adapter, sessionStore }) => {
  await adapter.simulateIncoming({ channelId: "telegram", chatId: "chat-1", text: "first conversation" });
  await sleep(30);
  const firstActive = sessionStore.getActiveSession("telegram::chat-1::claude")!;

  await adapter.simulateIncoming({ channelId: "telegram", chatId: "chat-1", text: "/new" });
  await sleep(30);

  const secondActive = sessionStore.getActiveSession("telegram::chat-1::claude")!;
  assert.notEqual(secondActive.sessionId, firstActive.sessionId, "active id should change");
  assert.equal(secondActive.meta.title, UNTITLED);

  const list = sessionStore.listSessions("telegram::chat-1::claude");
  assert.equal(list.length, 2, "both sessions retained");
  assert.ok(adapter.sentMessages.some((m) => m.text.includes("Started a new session")));
}));

// --- /sessions ---

test("/sessions on empty store shows 'No sessions yet'", withHub(async ({ adapter }) => {
  await adapter.simulateIncoming({ channelId: "telegram", chatId: "chat-1", text: "/sessions" });
  await sleep(30);

  const all = [...adapter.sentMessages, ...adapter.sentMarkupMessages].map((m) => m.text);
  assert.ok(all.some((t) => t.includes("No sessions yet")));
}));

test("/sessions lists sessions with Switch buttons for non-active rows", withHub(async ({ adapter, sessionStore }) => {
  await adapter.simulateIncoming({ channelId: "telegram", chatId: "chat-1", text: "alpha" });
  await sleep(30);
  await adapter.simulateIncoming({ channelId: "telegram", chatId: "chat-1", text: "/new" });
  await sleep(30);
  await adapter.simulateIncoming({ channelId: "telegram", chatId: "chat-1", text: "beta" });
  await sleep(30);

  const list = sessionStore.listSessions("telegram::chat-1::claude");
  assert.equal(list.length, 2);

  adapter.sentMarkupMessages.length = 0;
  adapter.sentMessages.length = 0;
  await adapter.simulateIncoming({ channelId: "telegram", chatId: "chat-1", text: "/sessions" });
  await sleep(30);

  assert.equal(adapter.sentMarkupMessages.length, 1, "should use markup adapter path");
  const msg = adapter.sentMarkupMessages[0];
  assert.ok(msg.text.includes("→ <b>beta</b>"), "second session is active");
  const buttons = (msg.markup as { inline_keyboard: Array<Array<{ callback_data: string }>> })
    .inline_keyboard.flat();
  // 1 Switch button (for the non-active alpha) + Rename + New control buttons.
  assert.equal(buttons.length, 3);
  assert.ok(buttons.some((b) => b.callback_data.startsWith("sess:switch:")));
  assert.ok(buttons.some((b) => b.callback_data.startsWith("sess:rename:")));
  assert.ok(buttons.some((b) => b.callback_data === "sess:new"));
}));

test("/list is a deprecated alias that prepends a deprecation hint", withHub(async ({ adapter }) => {
  await adapter.simulateIncoming({ channelId: "telegram", chatId: "chat-1", text: "/list" });
  await sleep(30);

  const all = [...adapter.sentMessages, ...adapter.sentMarkupMessages].map((m) => m.text);
  assert.ok(all.some((t) => t.includes("/list is deprecated")));
}));

// --- /start no-op ---

test("/start is a silent no-op (no message sent)", withHub(async ({ adapter }) => {
  await adapter.simulateIncoming({ channelId: "telegram", chatId: "chat-1", text: "/start" });
  await sleep(30);

  assert.equal(adapter.sentMessages.length, 0);
  assert.equal(adapter.sentMarkupMessages.length, 0);
}));

// --- Switch callback ---

test("sess:switch:<id> callback switches active session and acknowledges", withHub(async ({ adapter, sessionStore }) => {
  await adapter.simulateIncoming({ channelId: "telegram", chatId: "chat-1", text: "first" });
  await sleep(30);
  const firstId = sessionStore.getActiveSession("telegram::chat-1::claude")!.sessionId;
  await adapter.simulateIncoming({ channelId: "telegram", chatId: "chat-1", text: "/new" });
  await sleep(30);
  const secondId = sessionStore.getActiveSession("telegram::chat-1::claude")!.sessionId;
  assert.notEqual(firstId, secondId);

  await adapter.simulateCallback("chat-1", `sess:switch:${firstId}`, 99);
  await sleep(30);

  assert.equal(sessionStore.getActiveSession("telegram::chat-1::claude")!.sessionId, firstId);
  assert.ok(adapter.answeredCallbacks.length > 0);
  assert.ok(adapter.sentMessages.some((m) => m.text.startsWith("Switched to:")));
}));

test("sess:switch:<id> on a broken session shows 'Session unavailable.'", withHub(async ({ adapter, sessionStore }) => {
  await adapter.simulateIncoming({ channelId: "telegram", chatId: "chat-1", text: "first" });
  await sleep(30);
  const firstId = sessionStore.getActiveSession("telegram::chat-1::claude")!.sessionId;
  await adapter.simulateIncoming({ channelId: "telegram", chatId: "chat-1", text: "/new" });
  await sleep(30);
  sessionStore.markBroken("telegram::chat-1::claude", firstId);

  await adapter.simulateCallback("chat-1", `sess:switch:${firstId}`, 99);
  await sleep(30);

  assert.ok(adapter.answeredCallbacks.some((c) => c.text === "Session unavailable."));
  assert.notEqual(sessionStore.getActiveSession("telegram::chat-1::claude")!.sessionId, firstId);
}));

// --- /rename + rename callback ---

test("/rename retitles the active session and confirms in chat", withHub(async ({ adapter, sessionStore }) => {
  await adapter.simulateIncoming({ channelId: "telegram", chatId: "chat-1", text: "hello there" });
  await sleep(30);
  const before = sessionStore.getActiveSession("telegram::chat-1::claude")!;
  assert.equal(before.meta.title, "hello there");

  await adapter.simulateIncoming({ channelId: "telegram", chatId: "chat-1", text: "/rename Weekend planning" });
  await sleep(30);

  const after = sessionStore.getActiveSession("telegram::chat-1::claude")!;
  assert.equal(after.sessionId, before.sessionId, "rename preserves the active session id");
  assert.equal(after.meta.title, "Weekend planning");
  assert.ok(adapter.sentMessages.some((m) => m.text.includes("Renamed to:")));
}));

test("/rename without an active session tells the user to start one first", withHub(async ({ adapter }) => {
  await adapter.simulateIncoming({ channelId: "telegram", chatId: "chat-1", text: "/rename Something" });
  await sleep(30);
  assert.ok(adapter.sentMessages.some((m) => m.text.includes("No active session to rename")));
}));

test("sess:new callback creates a fresh session and refreshes the list message", withHub(async ({ adapter, sessionStore }) => {
  await adapter.simulateIncoming({ channelId: "telegram", chatId: "chat-1", text: "first" });
  await sleep(30);
  const firstId = sessionStore.getActiveSession("telegram::chat-1::claude")!.sessionId;

  await adapter.simulateCallback("chat-1", "sess:new", 100);
  await sleep(30);

  const newActive = sessionStore.getActiveSession("telegram::chat-1::claude")!;
  assert.notEqual(newActive.sessionId, firstId, "+ New button should switch active to a fresh session");
  assert.equal(newActive.meta.title, UNTITLED);
  assert.ok(adapter.answeredCallbacks.some((c) => c.text === "Started a new session."));
}));

test("sess:rename callback acks with the command hint when the row is active", withHub(async ({ adapter, sessionStore }) => {
  await adapter.simulateIncoming({ channelId: "telegram", chatId: "chat-1", text: "hello" });
  await sleep(30);
  const activeId = sessionStore.getActiveSession("telegram::chat-1::claude")!.sessionId;

  await adapter.simulateCallback("chat-1", `sess:rename:${activeId}`, 101);
  await sleep(30);

  assert.ok(adapter.answeredCallbacks.some((c) => c.text?.includes("/rename")));
  assert.ok(adapter.sentMessages.some((m) => m.text.includes("/rename")));
}));

// --- /usage and /stop stubs ---

test("/usage without a UsageStore reports unavailable and points at DATA_DIR", withHub(async ({ adapter }) => {
  // buildHub() does not pass a usageStore, so /usage falls into the "not available" branch.
  await adapter.simulateIncoming({ channelId: "telegram", chatId: "chat-1", text: "/usage" });
  await sleep(30);
  const found = adapter.sentMessages.some((m) => m.text.includes("DATA_DIR"));
  assert.ok(found, "should hint at DATA_DIR when no UsageStore is wired");
}));

test(
  "/usage reports today + month totals when a runtime emits usage events",
  withHub(
    async ({ adapter, eventBus }) => {
      // Inject two usage events through the bus the way ClaudeSession would.
      const emit = (input: number, output: number, cache: number, cost: number) => {
        eventBus.emit({
          executionId: `exec-${input}`,
          channelId: "telegram",
          chatId: "chat-1",
          type: "usage",
          timestamp: Date.now(),
          payload: { agentName: "claude", usage: { inputTokens: input, outputTokens: output, cacheTokens: cache, costUsd: cost } },
        });
      };
      emit(1200, 800, 500, 0.012);
      emit(300, 200, 0, 0.003);
      await sleep(20);

      await adapter.simulateIncoming({ channelId: "telegram", chatId: "chat-1", text: "/usage" });
      await sleep(30);

      const reply = adapter.sentMessages[adapter.sentMessages.length - 1]?.text || "";
      assert.ok(reply.includes("📊 <b>Usage</b>"), "should render the Usage header");
      // 1500 in + 1000 out + 500 cache = 3000 tokens → "3.0k tokens"; cost 0.015 → "$0.015".
      assert.ok(reply.includes("3.0k tokens"), `expected totals in reply, got: ${reply}`);
      assert.ok(reply.includes("$0.015"), `expected cost in reply, got: ${reply}`);
    },
    { withUsageStore: true },
  ),
);

test("/stop replies with cancellation-not-wired hint linking the follow-up", withHub(async ({ adapter }) => {
  await adapter.simulateIncoming({ channelId: "telegram", chatId: "chat-1", text: "/stop" });
  await sleep(30);
  assert.ok(adapter.sentMessages.some((m) => m.text.includes("Cancellation not yet wired")));
  assert.ok(adapter.sentMessages.some((m) => m.text.includes("#108")));
}));

// --- /help refresh ---

test("/help advertises the new multi-session commands", withHub(async ({ adapter }) => {
  await adapter.simulateIncoming({ channelId: "telegram", chatId: "chat-1", text: "/help" });
  await sleep(30);
  const text = adapter.sentMessages[adapter.sentMessages.length - 1]?.text || "";
  assert.ok(text.includes("/new"));
  assert.ok(text.includes("/sessions"));
  assert.ok(text.includes("/stop"));
  assert.ok(text.includes("/usage"));
}));
