import { SessionMeta } from "../runtime/session/sessionStore";

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

export interface BuildSessionsListOptions {
  /** Anchor for relative-time rendering. Defaults to `Date.now()`. */
  now?: number;
}

/**
 * Build the `/sessions` response: ordered list of up to 10 sessions, with a
 * `[Switch]` button per non-active non-broken row. Empty state returns no
 * buttons.
 */
export function buildSessionsListMarkup(
  active: string | undefined,
  sessions: Array<{ sessionId: string; meta: SessionMeta }>,
  options: BuildSessionsListOptions = {},
): { text: string; markup: { inline_keyboard: InlineKeyboard } } {
  const now = options.now ?? Date.now();

  if (sessions.length === 0) {
    return {
      text: "<b>No sessions yet.</b>\nSend a message to start one.",
      markup: { inline_keyboard: [] },
    };
  }

  const rows = sessions.slice(0, MAX_LIST_ROWS);
  const lines: string[] = ["<b>Sessions</b>"];
  const keyboard: InlineKeyboard = [];

  for (const { sessionId, meta } of rows) {
    const title = escapeHtml(meta.title || "Untitled session");
    const when = relativeTime(meta.lastUsedAt, now);
    const isActive = sessionId === active;

    if (meta.broken) {
      lines.push(`  <s>${title}</s>  <i>broken</i>`);
      continue;
    }

    if (isActive) {
      lines.push(`→ <b>${title}</b>  <i>${when}</i>`);
      continue;
    }

    lines.push(`  ${title}  <i>${when}</i>`);
    keyboard.push([{
      text: `Switch · ${truncateForButton(meta.title || "Untitled session")}`,
      callback_data: `${SESSIONS_CALLBACK_PREFIX}switch:${sessionId}`,
    }]);
  }

  if (sessions.length > MAX_LIST_ROWS) {
    lines.push(`<i>… and ${sessions.length - MAX_LIST_ROWS} older</i>`);
  }

  return {
    text: lines.join("\n"),
    markup: { inline_keyboard: keyboard },
  };
}

const truncateForButton = (text: string): string =>
  text.length <= 24 ? text : `${text.slice(0, 23)}…`;

export type SessionsCallback = { type: "switch"; sessionId: string };

export function parseSessionsCallback(data: string): SessionsCallback | null {
  if (!data.startsWith(SESSIONS_CALLBACK_PREFIX)) return null;
  const body = data.slice(SESSIONS_CALLBACK_PREFIX.length);
  const colon = body.indexOf(":");
  if (colon < 0) return null;
  const action = body.slice(0, colon);
  const param = body.slice(colon + 1);
  if (action === "switch" && param.length > 0) {
    return { type: "switch", sessionId: param };
  }
  return null;
}
