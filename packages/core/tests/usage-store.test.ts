import assert from "assert";
import test from "node:test";
import { mkdtempSync, rmSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { FileUsageStore } from "../src/runtime/usageStore";
import { parseClaudeUsage } from "../src/runtime/cliRuntime";

const withTempDir = (fn: (dir: string) => void): void => {
  const dir = mkdtempSync(join(tmpdir(), "tg-usage-"));
  try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};

// 2026-05-24T12:00:00Z — fixed instant so date math is deterministic.
const FIXED_NOW = Date.UTC(2026, 4, 24, 12, 0, 0);
const NEXT_DAY = FIXED_NOW + 24 * 60 * 60 * 1000;
const NEXT_MONTH = Date.UTC(2026, 5, 1, 0, 0, 0);

test("parseClaudeUsage returns null when the event has neither usage nor cost", () => {
  assert.equal(parseClaudeUsage({ type: "result" }), null);
});

test("parseClaudeUsage extracts input/output/cache tokens and cost from a Claude result event", () => {
  const evt = {
    type: "result",
    usage: {
      input_tokens: 1200,
      output_tokens: 800,
      cache_creation_input_tokens: 50,
      cache_read_input_tokens: 450,
    },
    total_cost_usd: 0.0234,
  };
  assert.deepEqual(parseClaudeUsage(evt), {
    inputTokens: 1200,
    outputTokens: 800,
    cacheTokens: 500,
    costUsd: 0.0234,
  });
});

test("parseClaudeUsage coerces missing numeric fields to 0", () => {
  // total_cost_usd only — usage block absent (some non-Claude binaries).
  assert.deepEqual(parseClaudeUsage({ type: "result", total_cost_usd: 0.5 }), {
    inputTokens: 0,
    outputTokens: 0,
    cacheTokens: 0,
    costUsd: 0.5,
  });
});

test("FileUsageStore accumulates same-day deltas under a single bucket", () => {
  withTempDir((dir) => {
    const store = new FileUsageStore(dir, "usage.json", undefined, () => FIXED_NOW);
    store.add("tg", "chat-1", "claude", { inputTokens: 100, outputTokens: 50, cacheTokens: 0, costUsd: 0.01 });
    store.add("tg", "chat-1", "claude", { inputTokens: 200, outputTokens: 100, cacheTokens: 10, costUsd: 0.02 });

    const today = store.sumToday("tg", "chat-1", "claude");
    assert.deepEqual(today, { inputTokens: 300, outputTokens: 150, cacheTokens: 10, costUsd: 0.03 });
  });
});

test("FileUsageStore.sumToday is scoped to the current UTC date", () => {
  withTempDir((dir) => {
    let now = FIXED_NOW;
    const store = new FileUsageStore(dir, "usage.json", undefined, () => now);
    store.add("tg", "chat-1", "claude", { inputTokens: 100, outputTokens: 0, cacheTokens: 0, costUsd: 0.01 });

    // Roll forward 24h — yesterday's entry must NOT count toward today.
    now = NEXT_DAY;
    store.add("tg", "chat-1", "claude", { inputTokens: 50, outputTokens: 0, cacheTokens: 0, costUsd: 0.005 });
    assert.deepEqual(store.sumToday("tg", "chat-1", "claude"), { inputTokens: 50, outputTokens: 0, cacheTokens: 0, costUsd: 0.005 });
  });
});

test("FileUsageStore.sumThisMonth aggregates across days in the same UTC month", () => {
  withTempDir((dir) => {
    let now = FIXED_NOW;
    const store = new FileUsageStore(dir, "usage.json", undefined, () => now);
    store.add("tg", "chat-1", "claude", { inputTokens: 100, outputTokens: 0, cacheTokens: 0, costUsd: 0.01 });
    now = NEXT_DAY;
    store.add("tg", "chat-1", "claude", { inputTokens: 50, outputTokens: 0, cacheTokens: 0, costUsd: 0.005 });
    // Across-month boundary — must NOT count toward this month's sum.
    now = NEXT_MONTH;
    store.add("tg", "chat-1", "claude", { inputTokens: 999, outputTokens: 0, cacheTokens: 0, costUsd: 0.99 });

    now = NEXT_DAY; // query as of the 25th — still in May
    const month = store.sumThisMonth("tg", "chat-1", "claude");
    assert.deepEqual(month, { inputTokens: 150, outputTokens: 0, cacheTokens: 0, costUsd: 0.015 });
  });
});

test("FileUsageStore scopes sums by (channelId, chatId, agentName)", () => {
  withTempDir((dir) => {
    const store = new FileUsageStore(dir, "usage.json", undefined, () => FIXED_NOW);
    store.add("tg", "chat-1", "claude", { inputTokens: 100, outputTokens: 0, cacheTokens: 0, costUsd: 0.01 });
    store.add("tg", "chat-2", "claude", { inputTokens: 999, outputTokens: 0, cacheTokens: 0, costUsd: 0.99 }); // different chat
    store.add("tg", "chat-1", "gemini", { inputTokens: 888, outputTokens: 0, cacheTokens: 0, costUsd: 0.88 }); // different agent

    assert.deepEqual(store.sumToday("tg", "chat-1", "claude"), { inputTokens: 100, outputTokens: 0, cacheTokens: 0, costUsd: 0.01 });
  });
});

test("FileUsageStore persists across instances over the same file", () => {
  withTempDir((dir) => {
    const a = new FileUsageStore(dir, "usage.json", undefined, () => FIXED_NOW);
    a.add("tg", "chat-1", "claude", { inputTokens: 1000, outputTokens: 500, cacheTokens: 0, costUsd: 0.05 });

    const b = new FileUsageStore(dir, "usage.json", undefined, () => FIXED_NOW);
    assert.deepEqual(b.sumToday("tg", "chat-1", "claude"), { inputTokens: 1000, outputTokens: 500, cacheTokens: 0, costUsd: 0.05 });

    // And the file on disk is human-readable JSON (not a binary blob).
    const raw = readFileSync(join(dir, "usage.json"), "utf-8");
    assert.ok(raw.includes("inputTokens"), "expected human-readable JSON");
  });
});
