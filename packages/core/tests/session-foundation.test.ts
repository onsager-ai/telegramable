import assert from "assert";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import test from "node:test";
import { AgentConfig } from "../src/config";
import { EventBus } from "../src/events/eventBus";
import { createLogger } from "../src/logging";
import { CliRuntime } from "../src/runtime/cliRuntime";
import { createRuntime } from "../src/runtime";
import { FileSessionStore } from "../src/runtime/session/fileSessionStore";
import { InMemorySessionManager } from "../src/runtime/session/inMemorySessionManager";
import { SessionRuntime } from "../src/runtime/session/sessionRuntime";
import { SessionStore } from "../src/runtime/session/sessionStore";
import { AgentSession } from "../src/runtime/session/types";

class FakeSession implements AgentSession {
  closed = false;
  private restoredResumeId?: string;

  constructor(
    readonly sessionId: string,
    readonly channelId: string,
    readonly chatId: string,
    private readonly response: string = "ok"
  ) { }

  setResumeId(id: string): void {
    this.restoredResumeId = id;
  }

  get resumeId(): string | undefined {
    return this.restoredResumeId;
  }

  get wasRestoredFromDisk(): boolean {
    return this.restoredResumeId !== undefined;
  }

  async send(): Promise<string> {
    return this.response;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

test("InMemorySessionManager reuses session for same channel/chat/agent", () => {
  const logger = createLogger("error");
  let created = 0;
  const manager = new InMemorySessionManager({
    logger,
    sessionTimeoutMs: 1_000,
    createSession: (channelId, chatId, agentName) => {
      created += 1;
      return new FakeSession(`${agentName}-${created}`, channelId, chatId);
    }
  });

  const first = manager.getOrCreate("telegram", "chat-1", "claude");
  const second = manager.getOrCreate("telegram", "chat-1", "claude");

  assert.equal(created, 1);
  assert.strictEqual(first, second);
});

test("InMemorySessionManager evicts idle sessions after TTL", async () => {
  const logger = createLogger("error");
  let now = 0;
  let created = 0;
  const sessions: FakeSession[] = [];

  const manager = new InMemorySessionManager({
    logger,
    sessionTimeoutMs: 10,
    now: () => now,
    createSession: (channelId, chatId, agentName) => {
      created += 1;
      const session = new FakeSession(`${agentName}-${created}`, channelId, chatId);
      sessions.push(session);
      return session;
    }
  });

  const first = manager.getOrCreate("telegram", "chat-1", "claude");
  now = 11;
  const second = manager.getOrCreate("telegram", "chat-1", "claude");

  assert.notStrictEqual(first, second);
  assert.equal(created, 2);
  assert.equal(sessions[0]?.closed, true);

  await manager.closeAll();
});

test("SessionRuntime emits aggregated complete response", async () => {
  const logger = createLogger("error");
  const events: Array<{ type: string; response?: string; agentName?: string }> = [];
  const eventBus = new EventBus();
  const session = new FakeSession("s-1", "telegram", "chat-1", "aggregated response");

  const manager = {
    getOrCreate: () => session,
    close: async () => { },
    closeAll: async () => { }
  };

  const runtime = new SessionRuntime({
    name: "claude",
    runtime: "session-claude",
    command: "claude"
  }, manager, logger);

  eventBus.on((event) => {
    events.push({
      type: event.type,
      response: event.payload?.response,
      agentName: event.payload?.agentName
    });
  });

  await runtime.execute({ channelId: "telegram", chatId: "chat-1", text: "hello" }, "exec-1", eventBus);

  assert.deepEqual(events, [
    { type: "start", response: undefined, agentName: "claude" },
    { type: "complete", response: "aggregated response", agentName: undefined }
  ]);
});

// ---------- Issue 98: idle-based hard reset ----------

const withTempDir = (fn: (dir: string) => void): void => {
  const dir = mkdtempSync(join(tmpdir(), "telegramable-test-"));
  try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};

test("FileSessionStore round-trips { id, lastUsedAt } shape", () => {
  withTempDir((dir) => {
    const store = new FileSessionStore(dir, "test-sessions.json");
    store.set("k1", "session-abc", 1_700_000_000_000);

    const reloaded = new FileSessionStore(dir, "test-sessions.json");
    const entry = reloaded.get("k1");
    assert.deepEqual(entry, { id: "session-abc", lastUsedAt: 1_700_000_000_000 });
  });
});

test("FileSessionStore coerces legacy bare-string entries to lastUsedAt=0", () => {
  withTempDir((dir) => {
    const filePath = join(dir, "legacy.json");
    writeFileSync(filePath, JSON.stringify({ "tg::chat::claude": "legacy-resume-id" }), "utf-8");

    const store = new FileSessionStore(dir, "legacy.json");
    const entry = store.get("tg::chat::claude");
    assert.deepEqual(entry, { id: "legacy-resume-id", lastUsedAt: 0 });
  });
});

test("InMemorySessionManager discards persisted session whose lastUsedAt is older than sessionTimeoutMs", () => {
  withTempDir((dir) => {
    const logger = createLogger("error");
    const fileStore = new FileSessionStore(dir, "stale.json", logger);
    // Pre-create a session whose lastUsedAt is 1000ms; timeout is 100ms — should be skipped.
    const sessionStore = new SessionStore(fileStore, () => 1_000);
    sessionStore.createSession("tg::chat::claude", "sub-a", "Old conversation");
    sessionStore.setResumeId("tg::chat::claude", "sub-a", "stale-resume");

    const manager = new InMemorySessionManager({
      logger,
      sessionTimeoutMs: 100,
      now: () => 5_000, // far past the stamped time
      sessionStore: new SessionStore(fileStore, () => 5_000),
      createSession: (channelId, chatId, _agentName) =>
        new FakeSession("fresh", channelId, chatId),
    });

    const session = manager.getOrCreate("tg", "chat", "claude") as FakeSession;
    assert.equal(session.wasRestoredFromDisk, false, "stale persisted session should not be restored");
    // Metadata is preserved (user can still see it in /sessions); only the resume restore is skipped.
    const meta = new SessionStore(fileStore).getActiveSession("tg::chat::claude");
    assert.equal(meta?.sessionId, "sub-a", "session metadata should be preserved across idle reset");
  });
});

test("InMemorySessionManager restores persisted session within idle window", () => {
  withTempDir((dir) => {
    const logger = createLogger("error");
    const fileStore = new FileSessionStore(dir, "fresh.json", logger);
    const sessionStore = new SessionStore(fileStore, () => 4_950);
    sessionStore.createSession("tg::chat::claude", "sub-b", "Recent conversation");
    sessionStore.setResumeId("tg::chat::claude", "sub-b", "fresh-resume");

    const manager = new InMemorySessionManager({
      logger,
      sessionTimeoutMs: 100,
      now: () => 5_000,
      sessionStore: new SessionStore(fileStore, () => 5_000),
      createSession: (channelId, chatId, _agentName) =>
        new FakeSession("new-session-id", channelId, chatId),
    });

    const session = manager.getOrCreate("tg", "chat", "claude") as FakeSession;
    assert.equal(session.wasRestoredFromDisk, true);
    assert.equal(session.resumeId, "fresh-resume");
  });
});

test("InMemorySessionManager.evictIdleSessions clears in-memory cache but preserves metadata", () => {
  withTempDir((dir) => {
    const logger = createLogger("error");
    const fileStore = new FileSessionStore(dir, "evict.json", logger);

    let now = 0;
    const sessionStore = new SessionStore(fileStore, () => now);
    sessionStore.createSession("tg::chat::claude", "sub-c", "Some session");

    const manager = new InMemorySessionManager({
      logger,
      sessionTimeoutMs: 100,
      now: () => now,
      sessionStore,
      createSession: (channelId, chatId, agentName) =>
        new FakeSession(`sess-${agentName}`, channelId, chatId),
    });

    manager.getOrCreate("tg", "chat", "claude");
    sessionStore.setResumeId("tg::chat::claude", "sub-c", "persisted-id");

    // Advance time past idle threshold, then trigger eviction by touching a different store key
    now = 500;
    sessionStore.createSession("tg::chat::other-agent", "sub-d", "Other session");
    manager.getOrCreate("tg", "chat", "other-agent");

    // Metadata is preserved — only the live AgentSession instance is evicted.
    const stillThere = sessionStore.getActiveSession("tg::chat::claude");
    assert.equal(stillThere?.sessionId, "sub-c",
      "idle eviction should only drop the in-memory AgentSession, not the session metadata");
    assert.equal(stillThere?.meta.resumeId, "persisted-id",
      "persisted resumeId stays so the user can reattach via /sessions");
  });
});

test("SessionRuntime marks the active sub-session broken when the runtime silently restarts", async () => {
  await new Promise<void>(async (resolve, reject) => {
    try {
      const logger = createLogger("error");
      const eventBus = new EventBus();

      // Simulate the silent-retry behaviour: send() returns a different resumeId than the one set before.
      const fakeSession: AgentSession = {
        sessionId: "fake",
        channelId: "tg",
        chatId: "c",
        async send(): Promise<string> {
          (fakeSession as unknown as { _r?: string })._r = "post-send-id";
          return "ok";
        },
        async close() {},
        get resumeId(): string | undefined {
          return (fakeSession as unknown as { _r?: string })._r;
        },
        setResumeId(id: string) {
          (fakeSession as unknown as { _r?: string })._r = id;
        },
      };

      const manager = {
        getOrCreate: () => {
          fakeSession.setResumeId!("pre-send-id");
          return fakeSession;
        },
        close: async () => {},
        closeAll: async () => {},
      };

      const dir = mkdtempSync(join(tmpdir(), "telegramable-broken-"));
      try {
        const fileStore = new FileSessionStore(dir, "x.json");
        const sessionStore = new SessionStore(fileStore);
        sessionStore.createSession("tg::c::claude", "sub", "test");

        const runtime = new SessionRuntime(
          { name: "claude", runtime: "session-claude", command: "claude" },
          manager,
          logger,
          { sessionStore },
        );

        await runtime.execute({ channelId: "tg", chatId: "c", text: "hi" }, "exec", eventBus);

        const meta = sessionStore.getActiveSession("tg::c::claude");
        assert.equal(meta?.meta.broken, true);
        assert.equal(meta?.meta.resumeId, "post-send-id");
        resolve();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    } catch (e) {
      reject(e);
    }
  });
});

test("SessionRuntime does NOT mark broken when there was no prior resumeId (fresh session)", async () => {
  const logger = createLogger("error");
  const eventBus = new EventBus();
  const fakeSession: AgentSession = {
    sessionId: "fake2",
    channelId: "tg",
    chatId: "c",
    async send(): Promise<string> {
      (fakeSession as unknown as { _r?: string })._r = "first-id";
      return "ok";
    },
    async close() {},
    get resumeId(): string | undefined {
      return (fakeSession as unknown as { _r?: string })._r;
    },
    setResumeId(id: string) {
      (fakeSession as unknown as { _r?: string })._r = id;
    },
  };

  const manager = {
    getOrCreate: () => fakeSession,
    close: async () => {},
    closeAll: async () => {},
  };

  const dir = mkdtempSync(join(tmpdir(), "telegramable-fresh-"));
  try {
    const fileStore = new FileSessionStore(dir, "x.json");
    const sessionStore = new SessionStore(fileStore);
    sessionStore.createSession("tg::c::claude", "sub", "test");

    const runtime = new SessionRuntime(
      { name: "claude", runtime: "session-claude", command: "claude" },
      manager,
      logger,
      { sessionStore },
    );

    await runtime.execute({ channelId: "tg", chatId: "c", text: "hi" }, "exec", eventBus);

    const meta = sessionStore.getActiveSession("tg::c::claude");
    assert.notEqual(meta?.meta.broken, true);
    assert.equal(meta?.meta.resumeId, "first-id");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createRuntime keeps CLI runtime default and dispatches session runtime", () => {
  const logger = createLogger("error");

  const cliAgent: AgentConfig = {
    name: "default",
    command: "echo"
  };

  const sessionAgent: AgentConfig = {
    name: "copilot",
    command: "gh",
    runtime: "session-copilot"
  };

  assert.ok(createRuntime(cliAgent, logger) instanceof CliRuntime);
  assert.ok(createRuntime(sessionAgent, logger) instanceof SessionRuntime);
});