import assert from "assert";
import test from "node:test";
import {
  SESSIONS_CALLBACK_PREFIX,
  buildSessionsListMarkup,
  parseSessionsCallback,
} from "../src/hub/sessionsMarkup";
import { SessionMeta } from "../src/runtime/session/sessionStore";

const meta = (overrides: Partial<SessionMeta> = {}): SessionMeta => ({
  title: "Untitled session",
  createdAt: 1_000,
  lastUsedAt: 1_000,
  ...overrides,
});

test("buildSessionsListMarkup renders empty state with no buttons", () => {
  const { text, markup } = buildSessionsListMarkup(undefined, []);
  assert.ok(text.includes("No sessions yet"));
  assert.deepEqual(markup.inline_keyboard, []);
});

test("buildSessionsListMarkup marks the active session and omits its button", () => {
  const now = 60_000;
  const { text, markup } = buildSessionsListMarkup(
    "s1",
    [{ sessionId: "s1", meta: meta({ title: "Hello", lastUsedAt: now - 30_000 }) }],
    { now },
  );
  assert.ok(text.includes("→ <b>Hello</b>"));
  assert.deepEqual(markup.inline_keyboard, []);
});

test("buildSessionsListMarkup renders [Switch] for non-active rows", () => {
  const now = 60_000;
  const { text, markup } = buildSessionsListMarkup(
    "s1",
    [
      { sessionId: "s1", meta: meta({ title: "Active one", lastUsedAt: now }) },
      { sessionId: "s2", meta: meta({ title: "Other", lastUsedAt: now - 5 * 60_000 }) },
    ],
    { now },
  );
  assert.ok(text.includes("→ <b>Active one</b>"));
  assert.ok(text.includes("Other"));
  assert.equal(markup.inline_keyboard.length, 1);
  assert.equal(markup.inline_keyboard[0][0].callback_data, "sess:switch:s2");
});

test("buildSessionsListMarkup renders broken rows as strikethrough with no button", () => {
  const { text, markup } = buildSessionsListMarkup(
    "s1",
    [
      { sessionId: "s1", meta: meta({ title: "Active", lastUsedAt: 1_000 }) },
      { sessionId: "s2", meta: meta({ title: "Dead session", lastUsedAt: 500, broken: true }) },
    ],
    { now: 2_000 },
  );
  assert.ok(text.includes("<s>Dead session</s>"));
  assert.ok(text.includes("broken"));
  // Only one keyboard row would have been added (for s2) without the broken guard.
  assert.equal(markup.inline_keyboard.length, 0);
});

test("buildSessionsListMarkup caps at 10 rows and shows overflow hint", () => {
  const sessions = Array.from({ length: 13 }, (_, i) => ({
    sessionId: `s${i}`,
    meta: meta({ title: `Title ${i}`, lastUsedAt: 1_000 - i }),
  }));
  const { text, markup } = buildSessionsListMarkup(undefined, sessions, { now: 2_000 });
  assert.ok(text.includes("3 older"));
  // 10 non-active rows, all get [Switch]
  assert.equal(markup.inline_keyboard.length, 10);
});

test("buildSessionsListMarkup escapes HTML in titles", () => {
  const { text } = buildSessionsListMarkup(
    "s1",
    [{ sessionId: "s1", meta: meta({ title: "<script>alert(1)</script>" }) }],
    { now: 1_000 },
  );
  assert.ok(text.includes("&lt;script&gt;"));
  assert.ok(!text.includes("<script>"));
});

test("parseSessionsCallback round-trips the switch action", () => {
  const data = `${SESSIONS_CALLBACK_PREFIX}switch:abc-123`;
  const parsed = parseSessionsCallback(data);
  assert.deepEqual(parsed, { type: "switch", sessionId: "abc-123" });
});

test("parseSessionsCallback returns null for malformed input", () => {
  assert.equal(parseSessionsCallback("not-ours:foo"), null);
  assert.equal(parseSessionsCallback("sess:"), null);
  assert.equal(parseSessionsCallback("sess:switch:"), null);
  assert.equal(parseSessionsCallback("sess:unknown:abc"), null);
});
