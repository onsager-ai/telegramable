import assert from "assert";
import test from "node:test";
import { EventEmitter } from "events";
import { mkdtempSync, rmSync, writeFileSync as fsWriteFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createLogger } from "../src/logging";
import { MemoryStore } from "../src/memory/store";
import { TelegramMemoryProvider } from "../src/memory/telegramProvider";
import { MemoryWorker } from "../src/memory/worker/memoryWorker";
import { WorkerJob } from "../src/memory/worker/types";
import { formatTurnSnapshot, MAX_TURNS_PER_SNAPSHOT } from "../src/memory/worker/turnSnapshot";

const logger = createLogger("error");

// Build a TelegramMemoryProvider whose sync targets are stubbed — we only need the store
// to verify diff/apply behavior.
const makeProvider = (initial: Array<{ tag: "project" | "preference"; text: string }> = []) => {
  // We build a fake provider object that satisfies the interface MemoryWorker uses.
  const store = new MemoryStore();
  for (const f of initial) store.add(f.tag, f.text);

  let synced = 0;
  const changelogs: string[] = [];
  const provider = {
    store,
    all() { return store.all(); },
    async syncToTelegram() { synced++; },
    async sendChangelog(text: string) { changelogs.push(text); },
  } as unknown as TelegramMemoryProvider;

  return { provider, store, syncedRef: () => synced, changelogs };
};

const fakeSpawn = (onSpawn: (args: string[]) => { exitCode: number; stateAfter?: string }) => {
  // Mimic the shape of Node's ChildProcess enough that MemoryWorker can drive it.
  return ((command: string, args: string[]) => {
    const child = new EventEmitter() as unknown as import("child_process").ChildProcess & {
      kill: (sig?: NodeJS.Signals) => boolean;
      killed: boolean;
    };
    (child as { stdout: EventEmitter | null }).stdout = new EventEmitter();
    (child as { stderr: EventEmitter | null }).stderr = new EventEmitter();
    child.kill = () => true;
    child.killed = false;

    // Find the state file path from --mcp-config: read that config to extract stateFilePath.
    setImmediate(() => {
      try {
        const { exitCode, stateAfter } = onSpawn(args);
        if (stateAfter) {
          // The state file path is in args after --mcp-config; the config JSON points to it.
          const mcpIdx = args.indexOf("--mcp-config");
          if (mcpIdx >= 0) {
            const mcpConfigPath = args[mcpIdx + 1];
            const config = JSON.parse(require("fs").readFileSync(mcpConfigPath, "utf-8"));
            const stateFilePath = config.mcpServers.memory.args[1];
            fsWriteFileSync(stateFilePath, stateAfter);
          }
        }
        child.emit("close", exitCode);
      } catch (err) {
        child.emit("error", err);
      }
    });
    return child;
  }) as unknown as typeof import("child_process").spawn;
};

const makeStubMcpStdio = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "telegramable-worker-test-"));
  const stub = join(dir, "stub-mcp.js");
  // The file needs to exist so MemoryWorker doesn't bail; content doesn't matter
  // because we mock spawn.
  fsWriteFileSync(stub, "// stub\n");
  return stub;
};

const makeJob = (overrides: Partial<WorkerJob> = {}): WorkerJob => ({
  channelId: "tg",
  chatId: "chat-1",
  dispatchedAt: Date.now(),
  turns: [{ userText: "I work on telegramable", response: "Got it.", timestamp: Date.now() }],
  ...overrides,
});

test("formatTurnSnapshot includes user/assistant lines and the task footer", () => {
  const out = formatTurnSnapshot([
    { userText: "hi", response: "hello", timestamp: 1 },
  ]);
  assert.ok(out.includes("=== Conversation since last memory update ==="));
  assert.ok(out.includes("[user] hi"));
  assert.ok(out.includes("[assistant] hello"));
  assert.ok(out.includes("=== Task ==="));
});

test("formatTurnSnapshot truncates to the most recent N turns", () => {
  const turns = Array.from({ length: MAX_TURNS_PER_SNAPSHOT + 10 }, (_, i) => ({
    userText: `u${i}`,
    response: `r${i}`,
    timestamp: i,
  }));
  const out = formatTurnSnapshot(turns);
  // The first turn (u0) should be dropped.
  assert.ok(!out.includes("[user] u0"));
  // The last turn should be present.
  assert.ok(out.includes(`[user] u${turns.length - 1}`));
});

test("MemoryWorker.run applies diff and emits changelog on success", async () => {
  const { provider, store, syncedRef, changelogs } = makeProvider([{ tag: "project", text: "old fact" }]);
  const stubMcp = makeStubMcpStdio();

  const spawnFn = fakeSpawn(() => ({
    exitCode: 0,
    stateAfter: JSON.stringify({
      v: 1,
      updated: new Date().toISOString(),
      facts: [
        ...store.all(),
        { id: "f099", tag: "project", text: "new fact", at: "2026-05-22" },
      ],
    }),
  }));

  const worker = new MemoryWorker({
    provider,
    claudeCommand: "claude",
    logger,
    spawnFn,
    mcpStdioPath: stubMcp,
    timeoutMs: 5_000,
  });

  await worker.run(makeJob());

  const factTexts = store.all().map((f) => f.text);
  assert.ok(factTexts.includes("new fact"), "store should have the worker-added fact");
  assert.ok(factTexts.includes("old fact"), "existing facts preserved");
  assert.equal(syncedRef(), 1, "syncToTelegram called exactly once");
  assert.equal(changelogs.length, 1, "changelog sent");
  assert.ok(changelogs[0].includes("new fact"));

  rmSync(stubMcp, { force: true });
});

test("MemoryWorker.run throws on subprocess non-zero exit and does not mutate the store", async () => {
  const { provider, store, syncedRef } = makeProvider([{ tag: "project", text: "untouched" }]);
  const stubMcp = makeStubMcpStdio();

  const spawnFn = fakeSpawn(() => ({
    exitCode: 1,
    // Even if state file is written, a non-zero exit should skip the sync.
    stateAfter: JSON.stringify({
      v: 1, updated: "", facts: [],
    }),
  }));

  const worker = new MemoryWorker({
    provider,
    claudeCommand: "claude",
    logger,
    spawnFn,
    mcpStdioPath: stubMcp,
    timeoutMs: 5_000,
  });

  await assert.rejects(() => worker.run(makeJob()), /exited with code 1/);
  assert.equal(store.all().length, 1, "store untouched on failure");
  assert.equal(syncedRef(), 0, "no sync on failure");

  rmSync(stubMcp, { force: true });
});

test("MemoryWorker.run is a no-op (no changelog) when subprocess writes no diff", async () => {
  const { provider, syncedRef, changelogs } = makeProvider([{ tag: "preference", text: "stable" }]);
  const stubMcp = makeStubMcpStdio();

  const spawnFn = fakeSpawn(() => ({
    exitCode: 0,
    // State after equals baseline → no diff.
    stateAfter: JSON.stringify(provider.store.snapshot()),
  }));

  const worker = new MemoryWorker({
    provider,
    claudeCommand: "claude",
    logger,
    spawnFn,
    mcpStdioPath: stubMcp,
    timeoutMs: 5_000,
  });

  await worker.run(makeJob());
  assert.equal(syncedRef(), 0, "no sync when nothing changed");
  assert.equal(changelogs.length, 0, "no changelog when nothing changed");

  rmSync(stubMcp, { force: true });
});

test("MemoryWorker.shutdown is safe to call when nothing is running", async () => {
  const stubMcp = makeStubMcpStdio();
  const worker = new MemoryWorker({
    provider: makeProvider().provider,
    claudeCommand: "claude",
    logger,
    spawnFn: fakeSpawn(() => ({ exitCode: 0 })),
    mcpStdioPath: stubMcp,
  });
  await worker.shutdown(); // should not throw
  rmSync(stubMcp, { force: true });
});
