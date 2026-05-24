import { AgentConfig } from "../../config";
import { EventBus } from "../../events/eventBus";
import { IMMessage } from "../../gateway/types";
import { Logger } from "../../logging";
import { MemoryProvider } from "../../memory/provider";
import { Runtime } from "../types";
import { FileSessionStore } from "./fileSessionStore";
import { SessionStore } from "./sessionStore";
import { SessionManager } from "./types";

export interface SessionRuntimeOptions {
  fileStore?: FileSessionStore;
  sessionStore?: SessionStore;
  memoryProvider?: MemoryProvider;
}

export class SessionRuntime implements Runtime {
  readonly sessionStore?: SessionStore;
  private readonly memoryProvider?: MemoryProvider;

  get agentName(): string {
    return this.config.name;
  }

  constructor(
    private readonly config: AgentConfig,
    private readonly sessionManager: SessionManager,
    private readonly logger: Logger,
    fileStoreOrOptions?: FileSessionStore | SessionRuntimeOptions,
    memoryProvider?: MemoryProvider
  ) {
    // Support legacy positional `(fileStore, memoryProvider)` callers as well as the
    // options-object form. When only a raw FileSessionStore is provided we wrap it
    // so the runtime path always speaks the multi-session API.
    if (fileStoreOrOptions && "get" in fileStoreOrOptions) {
      this.sessionStore = new SessionStore(fileStoreOrOptions);
      this.memoryProvider = memoryProvider;
    } else if (fileStoreOrOptions) {
      const opts = fileStoreOrOptions as SessionRuntimeOptions;
      this.sessionStore = opts.sessionStore ?? (opts.fileStore ? new SessionStore(opts.fileStore) : undefined);
      this.memoryProvider = opts.memoryProvider;
    }
  }

  async execute(message: IMMessage, executionId: string, eventBus: EventBus): Promise<void> {
    const session = this.sessionManager.getOrCreate(
      message.channelId,
      message.chatId,
      this.config.name
    );

    eventBus.emit({
      executionId,
      channelId: message.channelId,
      chatId: message.chatId,
      type: "start",
      timestamp: Date.now(),
      payload: { agentName: this.config.name }
    });

    // Snapshot the resumeId BEFORE the send so we can detect ClaudeSession's silent
    // retry-on-resume-failure path: if `send()` succeeds but `session.resumeId`
    // changed underneath us, the runtime's `--resume <id>` failed and it had to
    // start a fresh native session — that's the signal we mark this sub-session
    // broken so the user gets a clear strikethrough in /sessions instead of a
    // silently-detached conversation.
    const priorResumeId = session.resumeId;
    const storeKey = `${message.channelId}::${message.chatId}::${this.config.name}`;
    const active = this.sessionStore?.getActiveSession(storeKey);

    const response = await session.send(message.text, executionId, eventBus);

    // Persist the session resume ID + last-used stamp onto the active sub-session.
    // If the runtime silently restarted (priorResumeId set but now differs), mark
    // the sub-session broken — the user must /new to recover, per spec.
    if (this.sessionStore && active) {
      if (session.resumeId) {
        this.sessionStore.setResumeId(storeKey, active.sessionId, session.resumeId);
      }
      this.sessionStore.touchLastUsed(storeKey, active.sessionId);

      if (priorResumeId && session.resumeId && session.resumeId !== priorResumeId) {
        this.sessionStore.markBroken(storeKey, active.sessionId);
        this.logger.warn("Session resume failed; marked broken.", {
          executionId,
          storeKey,
          sessionId: active.sessionId,
          priorResumeId,
          newResumeId: session.resumeId,
        });
      }
    }

    if (!response) {
      this.logger.warn("Session returned empty response — runtime may have failed silently.", {
        executionId,
        sessionId: session.sessionId,
        channelId: message.channelId,
        chatId: message.chatId,
        runtime: this.config.runtime
      });
    }

    eventBus.emit({
      executionId,
      channelId: message.channelId,
      chatId: message.chatId,
      type: "complete",
      timestamp: Date.now(),
      payload: { response }
    });

    // Extract memories async — don't block the next user message
    if (response && this.memoryProvider) {
      void this.extractAndSyncMemory(message.text, response).catch((err) => {
        this.logger.warn("Memory extraction failed.", {
          reason: err instanceof Error ? err.message : "unknown",
        });
      });
    }

    this.logger.debug("Session runtime execution completed.", {
      executionId,
      sessionId: session.sessionId,
      channelId: message.channelId,
      chatId: message.chatId,
      runtime: this.config.runtime
    });
  }

  private async extractAndSyncMemory(userText: string, response: string): Promise<void> {
    const changelog = await this.memoryProvider!.ingest(userText, response);

    const parts: string[] = [];

    for (const fact of changelog.added) {
      parts.push(`➕ <code>${fact.id}</code> [${fact.tag}] ${fact.text}`);
    }
    for (const item of changelog.updated) {
      parts.push(`✏️ <code>${item.id}</code> → ${item.text}`);
    }
    for (const item of changelog.removed) {
      parts.push(`🗑️ <code>${item.id}</code> ${item.text}`);
    }

    if (parts.length > 0) {
      await this.memoryProvider!.sendChangelog(
        `<b>🧠 Memory updated</b>\n\n${parts.join("\n")}`
      );
    }
  }
}
