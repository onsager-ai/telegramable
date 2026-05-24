import { AgentConfig, Config } from "../config";
import { AgentRegistry } from "../hub/agentRegistry";
import { Logger } from "../logging";
import { buildMemoryPrompt } from "../memory";
import { MemoryProvider } from "../memory/provider";
import { CliRuntime } from "./cliRuntime";
import { ClaudeSession } from "./session/claudeSession";
import { CopilotSession } from "./session/copilotSession";
import { FileSessionStore } from "./session/fileSessionStore";
import { GeminiSession } from "./session/geminiSession";
import { InMemorySessionManager } from "./session/inMemorySessionManager";
import { SessionRuntime } from "./session/sessionRuntime";
import { SessionStore } from "./session/sessionStore";
import { Runtime } from "./types";

export interface CreateRuntimeOptions {
  dataDir?: string;
  memoryProvider?: MemoryProvider;
}

export const createRuntime = (agent: AgentConfig, logger: Logger, options?: CreateRuntimeOptions): Runtime => {
  const { dataDir, memoryProvider } = options ?? {};

  // Agent-driven memory inside the main runtime has been retired (#90). Writes are
  // now handled off the user-facing path by the async memory worker (#91); the main
  // runtime only injects facts into the system prompt for reads.
  const canUseAgentDrivenMemory = false;

  logger.info("Runtime memory config.", { agent: agent.name, runtime: agent.runtime || "cli", canUseAgentDrivenMemory, hasMemoryProvider: !!memoryProvider });

  const getSystemPromptSuffix = memoryProvider
    ? () => buildMemoryPrompt(memoryProvider.all(), canUseAgentDrivenMemory)
    : undefined;

  if (!agent.runtime || agent.runtime === "cli") {
    return new CliRuntime(agent, logger, {
      dataDir,
      getSystemPromptSuffix,
      memoryProvider,
      useAgentDrivenMemory: canUseAgentDrivenMemory,
    });
  }

  const fileStore = dataDir ? new FileSessionStore(dataDir, `${agent.runtime}-sessions.json`, logger) : undefined;
  const sessionStore = fileStore ? new SessionStore(fileStore) : undefined;

  const sessionManager = new InMemorySessionManager({
    sessionTimeoutMs: agent.sessionTimeoutMs,
    logger,
    sessionStore,
    createSession: (channelId, chatId) => {
      switch (agent.runtime) {
        case "session-claude":
          return new ClaudeSession(channelId, chatId, agent);
        case "session-gemini":
          return new GeminiSession(channelId, chatId, agent);
        case "session-copilot":
          return new CopilotSession(channelId, chatId, agent);
        default:
          throw new Error(`Unsupported session runtime '${agent.runtime}'.`);
      }
    }
  });

  return new SessionRuntime(agent, sessionManager, logger, {
    sessionStore,
    memoryProvider,
  });
};

export const createAgentRegistry = (config: Config, logger: Logger, memoryProvider?: MemoryProvider): AgentRegistry => {
  const registry = new AgentRegistry(config.defaultAgent);

  for (const agent of config.agents) {
    registry.register(agent.name, createRuntime(agent, logger, { dataDir: config.dataDir, memoryProvider }));
  }

  return registry;
};
