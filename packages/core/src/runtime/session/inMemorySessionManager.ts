import { Logger } from "../../logging";
import { SessionStore } from "./sessionStore";
import { AgentSession, SessionFactory, SessionManager } from "./types";

interface SessionEntry {
  cacheKey: string;
  storeKey: string;
  sessionId: string;
  session: AgentSession;
  lastUsedAt: number;
}

interface InMemorySessionManagerOptions {
  sessionTimeoutMs?: number;
  createSession: SessionFactory;
  logger: Logger;
  now?: () => number;
  /** Multi-session metadata store. When omitted, every getOrCreate uses a synthetic singleton sessionId. */
  sessionStore?: SessionStore;
}

const SINGLETON_SUB_ID = "default";

export class InMemorySessionManager implements SessionManager {
  /** Keyed by `${storeKey}::${sessionId}` so different sub-sessions live as independent AgentSession instances. */
  private readonly sessions = new Map<string, SessionEntry>();
  /** Per-`storeKey` tracker of which sub-session was last acquired. Used to lazily close the prior one on switch. */
  private readonly lastAcquiredSubId = new Map<string, string>();
  private readonly sessionTimeoutMs: number;
  private readonly now: () => number;
  private readonly sessionStore?: SessionStore;

  constructor(private readonly options: InMemorySessionManagerOptions) {
    this.sessionTimeoutMs = options.sessionTimeoutMs ?? 30 * 60 * 1000;
    this.now = options.now ?? (() => Date.now());
    this.sessionStore = options.sessionStore;
  }

  getOrCreate(channelId: string, chatId: string, agentName: string): AgentSession {
    this.evictIdleSessions();
    const storeKey = this.storeKey(channelId, chatId, agentName);

    // Resolve the active sub-session id from the metadata store. If no entry exists
    // yet, fall back to a singleton id so single-session callers still work.
    const active = this.sessionStore?.getActiveSession(storeKey);
    const subId = active?.sessionId ?? SINGLETON_SUB_ID;
    const cacheKey = this.cacheKey(storeKey, subId);

    // Lazy close: if the caller acquired a different sub-session than last time
    // (i.e. switched via /sessions [Switch]), close the previously cached one so
    // its child process / stream state is released. The user may switch back
    // later — we'll recreate it then.
    const prevSubId = this.lastAcquiredSubId.get(storeKey);
    if (prevSubId && prevSubId !== subId) {
      const prevCacheKey = this.cacheKey(storeKey, prevSubId);
      const prev = this.sessions.get(prevCacheKey);
      if (prev) {
        this.sessions.delete(prevCacheKey);
        void prev.session.close().catch((error) => {
          this.options.logger.warn("Failed to close previously active sub-session.", {
            sessionId: prev.session.sessionId,
            reason: error instanceof Error ? error.message : "unknown",
          });
        });
      }
    }
    this.lastAcquiredSubId.set(storeKey, subId);

    const existing = this.sessions.get(cacheKey);
    if (existing) {
      existing.lastUsedAt = this.now();
      return existing.session;
    }

    const session = this.options.createSession(channelId, chatId, agentName);

    // Restore persisted resume ID so the session continues a prior conversation,
    // but skip restoration if the persisted entry is older than sessionTimeoutMs —
    // a stale resume across a restart should reset just like an in-process idle.
    const persistedResume = active?.meta.resumeId;
    const persistedLastUsedAt = active?.meta.lastUsedAt ?? 0;
    if (persistedResume && !active?.meta.broken) {
      const idleMs = this.now() - persistedLastUsedAt;
      if (idleMs > this.sessionTimeoutMs) {
        this.options.logger.debug("Discarded stale persisted session.", {
          sessionId: session.sessionId,
          resumeId: persistedResume,
          idleMs,
          channelId,
          chatId,
          agentName,
        });
      } else if (session.setResumeId) {
        session.setResumeId(persistedResume);
        this.options.logger.debug("Restored session resume ID from disk.", {
          sessionId: session.sessionId,
          resumeId: persistedResume,
          channelId,
          chatId,
          agentName,
        });
      }
    }

    this.sessions.set(cacheKey, {
      cacheKey,
      storeKey,
      sessionId: subId,
      session,
      lastUsedAt: this.now(),
    });

    this.options.logger.debug("Created new session.", {
      sessionId: session.sessionId,
      subSessionId: subId,
      channelId,
      chatId,
      agentName,
    });

    return session;
  }

  async close(channelId: string, chatId: string): Promise<void> {
    const prefix = `${channelId}::${chatId}::`;
    const matches = Array.from(this.sessions.values()).filter((entry) => entry.storeKey.startsWith(prefix));

    await Promise.all(matches.map(async (entry) => {
      this.sessions.delete(entry.cacheKey);
      this.lastAcquiredSubId.delete(entry.storeKey);
      try {
        await entry.session.close();
      } catch {
        // best-effort
      }
    }));
  }

  async closeAll(): Promise<void> {
    const entries = Array.from(this.sessions.values());
    this.sessions.clear();
    this.lastAcquiredSubId.clear();
    await Promise.all(entries.map(async (entry) => entry.session.close()));
  }

  private evictIdleSessions(): void {
    const now = this.now();
    const stale = Array.from(this.sessions.values()).filter((entry) => {
      return now - entry.lastUsedAt > this.sessionTimeoutMs;
    });

    for (const entry of stale) {
      this.sessions.delete(entry.cacheKey);
      if (this.lastAcquiredSubId.get(entry.storeKey) === entry.sessionId) {
        this.lastAcquiredSubId.delete(entry.storeKey);
      }
      void entry.session.close().catch((error) => {
        this.options.logger.warn("Failed to close idle session.", {
          sessionId: entry.session.sessionId,
          reason: error instanceof Error ? error.message : "unknown",
        });
      });
      this.options.logger.debug("Evicted idle session.", {
        sessionId: entry.session.sessionId,
      });
    }
  }

  private storeKey(channelId: string, chatId: string, agentName: string): string {
    return `${channelId}::${chatId}::${agentName}`;
  }

  private cacheKey(storeKey: string, subId: string): string {
    return `${storeKey}::${subId}`;
  }
}
