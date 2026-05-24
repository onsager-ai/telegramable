import assert from "assert";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import test from "node:test";
import { FileSessionStore } from "../src/runtime/session/fileSessionStore";
import { SessionStore, SessionStoreValue } from "../src/runtime/session/sessionStore";

const withTempDir = (fn: (dir: string) => void): void => {
  const dir = mkdtempSync(join(tmpdir(), "telegramable-test-"));
  try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};

test("SessionStore returns undefined for missing keys", () => {
  withTempDir((dir) => {
    const store = new SessionStore(new FileSessionStore(dir, "x.json"));
    assert.equal(store.getValue("nope"), undefined);
    assert.equal(store.getActiveSession("nope"), undefined);
    assert.deepEqual(store.listSessions("nope"), []);
  });
});

test("SessionStore.createSession persists and makes the new id active", () => {
  withTempDir((dir) => {
    const store = new SessionStore(new FileSessionStore(dir, "x.json"), () => 100);
    store.createSession("k", "s1", "First");
    const active = store.getActiveSession("k");
    assert.equal(active?.sessionId, "s1");
    assert.equal(active?.meta.title, "First");
    assert.equal(active?.meta.createdAt, 100);
    assert.equal(active?.meta.lastUsedAt, 100);
  });
});

test("SessionStore.switchActive flips the active id", () => {
  withTempDir((dir) => {
    let now = 100;
    const store = new SessionStore(new FileSessionStore(dir, "x.json"), () => now);
    store.createSession("k", "s1", "First");
    now = 200;
    store.createSession("k", "s2", "Second");
    assert.equal(store.getActiveSession("k")?.sessionId, "s2");

    now = 300;
    store.switchActive("k", "s1");
    assert.equal(store.getActiveSession("k")?.sessionId, "s1");
    assert.equal(store.getActiveSession("k")?.meta.lastUsedAt, 300);
  });
});

test("SessionStore.switchActive ignores unknown sessionIds", () => {
  withTempDir((dir) => {
    const store = new SessionStore(new FileSessionStore(dir, "x.json"));
    store.createSession("k", "s1", "First");
    store.switchActive("k", "does-not-exist");
    assert.equal(store.getActiveSession("k")?.sessionId, "s1");
  });
});

test("SessionStore.listSessions sorts by lastUsedAt desc", () => {
  withTempDir((dir) => {
    let now = 100;
    const store = new SessionStore(new FileSessionStore(dir, "x.json"), () => now);
    store.createSession("k", "s1", "A");
    now = 200;
    store.createSession("k", "s2", "B");
    now = 150;
    store.touchLastUsed("k", "s1"); // bump s1 to 150 — still < 200

    const list = store.listSessions("k");
    assert.deepEqual(list.map((s) => s.sessionId), ["s2", "s1"]);

    now = 300;
    store.touchLastUsed("k", "s1");
    const list2 = store.listSessions("k");
    assert.deepEqual(list2.map((s) => s.sessionId), ["s1", "s2"]);
  });
});

test("SessionStore.setResumeId records the runtime native id", () => {
  withTempDir((dir) => {
    const store = new SessionStore(new FileSessionStore(dir, "x.json"));
    store.createSession("k", "s1", "First");
    store.setResumeId("k", "s1", "resume-abc");
    assert.equal(store.getActiveSession("k")?.meta.resumeId, "resume-abc");
  });
});

test("SessionStore.markBroken sets the broken flag without deleting", () => {
  withTempDir((dir) => {
    const store = new SessionStore(new FileSessionStore(dir, "x.json"));
    store.createSession("k", "s1", "First");
    store.setResumeId("k", "s1", "resume-abc");
    store.markBroken("k", "s1");

    const list = store.listSessions("k");
    assert.equal(list.length, 1);
    assert.equal(list[0].meta.broken, true);
    assert.equal(list[0].meta.resumeId, "resume-abc");
  });
});

test("SessionStore.setTitle updates the title in place", () => {
  withTempDir((dir) => {
    const store = new SessionStore(new FileSessionStore(dir, "x.json"));
    store.createSession("k", "s1", "Untitled session");
    store.setTitle("k", "s1", "Real title");
    assert.equal(store.getActiveSession("k")?.meta.title, "Real title");
  });
});

test("SessionStore migrates legacy { id, lastUsedAt } shape on read", () => {
  withTempDir((dir) => {
    const filePath = join(dir, "legacy.json");
    // Legacy post-#98 shape: bare resumeId in the `id` field.
    writeFileSync(filePath, JSON.stringify({
      "tg::chat::claude": { id: "legacy-resume", lastUsedAt: 1_700_000_000_000 },
    }), "utf-8");

    const fileStore = new FileSessionStore(dir, "legacy.json");
    const store = new SessionStore(fileStore, () => 1_700_000_001_000);
    const active = store.getActiveSession("tg::chat::claude");

    assert.ok(active);
    assert.equal(active?.meta.title, "Restored session");
    assert.equal(active?.meta.resumeId, "legacy-resume");
    assert.equal(active?.meta.createdAt, 1_700_000_000_000);

    // Should have persisted the migrated structure back to disk.
    const persisted = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(persisted);
    const value = JSON.parse(parsed["tg::chat::claude"].id) as SessionStoreValue;
    assert.equal(value.active, active?.sessionId);
    assert.equal(value.sessions[active!.sessionId].resumeId, "legacy-resume");
  });
});

test("SessionStore migrates legacy bare-string entries via FileSessionStore coercion", () => {
  withTempDir((dir) => {
    const filePath = join(dir, "ancient.json");
    // Pre-#98 bare-string format; FileSessionStore coerces to { id, lastUsedAt: 0 } on load.
    writeFileSync(filePath, JSON.stringify({
      "tg::chat::claude": "ancient-resume",
    }), "utf-8");

    const fileStore = new FileSessionStore(dir, "ancient.json");
    const store = new SessionStore(fileStore, () => 9_999);
    const active = store.getActiveSession("tg::chat::claude");

    assert.ok(active);
    assert.equal(active?.meta.resumeId, "ancient-resume");
    // lastUsedAt was 0 → SessionStore stamps `now` into createdAt/lastUsedAt.
    assert.equal(active?.meta.createdAt, 9_999);
    assert.equal(active?.meta.lastUsedAt, 9_999);
  });
});

test("SessionStore round-trips multi-session state across instances", () => {
  withTempDir((dir) => {
    let now = 100;
    const fileStore = new FileSessionStore(dir, "x.json");
    const a = new SessionStore(fileStore, () => now);
    a.createSession("k", "s1", "First");
    now = 200;
    a.createSession("k", "s2", "Second");
    a.setResumeId("k", "s2", "resume-2");

    // New instance over the same file should see both sessions.
    const b = new SessionStore(new FileSessionStore(dir, "x.json"));
    const list = b.listSessions("k");
    assert.equal(list.length, 2);
    assert.equal(b.getActiveSession("k")?.sessionId, "s2");
    assert.equal(b.getActiveSession("k")?.meta.resumeId, "resume-2");

    // File should actually exist on disk.
    assert.ok(existsSync(join(dir, "x.json")));
  });
});
