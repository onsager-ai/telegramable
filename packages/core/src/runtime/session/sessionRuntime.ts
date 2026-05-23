import { AgentConfig } from "../../config";
import { EventBus } from "../../events/eventBus";
import { IMMessage } from "../../gateway/types";
import { Logger } from "../../logging";
import { MemoryProvider } from "../../memory/provider";
import { Runtime } from "../types";
import { FileSessionStore } from "./fileSessionStore";
import { SessionManager } from "./types";

export interface SessionRuntimeOptions {
  fileStore?: FileSessionStore;
  memoryProvider?: MemoryProvider;
}

export class SessionRuntime implements Runtime {
  private readonly fileStore?: FileSessionStore;
  private readonly memoryProvider?: MemoryProvider;

  constructor(
    private readonly config: AgentConfig,
    private readonly sessionManager: SessionManager,
    private readonly logger: Logger,
    fileStoreOrOptions?: FileSessionStore | SessionRuntimeOptions,
    memoryProvider?: MemoryProvider
  ) {
    // Support both old signature (fileStore, memoryProvider) and new options object
    if (fileStoreOrOptions && "get" in fileStoreOrOptions) {
      this.fileStore = fileStoreOrOptions;
      this.memoryProvider = memoryProvider;
    } else if (fileStoreOrOptions) {
      const opts = fileStoreOrOptions as SessionRuntimeOptions;
      this.fileStore = opts.fileStore;
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

    const response = await session.send(message.text, executionId, eventBus);

    // Persist the session resume ID so conversations survive restarts.
    // Stamp lastUsedAt so the next process can apply idle eviction across restarts.
    if (session.resumeId && this.fileStore) {
      const storeKey = `${message.channelId}::${message.chatId}::${this.config.name}`;
      this.fileStore.set(storeKey, session.resumeId, Date.now());
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
