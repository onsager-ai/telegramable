import { Bot } from "grammy";
import { loadConfig } from "./config";
import { ChannelConfig } from "./config";
import { EventBus } from "./events/eventBus";
import { TelegramAdapter } from "./gateway/telegramAdapter";
import { IMAdapter } from "./gateway/types";
import { ChannelHub, MemoryChannelInfo } from "./hub/hub";
import { DefaultRouter } from "./hub/router";
import { createLogger } from "./logging";
import { MemoryExtractor } from "./memory/extractor";
import { Mem0MemoryProvider } from "./memory/mem0Provider";
import { MemoryProvider } from "./memory/provider";
import { MemoryRefiner } from "./memory/refiner";
import { MemoryRefinementScheduler } from "./memory/scheduler";
import { MemorySync } from "./memory/sync";
import { TelegramMemoryProvider } from "./memory/telegramProvider";
import { IdleScheduler } from "./memory/worker/idleScheduler";
import { MemoryWorker } from "./memory/worker/memoryWorker";
import { PendingTurnsStore } from "./memory/worker/persistence";
import { MemoryWorkerQueue } from "./memory/worker/workerQueue";
import { createAgentRegistry } from "./runtime";
import { FileSessionStore } from "./runtime/session/fileSessionStore";

export { loadConfig, loadEnv } from "./config";

const createAdapter = (channel: ChannelConfig, logger: ReturnType<typeof createLogger>): IMAdapter => {
  if (channel.type === "telegram") {
    if (typeof channel.token !== "string" || channel.token.length === 0) {
      throw new Error(`Telegram channel '${channel.id}' is missing token.`);
    }

    return new TelegramAdapter(channel.id, channel.token, logger, channel.allowedUserIds);
  }

  throw new Error(`Unsupported channel type '${channel.type}' for channel '${channel.id}'.`);
};

export async function startDaemon(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const eventBus = new EventBus();

  if (config.channels.length === 0) {
    throw new Error("At least one channel must be configured.");
  }

  if (config.agents.length === 0) {
    throw new Error("At least one agent must be configured.");
  }

  // Initialize memory system if configured
  let memoryProvider: MemoryProvider | undefined;
  let memorySync: MemorySync | undefined;
  let memoryChannelInfo: MemoryChannelInfo | undefined;

  logger.info("Memory configuration.", { enabled: !!config.memory?.enabled, provider: config.memory?.provider, hasChatId: !!config.memory?.chatId, hasExtraction: !!config.memory?.extraction });

  if (config.memory?.enabled) {
    try {
      if (config.memory.provider === "mem0" && config.memory.mem0) {
        // Mem0 provider — no Telegram dependency for storage
        memoryProvider = new Mem0MemoryProvider({
          apiKey: config.memory.mem0.apiKey,
          baseUrl: config.memory.mem0.baseUrl,
          userId: config.memory.mem0.userId || "default",
        }, logger);

        await memoryProvider.load();
        logger.info("Memory provider initialized.", { provider: "mem0" });
      } else if (config.memory.provider === "mem0") {
        // mem0 selected but config incomplete (missing API key)
        logger.warn("MEMORY_PROVIDER=mem0 but MEM0_API_KEY is missing — skipping memory.");
      } else {
        // Telegram provider (default) — needs a Bot instance for MemorySync
        const telegramChannel = config.channels.find((ch) => ch.type === "telegram");
        if (!telegramChannel || typeof telegramChannel.token !== "string") {
          logger.warn("Memory enabled but no Telegram channel configured — skipping memory.");
        } else {
          const memBot = new Bot(telegramChannel.token);
          await memBot.init();

          // Resolve @username to numeric chat ID if needed.
          const rawChatId = config.memory.chatId;
          if (rawChatId.startsWith("@") || !/^-?\d+$/.test(rawChatId)) {
            const cacheStore = config.dataDir
              ? new FileSessionStore(config.dataDir, "memory-chat-ids.json", logger)
              : undefined;
            if (!cacheStore) {
              logger.warn(
                "No DATA_DIR configured — resolved memory chat IDs will not persist across restarts. " +
                "Set DATA_DIR or use a numeric chat ID to avoid re-resolution.",
                { rawChatId }
              );
            }
            const cached = cacheStore?.get(rawChatId);

            if (typeof cached === "string" && /^-?\d+$/.test(cached)) {
              config.memory.chatId = cached;
              logger.info("Using cached memory chat ID.", { from: rawChatId, to: cached });
              memoryChannelInfo = { resolvedChatId: cached, rawChatId, cacheSource: "cached", cacheStore };
            } else {
              if (cached != null) {
                logger.warn("Ignoring invalid cached memory chat ID.", { from: rawChatId, cached });
              }
              const chat = await memBot.api.getChat(rawChatId);
              config.memory.chatId = String(chat.id);
              cacheStore?.set(rawChatId, String(chat.id));
              logger.info("Resolved memory chat.", { from: rawChatId, to: chat.id });
              memoryChannelInfo = { resolvedChatId: String(chat.id), rawChatId, cacheSource: "resolved", cacheStore };
            }
          } else {
            memoryChannelInfo = { resolvedChatId: rawChatId, cacheSource: "direct" };
          }

          memorySync = new MemorySync(memBot, config.memory, logger);

          const extractor = config.memory.extraction
            ? new MemoryExtractor(config.memory.extraction, logger)
            : undefined;

          if (config.memory.extraction) {
            logger.info("Memory extraction enabled.", { provider: config.memory.extraction.provider, model: config.memory.extraction.model });
          } else {
            logger.info("No extraction LLM configured — set ANTHROPIC_API_KEY or OPENAI_BASE_URL + OPENAI_API_KEY to enable automatic memory extraction.");
          }

          const telegramProvider = new TelegramMemoryProvider(memorySync, extractor, logger);
          await telegramProvider.load();

          memoryProvider = telegramProvider;
          logger.info("Memory provider initialized.", { provider: "telegram", facts: telegramProvider.all().length });
        }
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown";
      logger.warn("Memory initialization failed — continuing without memory.", { reason });
      memoryProvider = undefined;
      memorySync = undefined;
      memoryChannelInfo = undefined;
    }
  }

  // Initialize memory refinement scheduler if configured
  let refinementScheduler: MemoryRefinementScheduler | undefined;
  if (memoryProvider && config.memory?.refinement) {
    const refiner = new MemoryRefiner(logger, config.memory.refinement.model);
    refinementScheduler = new MemoryRefinementScheduler(
      memoryProvider,
      refiner,
      config.memory.refinement,
      logger,
    );
    refinementScheduler.start();
    logger.info("Memory refinement scheduler initialized.", {
      intervalMs: config.memory.refinement.intervalMs,
      factThreshold: config.memory.refinement.factThreshold,
    });
  }

  logger.info("Creating agent registry.", { hasMemoryProvider: !!memoryProvider });
  const registry = createAgentRegistry(config, logger, memoryProvider);

  const adapters = config.channels.map((channel) => createAdapter(channel, logger));
  const router = new DefaultRouter(config.channels, registry);

  // Async memory worker (#91/#92) — only when we have a Telegram memory provider,
  // since the worker drives the MCP-backed flow that mutates pinned-message
  // memory state.  Other providers (mem0) don't yet have a worker.
  let memoryWorkerWiring: { scheduler: IdleScheduler; queue: MemoryWorkerQueue; runner: MemoryWorker } | undefined;
  if (memoryProvider instanceof TelegramMemoryProvider) {
    const claudeAgent = config.agents.find((a) => !a.runtime || a.runtime === "cli");
    const claudeCommand = process.env.MEMORY_WORKER_CMD || claudeAgent?.command || "claude";
    const persistence = config.dataDir
      ? new PendingTurnsStore(`${config.dataDir}/memory-snapshots`, logger)
      : undefined;
    if (!persistence) {
      logger.warn("No DATA_DIR configured — memory worker pendingTurns will not survive process restarts.");
    }
    const runner = new MemoryWorker({
      provider: memoryProvider,
      claudeCommand,
      logger,
      dataDir: config.dataDir,
    });
    const scheduler = new IdleScheduler({ logger, persistence });
    const queue = new MemoryWorkerQueue(runner, scheduler, { logger, persistence });
    memoryWorkerWiring = { scheduler, queue, runner };
    logger.info("Memory worker wired.", { claudeCommand, persistence: !!persistence });
  }

  const hub = new ChannelHub(
    adapters,
    router,
    eventBus,
    logger,
    undefined,
    memoryProvider,
    memoryChannelInfo,
    memorySync,
    refinementScheduler,
    memoryWorkerWiring,
  );

  await hub.start();

  const shutdown = async () => {
    logger.info("Shutting down...");
    refinementScheduler?.stop();
    await hub.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
