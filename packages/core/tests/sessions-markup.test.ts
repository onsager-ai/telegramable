import assert from "assert";
import test from "node:test";
import {
  SESSIONS_CALLBACK_PREFIX,
  buildSessionsListMarkup,
  parseSessionsCallback,
} from "../src/hub/sessionsMarkup";
import { SessionMeta, UNTITLED } from "../src/runtime/session/sessionStore";

const meta = (overrides: Partial<SessionMeta> = {}): SessionMeta => ({
  title: "Untitled session",
  createdAt: 1_000,
  lastUsedAt: 1_000,
  ...overrides,
});

test("buildSessionsListMarkup renders empty state with a single + New button", () => {
  const { text, markup } = buildSessionsListMarkup(undefined, []);
  assert.ok(text.includes("No sessions yet"));
  assert.equal(markup.inline_keyboard.length, 1);
  assert.equal(markup.inline_keyboard[0][0].callback_data, "sess:new");
});

test("buildSessionsListMarkup marks the active session and adds Rename + New control buttons", () => {
  const now = 60_000;
  const { text, markup } = buildSessionsListMarkup(
    "s1",
    [{ sessionId: "s1", meta: meta({ title: "Hello", lastUsedAt: now - 30_000 }) }],
    { now },
  );
  assert.ok(text.includes("→ <b>Hello</b>"));
  // No Switch button on the active row — only the always-on control row at the bottom.
  assert.equal(markup.inline_keyboard.length, 1);
  const controlRow = markup.inline_keyboard[0];
  assert.equal(controlRow.length, 2);
  assert.equal(controlRow[0].callback_data, "sess:rename:s1");
  assert.equal(controlRow[1].callback_data, "sess:new");
});

test("buildSessionsListMarkup renders an italic placeholder for UNTITLED sessions", () => {
  const { text } = buildSessionsListMarkup(
    "s1",
    [{ sessionId: "s1", meta: meta({ title: UNTITLED, lastUsedAt: 1_000 }) }],
    { now: 1_000 },
  );
  assert.ok(text.includes("New session · awaiting first message"));
  assert.ok(!text.includes("Untitled session"));
});

test("buildSessionsListMarkup renders [Switch] for non-active rows plus a control row", () => {
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
  // 1 Switch row for s2 + 1 control row (Rename active + New)
  assert.equal(markup.inline_keyboard.length, 2);
  assert.equal(markup.inline_keyboard[0][0].callback_data, "sess:switch:s2");
  assert.equal(markup.inline_keyboard[1][0].callback_data, "sess:rename:s1");
  assert.equal(markup.inline_keyboard[1][1].callback_data, "sess:new");
});

test("buildSessionsListMarkup renders broken rows as strikethrough with no Switch button", () => {
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
  // Broken sessions get no row, so only the control row remains.
  assert.equal(markup.inline_keyboard.length, 1);
  assert.equal(markup.inline_keyboard[0][0].callback_data, "sess:rename:s1");
});

test("buildSessionsListMarkup caps at 10 rows and shows overflow hint", () => {
  const sessions = Array.from({ length: 13 }, (_, i) => ({
    sessionId: `s${i}`,
    meta: meta({ title: `Title ${i}`, lastUsedAt: 1_000 - i }),
  }));
  const { text, markup } = buildSessionsListMarkup(undefined, sessions, { now: 2_000 });
  assert.ok(text.includes("3 older"));
  // 10 non-active rows (no active set) all get [Switch], plus the bottom + New row.
  assert.equal(markup.inline_keyboard.length, 11);
  assert.equal(markup.inline_keyboard[10][0].callback_data, "sess:new");
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

test("parseSessionsCallback round-trips the rename action", () => {
  const parsed = parseSessionsCallback(`${SESSIONS_CALLBACK_PREFIX}rename:abc-123`);
  assert.deepEqual(parsed, { type: "rename", sessionId: "abc-123" });
});

test("parseSessionsCallback round-trips the new action", () => {
  const parsed = parseSessionsCallback(`${SESSIONS_CALLBACK_PREFIX}new`);
  assert.deepEqual(parsed, { type: "new" });
});

test("parseSessionsCallback returns null for malformed input", () => {
  assert.equal(parseSessionsCallback("not-ours:foo"), null);
  assert.equal(parseSessionsCallback("sess:"), null);
  assert.equal(parseSessionsCallback("sess:switch:"), null);
  assert.equal(parseSessionsCallback("sess:rename:"), null);
  assert.equal(parseSessionsCallback("sess:unknown:abc"), null);
});
