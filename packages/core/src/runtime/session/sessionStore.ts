import { randomUUID } from "crypto";
import { FileSessionStore } from "./fileSessionStore";

/** Metadata for one sub-session inside a `(channelId, chatId, agentName)` slot. */
export interface SessionMeta {
  /** Runtime-native id (e.g. Claude resume id). Undefined until the first successful send. */
  resumeId?: string;
  /** Human-readable title — auto-generated from the first user message. */
  title: string;
  createdAt: number;
  lastUsedAt: number;
  /** Set when the runtime's `--resume <id>` fails. Broken sessions are non-resumable. */
  broken?: true;
}

/** Persisted shape of a session slot. */
export interface SessionStoreValue {
  /** The sessionId currently selected for new messages. */
  active: string;
  sessions: Record<string, SessionMeta>;
}

/** Placeholder used until the first user message arrives to set a real title. */
export const UNTITLED = "Untitled session";

/** Title assigned to the auto-generated wrapper when migrating a legacy single-session entry. */
const RESTORED_TITLE = "Restored session";

/**
 * Multi-session wrapper around `FileSessionStore`.
 *
 * The underlying file stores one entry per `(channelId, chatId, agentName)` slot — the
 * value is a JSON-encoded `SessionStoreValue`. Legacy entries (pre-multi-session, where
 * the stored payload is a bare resumeId from the post-#98 `{ id, lastUsedAt }` shape)
 * are lazily migrated on read.
 */
export class SessionStore {
  constructor(private readonly inner: FileSessionStore, private readonly now: () => number = () => Date.now()) {}

  /** Read and decode a slot. Performs lazy migration of legacy entries. */
  getValue(key: string): SessionStoreValue | undefined {
    const raw = this.inner.get(key);
    if (!raw) return undefined;

    // New shape: `id` is a JSON-encoded SessionStoreValue.
    if (raw.id.startsWith("{")) {
      try {
        const parsed = JSON.parse(raw.id) as SessionStoreValue;
        if (parsed && typeof parsed.active === "string" && parsed.sessions && typeof parsed.sessions === "object") {
          return parsed;
        }
      } catch {
        // Fall through to migration path.
      }
    }

    // Legacy shape: `id` is a bare resumeId. Wrap into a single-session value.
    const newSessionId = randomUUID();
    const stamp = raw.lastUsedAt && raw.lastUsedAt > 0 ? raw.lastUsedAt : this.now();
    const migrated: SessionStoreValue = {
      active: newSessionId,
      sessions: {
        [newSessionId]: {
          resumeId: raw.id,
          title: RESTORED_TITLE,
          createdAt: stamp,
          lastUsedAt: stamp,
        },
      },
    };
    this.write(key, migrated);
    return migrated;
  }

  /** The active sub-session, or undefined if the slot has no entries. */
  getActiveSession(key: string): { sessionId: string; meta: SessionMeta } | undefined {
    const value = this.getValue(key);
    if (!value) return undefined;
    const meta = value.sessions[value.active];
    if (!meta) return undefined;
    return { sessionId: value.active, meta };
  }

  /** All sub-sessions in the slot, sorted by `lastUsedAt` desc. */
  listSessions(key: string): Array<{ sessionId: string; meta: SessionMeta }> {
    const value = this.getValue(key);
    if (!value) return [];
    return Object.entries(value.sessions)
      .map(([sessionId, meta]) => ({ sessionId, meta }))
      .sort((a, b) => b.meta.lastUsedAt - a.meta.lastUsedAt);
  }

  /** Create a new sub-session and make it active. Persists immediately. */
  createSession(key: string, sessionId: string, title: string): void {
    const now = this.now();
    const existing = this.getValue(key);
    const value: SessionStoreValue = existing
      ? { ...existing, sessions: { ...existing.sessions } }
      : { active: sessionId, sessions: {} };
    value.sessions[sessionId] = {
      title,
      createdAt: now,
      lastUsedAt: now,
    };
    value.active = sessionId;
    this.write(key, value);
  }

  /** Make `sessionId` the active sub-session. No-op if it doesn't exist or is already active. */
  switchActive(key: string, sessionId: string): void {
    const value = this.getValue(key);
    if (!value || !value.sessions[sessionId] || value.active === sessionId) return;
    value.active = sessionId;
    value.sessions[sessionId].lastUsedAt = this.now();
    this.write(key, value);
  }

  /** Record the runtime's native resume id for a sub-session. */
  setResumeId(key: string, sessionId: string, resumeId: string): void {
    const value = this.getValue(key);
    if (!value || !value.sessions[sessionId]) return;
    value.sessions[sessionId].resumeId = resumeId;
    this.write(key, value);
  }

  /** Update the human-readable title for a sub-session. */
  setTitle(key: string, sessionId: string, title: string): void {
    const value = this.getValue(key);
    if (!value || !value.sessions[sessionId]) return;
    value.sessions[sessionId].title = title;
    this.write(key, value);
  }

  /** Mark a sub-session as broken (runtime `--resume` failed). Keep metadata. */
  markBroken(key: string, sessionId: string): void {
    const value = this.getValue(key);
    if (!value || !value.sessions[sessionId]) return;
    value.sessions[sessionId].broken = true;
    this.write(key, value);
  }

  /** Stamp `lastUsedAt = now` on a sub-session. Called after each successful send. */
  touchLastUsed(key: string, sessionId: string): void {
    const value = this.getValue(key);
    if (!value || !value.sessions[sessionId]) return;
    value.sessions[sessionId].lastUsedAt = this.now();
    this.write(key, value);
  }

  private write(key: string, value: SessionStoreValue): void {
    this.inner.set(key, JSON.stringify(value), this.now());
  }
}
