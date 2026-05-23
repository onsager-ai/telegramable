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
    // Stored 1000ms ago; timeout is 100ms — should be discarded.
    fileStore.set("tg::chat::claude", "stale-resume", 1_000);

    const manager = new InMemorySessionManager({
      logger,
      sessionTimeoutMs: 100,
      now: () => 5_000, // far past the stamped time
      fileStore,
      createSession: (channelId, chatId, agentName) =>
        new FakeSession("fresh", channelId, chatId),
    });

    const session = manager.getOrCreate("tg", "chat", "claude") as FakeSession;
    assert.equal(session.wasRestoredFromDisk, false, "stale persisted session should not be restored");
    assert.equal(fileStore.get("tg::chat::claude"), undefined, "stale entry should be evicted from disk");
  });
});

test("InMemorySessionManager restores persisted session within idle window", () => {
  withTempDir((dir) => {
    const logger = createLogger("error");
    const fileStore = new FileSessionStore(dir, "fresh.json", logger);
    fileStore.set("tg::chat::claude", "fresh-resume", 4_950); // recent

    const manager = new InMemorySessionManager({
      logger,
      sessionTimeoutMs: 100,
      now: () => 5_000,
      fileStore,
      createSession: (channelId, chatId, agentName) =>
        new FakeSession("new-session-id", channelId, chatId),
    });

    const session = manager.getOrCreate("tg", "chat", "claude") as FakeSession;
    assert.equal(session.wasRestoredFromDisk, true);
    assert.equal(session.resumeId, "fresh-resume");
  });
});

test("InMemorySessionManager.evictIdleSessions also deletes fileStore entries", () => {
  withTempDir((dir) => {
    const logger = createLogger("error");
    const fileStore = new FileSessionStore(dir, "evict.json", logger);

    let now = 0;
    const manager = new InMemorySessionManager({
      logger,
      sessionTimeoutMs: 100,
      now: () => now,
      fileStore,
      createSession: (channelId, chatId, agentName) =>
        new FakeSession(`sess-${agentName}`, channelId, chatId),
    });

    manager.getOrCreate("tg", "chat", "claude");
    // Simulate persistence by directly setting the fileStore (SessionRuntime
    // would do this after a successful send).
    fileStore.set("tg::chat::claude", "persisted-id", now);

    // Advance time past idle threshold, then trigger eviction
    now = 500;
    manager.getOrCreate("tg", "chat", "other-agent");

    assert.equal(fileStore.get("tg::chat::claude"), undefined,
      "idle eviction should also delete the persisted resume ID");
  });
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