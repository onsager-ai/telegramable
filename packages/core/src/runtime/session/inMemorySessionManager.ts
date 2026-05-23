import { Logger } from "../../logging";
import { FileSessionStore } from "./fileSessionStore";
import { AgentSession, SessionFactory, SessionManager } from "./types";

interface SessionEntry {
  key: string;
  session: AgentSession;
  lastUsedAt: number;
}

interface InMemorySessionManagerOptions {
  sessionTimeoutMs?: number;
  createSession: SessionFactory;
  logger: Logger;
  now?: () => number;
  fileStore?: FileSessionStore;
}

export class InMemorySessionManager implements SessionManager {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly sessionTimeoutMs: number;
  private readonly now: () => number;
  private readonly fileStore?: FileSessionStore;

  constructor(private readonly options: InMemorySessionManagerOptions) {
    this.sessionTimeoutMs = options.sessionTimeoutMs ?? 30 * 60 * 1000;
    this.now = options.now ?? (() => Date.now());
    this.fileStore = options.fileStore;
  }

  getOrCreate(channelId: string, chatId: string, agentName: string): AgentSession {
    this.evictIdleSessions();
    const key = this.key(channelId, chatId, agentName);
    const existing = this.sessions.get(key);

    if (existing) {
      existing.lastUsedAt = this.now();
      return existing.session;
    }

    const session = this.options.createSession(channelId, chatId, agentName);

    // Restore persisted resume ID so the session continues a prior conversation,
    // but skip restoration if the persisted entry is older than sessionTimeoutMs —
    // a stale resume across a restart should reset just like an in-process idle.
    const persisted = this.fileStore?.get(key);
    if (persisted) {
      const idleMs = this.now() - persisted.lastUsedAt;
      if (idleMs > this.sessionTimeoutMs) {
        this.fileStore?.delete(key);
        this.options.logger.debug("Discarded stale persisted session.", {
          sessionId: session.sessionId,
          resumeId: persisted.id,
          idleMs,
          channelId,
          chatId,
          agentName
        });
      } else if (session.setResumeId) {
        session.setResumeId(persisted.id);
        this.options.logger.debug("Restored session resume ID from disk.", {
          sessionId: session.sessionId,
          resumeId: persisted.id,
          channelId,
          chatId,
          agentName
        });
      }
    }

    this.sessions.set(key, {
      key,
      session,
      lastUsedAt: this.now()
    });

    this.options.logger.debug("Created new session.", {
      sessionId: session.sessionId,
      channelId,
      chatId,
      agentName
    });

    return session;
  }

  async close(channelId: string, chatId: string): Promise<void> {
    const keys = Array.from(this.sessions.keys()).filter((key) => {
      const [storedChannelId, storedChatId] = key.split("::");
      return storedChannelId === channelId && storedChatId === chatId;
    });

    await Promise.all(keys.map(async (key) => {
      const entry = this.sessions.get(key);
      if (!entry) {
        return;
      }

      try {
        await entry.session.close();
      } finally {
        this.sessions.delete(key);
      }
    }));
  }

  async closeAll(): Promise<void> {
    const entries = Array.from(this.sessions.values());
    this.sessions.clear();
    await Promise.all(entries.map(async (entry) => entry.session.close()));
  }

  private evictIdleSessions(): void {
    const now = this.now();
    const stale = Array.from(this.sessions.values()).filter((entry) => {
      return now - entry.lastUsedAt > this.sessionTimeoutMs;
    });

    for (const entry of stale) {
      this.sessions.delete(entry.key);
      // Drop the persisted resume ID too — otherwise a restart would restore
      // a session we just decided is stale.
      this.fileStore?.delete(entry.key);
      void entry.session.close().catch((error) => {
        this.options.logger.warn("Failed to close idle session.", {
          sessionId: entry.session.sessionId,
          reason: error instanceof Error ? error.message : "unknown"
        });
      });
      this.options.logger.debug("Evicted idle session.", {
        sessionId: entry.session.sessionId
      });
    }
  }

  private key(channelId: string, chatId: string, agentName: string): string {
    return `${channelId}::${chatId}::${agentName}`;
  }
}
