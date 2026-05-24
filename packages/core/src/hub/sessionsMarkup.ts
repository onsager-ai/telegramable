import { SessionMeta, UNTITLED } from "../runtime/session/sessionStore";

export const SESSIONS_CALLBACK_PREFIX = "sess:";

const MAX_LIST_ROWS = 10;

type InlineKeyboard = Array<Array<{ text: string; callback_data: string }>>;

const escapeHtml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Render a relative-time string like "5m", "2h", "3d" suitable for inline rows.
 * Anchored to `now` so tests can stub time.
 */
const relativeTime = (ts: number, now: number): string => {
  const diff = Math.max(0, now - ts);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
};

/** True when the title is still the lazy-creation placeholder. */
const isPlaceholderTitle = (title: string | undefined): boolean => !title || title === UNTITLED;

export interface BuildSessionsListOptions {
  /** Anchor for relative-time rendering. Defaults to `Date.now()`. */
  now?: number;
}

/**
 * Build the `/sessions` response: ordered list of up to 10 sessions, plus
 * always-on control buttons (Rename active, + New). Per-row Switch buttons
 * appear for non-active, non-broken sessions.
 */
export function buildSessionsListMarkup(
  active: string | undefined,
  sessions: Array<{ sessionId: string; meta: SessionMeta }>,
  options: BuildSessionsListOptions = {},
): { text: string; markup: { inline_keyboard: InlineKeyboard } } {
  const now = options.now ?? Date.now();

  if (sessions.length === 0) {
    return {
      text: "<b>No sessions yet.</b>\nSend a message to start one, or tap below.",
      markup: { inline_keyboard: [[{ text: "➕ New session", callback_data: `${SESSIONS_CALLBACK_PREFIX}new` }]] },
    };
  }

  const rows = sessions.slice(0, MAX_LIST_ROWS);
  const lines: string[] = ["<b>Sessions</b>"];
  const keyboard: InlineKeyboard = [];

  for (const { sessionId, meta } of rows) {
    const placeholder = isPlaceholderTitle(meta.title);
    const titleDisplay = placeholder
      ? "<i>New session · awaiting first message</i>"
      : `<b>${escapeHtml(meta.title)}</b>`;
    const when = relativeTime(meta.lastUsedAt, now);
    const isActive = sessionId === active;

    if (meta.broken) {
      // Broken renders use the raw title (escaped) so the user can still recognize what was lost.
      const dead = escapeHtml(meta.title || "Untitled session");
      lines.push(`  <s>${dead}</s>  <i>broken</i>`);
      continue;
    }

    if (isActive) {
      lines.push(`→ ${titleDisplay}  <i>${when}</i>`);
      continue;
    }

    // Non-active row: title without bold (only active is bolded), plus a Switch button.
    const inlineTitle = placeholder
      ? "<i>New session · awaiting first message</i>"
      : escapeHtml(meta.title);
    lines.push(`  ${inlineTitle}  <i>${when}</i>`);
    keyboard.push([{
      text: `Switch · ${truncateForButton(placeholder ? "New session" : meta.title)}`,
      callback_data: `${SESSIONS_CALLBACK_PREFIX}switch:${sessionId}`,
    }]);
  }

  if (sessions.length > MAX_LIST_ROWS) {
    lines.push(`<i>… and ${sessions.length - MAX_LIST_ROWS} older</i>`);
  }

  // Always-on control row: act on the active session + start a new one. This
  // ensures single-session users have something to interact with — the prior
  // markup left them with no buttons at all.
  if (active) {
    keyboard.push([
      { text: "✎ Rename", callback_data: `${SESSIONS_CALLBACK_PREFIX}rename:${active}` },
      { text: "➕ New", callback_data: `${SESSIONS_CALLBACK_PREFIX}new` },
    ]);
  } else {
    keyboard.push([{ text: "➕ New session", callback_data: `${SESSIONS_CALLBACK_PREFIX}new` }]);
  }

  return {
    text: lines.join("\n"),
    markup: { inline_keyboard: keyboard },
  };
}

const truncateForButton = (text: string): string =>
  text.length <= 24 ? text : `${text.slice(0, 23)}…`;

export type SessionsCallback =
  | { type: "switch"; sessionId: string }
  | { type: "rename"; sessionId: string }
  | { type: "new" };

export function parseSessionsCallback(data: string): SessionsCallback | null {
  if (!data.startsWith(SESSIONS_CALLBACK_PREFIX)) return null;
  const body = data.slice(SESSIONS_CALLBACK_PREFIX.length);

  // Parameterless actions: "sess:new"
  if (body === "new") return { type: "new" };

  const colon = body.indexOf(":");
  if (colon < 0) return null;
  const action = body.slice(0, colon);
  const param = body.slice(colon + 1);
  if (action === "switch" && param.length > 0) return { type: "switch", sessionId: param };
  if (action === "rename" && param.length > 0) return { type: "rename", sessionId: param };
  return null;
}
