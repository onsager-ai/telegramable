import { randomUUID } from "crypto";
import { spawn } from "child_process";
import { existsSync, writeFileSync, readFileSync, unlinkSync, mkdtempSync, chmodSync, rmdirSync, openSync, closeSync, constants as fsConstants } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { AgentConfig } from "../config";
import { EventBus } from "../events/eventBus";
import { ToolResult } from "../events/types";
import { IMMessage } from "../gateway/types";
import { Logger } from "../logging";
import type { MemorySnapshot } from "../memory";
import { MemoryProvider } from "../memory/provider";
import { TelegramMemoryProvider } from "../memory/telegramProvider";
import { Runtime } from "./types";
import { FileSessionStore } from "./session/fileSessionStore";

export interface CliRuntimeOptions {
  dataDir?: string;
  /** Returns an additional system prompt section at call time (e.g. memory facts). */
  getSystemPromptSuffix?: () => string;
  memoryProvider?: MemoryProvider;
  /** When true, attach the memory MCP stdio server to the CLI via --mcp-config. */
  useAgentDrivenMemory?: boolean;
}

export class CliRuntime implements Runtime {
  /** Map of "channelId::chatId" → Claude CLI session ID for conversation continuity. */
  private readonly sessions = new Map<string, string>();
  /** Per-session execution queue to serialize sequential messages and prevent concurrent CLI processes on the same session. */
  private readonly executionQueues = new Map<string, Promise<void>>();
  private readonly fileStore?: FileSessionStore;
  private readonly getSystemPromptSuffix?: () => string;
  private readonly memoryProvider?: MemoryProvider;
  private readonly useAgentDrivenMemory: boolean;

  /** Resolve the path to the compiled memoryMcpStdio.js once. */
  private memoryMcpStdioPath?: string;

  /** Prevent repeated root-fallback warnings from flooding logs. */
  private rootWarningLogged = false;

  /** Track in-flight tool blocks to accumulate input from input_json_delta. */
  private pendingToolBlocks = new Map<string, { name: string; inputJson: string; index: number; toolUseId?: string }>(); // executionId → current block

  /** Track in-flight thinking blocks to accumulate thinking text from thinking_delta. */
  private pendingThinkingBlocks = new Map<string, { index: number; text: string }>(); // executionId → current thinking block

  /** Clean up pending block state for an execution (e.g. on close/error/timeout). */
  private cleanupPendingBlocks(executionId: string): void {
    this.pendingToolBlocks.delete(executionId);
    this.pendingThinkingBlocks.delete(executionId);
  }

  /** Resolved output format — defaults to stream-json inside CliRuntime. */
  private get resolvedOutputFormat(): "text" | "json" | "stream-json" {
    return this.config.outputFormat ?? "stream-json";
  }

  constructor(private readonly config: AgentConfig, private readonly logger: Logger, options?: CliRuntimeOptions) {
    if (options?.dataDir) {
      this.fileStore = new FileSessionStore(options.dataDir, "cli-sessions.json", logger);
    }
    this.getSystemPromptSuffix = options?.getSystemPromptSuffix;
    this.memoryProvider = options?.memoryProvider;
    this.useAgentDrivenMemory = options?.useAgentDrivenMemory ?? false;

    // Warn about config fields that are silently ignored by the CLI runtime.
    // These fields exist on AgentConfig for other runtimes (SDK, session-claude)
    // but the CLI runtime always uses bypassPermissions.
    if (config.permissionMode && config.permissionMode !== "bypassPermissions") {
      this.logger.warn("CLI runtime ignores PERMISSION_MODE — always uses bypassPermissions (non-root) or auto (root).", { configured: config.permissionMode });
    }
    if (config.allowedTools?.length) {
      this.logger.warn("CLI runtime ignores ALLOWED_TOOLS — bypassPermissions approves all tools.", { tools: config.allowedTools });
    }
    if (config.disallowedTools?.length) {
      this.logger.warn("CLI runtime ignores DISALLOWED_TOOLS — bypassPermissions approves all tools.", { tools: config.disallowedTools });
    }
  }

  /**
   * Parse the command string into an executable and its initial arguments.
   * e.g. "claude --print" → { executable: "claude", initialArgs: ["--print"] }
   */
  private parseCommand(): { executable: string; initialArgs: string[] } {
    const parts = this.config.command!.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) {
      throw new Error("Agent command is empty.");
    }
    return { executable: parts[0], initialArgs: parts.slice(1) };
  }

  /** Build CLI args from AgentConfig (model, tools, permissions, etc.). */
  private buildConfigArgs(): string[] {
    const args: string[] = [];

    if (this.config.model) {
      args.push("--model", this.config.model);
    }

    // Append the user-configured system prompt (SYSTEM_PROMPT env var)
    if (this.config.systemPrompt) {
      args.push("--append-system-prompt", this.config.systemPrompt);
    }

    // Append memory facts and (optionally) memory tool instructions
    const memorySuffix = this.getSystemPromptSuffix?.() || "";
    if (memorySuffix) {
      args.push("--append-system-prompt", memorySuffix);
    }

    // Always use bypassPermissions — the container runs as non-root (claude user),
    // and no proper HITL flow exists for interactive approval in --print mode.
    // The root guard remains as a safety net for misconfigured environments.
    if (process.getuid?.() === 0) {
      if (!this.rootWarningLogged) {
        this.rootWarningLogged = true;
        this.logger.warn(
          "bypassPermissions is not allowed as root — falling back to 'auto'. " +
          "Run the container as a non-root user to use bypassPermissions."
        );
      }
      args.push("--permission-mode", "auto");
    } else {
      args.push("--permission-mode", "bypassPermissions");
    }

    if (this.config.maxTurns != null) {
      args.push("--max-turns", String(this.config.maxTurns));
    }

    if (this.config.maxBudgetUsd != null) {
      args.push("--max-budget-usd", String(this.config.maxBudgetUsd));
    }

    args.push("--output-format", this.resolvedOutputFormat);

    // When using stream-json, we need --verbose and --include-partial-messages
    // so the CLI emits streaming events (tool_use, text_delta, etc.) rather
    // than just the final result.
    if (this.resolvedOutputFormat === "stream-json") {
      args.push("--verbose", "--include-partial-messages");
    }

    if (this.config.bare) {
      args.push("--bare");
    }

    return args;
  }

  /** Resolve the path to the compiled memoryMcpStdio.js script. */
  private resolveMemoryMcpStdioPath(): string {
    if (this.memoryMcpStdioPath) return this.memoryMcpStdioPath;
    // The script is compiled alongside this file in the core package dist
    this.memoryMcpStdioPath = join(__dirname, "..", "memory", "memoryMcpStdio.js");
    return this.memoryMcpStdioPath;
  }

  /**
   * Write a temporary MCP config file and memory state file for the CLI subprocess.
   * Returns paths and a baseline snapshot so changes can be diffed correctly even
   * when concurrent executions mutate the shared in-process MemoryStore.
   */
  private prepareMcpConfig(executionId: string): { mcpDir: string; mcpConfigPath: string; stateFilePath: string; baseline: MemorySnapshot } | null {
    if (!this.useAgentDrivenMemory) {
      this.logger.debug("Agent-driven memory disabled, skipping MCP config.", { executionId, hasMemoryProvider: !!this.memoryProvider });
      return null;
    }
    // CLI MCP stdio requires a TelegramMemoryProvider with direct MemoryStore access
    const telegramProvider = this.memoryProvider instanceof TelegramMemoryProvider ? this.memoryProvider : undefined;
    if (!telegramProvider) {
      this.logger.debug("Agent-driven memory via CLI MCP is only supported with telegram provider, skipping.", { executionId });
      return null;
    }

    const stdioScript = this.resolveMemoryMcpStdioPath();
    if (!existsSync(stdioScript)) {
      this.logger.warn("Memory MCP stdio script not found, skipping agent-driven memory for CLI.", { path: stdioScript });
      return null;
    }

    // Create a per-execution temp directory with restrictive permissions (0o700)
    const mcpDir = mkdtempSync(join(tmpdir(), `telegramable-mcp-${executionId}-`));
    chmodSync(mcpDir, 0o700);

    const stateFilePath = join(mcpDir, "memory-state.json");
    const mcpConfigPath = join(mcpDir, "mcp-config.json");

    // Capture baseline snapshot before spawning — used for diffing later
    const baseline = telegramProvider.store.snapshot();

    // Write files with restrictive permissions (0o600) via O_EXCL to prevent symlink attacks
    const writeSecure = (path: string, data: string): void => {
      const fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
      try {
        writeFileSync(fd, data, "utf-8");
      } finally {
        closeSync(fd);
      }
    };

    writeSecure(stateFilePath, JSON.stringify(baseline, null, 2));

    // Write MCP config pointing to the stdio script.
    // Use process.execPath for the absolute Node.js binary path — bare "node" may not
    // resolve correctly when the Claude CLI spawns the MCP server subprocess, especially
    // in Docker containers where PATH may differ between execution contexts.
    const mcpConfig = {
      mcpServers: {
        memory: {
          command: process.execPath,
          args: [stdioScript, stateFilePath],
        },
      },
    };
    writeSecure(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));

    this.logger.info("Prepared MCP config for CLI memory tools.", { mcpDir, executionId, nodePath: process.execPath, stdioScript });
    return { mcpDir, mcpConfigPath, stateFilePath, baseline };
  }

  /**
   * Read back memory state from the temp file, diff against the baseline snapshot
   * captured at prepare time, and apply only the subprocess's changes to the live store.
   * Diffing against the baseline (not the live store) avoids misclassifying changes
   * when concurrent executions mutate the shared MemoryStore.
   */
  private async syncMemoryFromFile(stateFilePath: string, baseline: MemorySnapshot): Promise<void> {
    const telegramProvider = this.memoryProvider instanceof TelegramMemoryProvider ? this.memoryProvider : undefined;
    if (!telegramProvider) return;

    try {
      const raw = readFileSync(stateFilePath, "utf-8");
      const afterSnapshot: MemorySnapshot = JSON.parse(raw);
      if (!afterSnapshot.v || !Array.isArray(afterSnapshot.facts)) return;

      // Build lookup maps from baseline and subprocess result
      const baselineMap = new Map(baseline.facts.map((f) => [f.id, f]));
      const afterMap = new Map(afterSnapshot.facts.map((f) => [f.id, f]));

      const changelogParts: string[] = [];

      const store = telegramProvider.store;

      // Detect facts added by the subprocess (in after but not in baseline)
      for (const fact of afterSnapshot.facts) {
        if (!baselineMap.has(fact.id)) {
          const added = store.add(fact.tag, fact.text);
          changelogParts.push(`➕ <code>${added.id}</code> [${fact.tag}] ${fact.text}`);
        }
      }

      // Detect facts updated by the subprocess (in both, but text differs)
      for (const [id, baseFact] of baselineMap) {
        const afterFact = afterMap.get(id);
        if (afterFact && afterFact.text !== baseFact.text) {
          store.update(id, afterFact.text);
          changelogParts.push(`✏️ <code>${id}</code> → ${afterFact.text}`);
        }
      }

      // Detect facts removed by the subprocess (in baseline but not in after)
      for (const [id, baseFact] of baselineMap) {
        if (!afterMap.has(id)) {
          store.remove(id);
          changelogParts.push(`🗑️ <code>${id}</code> ${baseFact.text}`);
        }
      }

      if (changelogParts.length === 0) return;

      // Persist mutated store back to Telegram pinned message
      await telegramProvider.syncToTelegram();
      await telegramProvider.sendChangelog(
        `<b>🧠 Memory updated</b>\n\n${changelogParts.join("\n")}`,
      );

      this.logger.info("Memory synced from CLI MCP state file.", { changes: changelogParts.length });
    } catch (err) {
      this.logger.warn("Failed to sync memory from CLI MCP state file.", {
        reason: err instanceof Error ? err.message : "unknown",
      });
    }
  }

  /** Clean up temporary MCP directory and its files. */
  private cleanupMcpFiles(mcpDir: string, mcpConfigPath: string, stateFilePath: string): void {
    try { unlinkSync(mcpConfigPath); } catch { /* ignore */ }
    try { unlinkSync(stateFilePath); } catch { /* ignore */ }
    try { rmdirSync(mcpDir); } catch { /* ignore */ }
  }

  async execute(message: IMMessage, executionId: string, eventBus: EventBus): Promise<void> {
    const queueKey = `${message.channelId}::${message.chatId}`;
    const prev = this.executionQueues.get(queueKey) ?? Promise.resolve();

    // If there's a pending execution for this session, emit a "queued" event
    // so the hub can show the user their message is waiting (e.g. via reaction).
    if (this.executionQueues.has(queueKey)) {
      eventBus.emit({
        executionId,
        channelId: message.channelId,
        chatId: message.chatId,
        type: "queued",
        timestamp: Date.now(),
        payload: { messageId: message.messageId }
      });
    }

    const next = prev.then(
      () => this._execute(message, executionId, eventBus, false),
      () => this._execute(message, executionId, eventBus, false)
    );
    this.executionQueues.set(queueKey, next.catch(() => {}));
    return next;
  }

  private async _execute(message: IMMessage, executionId: string, eventBus: EventBus, isRetry: boolean): Promise<void> {
    if (!this.config.command) {
      throw new Error("Agent command is required for cli runtime.");
    }

    if (!isRetry) {
      eventBus.emit({
        executionId,
        channelId: message.channelId,
        chatId: message.chatId,
        type: "start",
        timestamp: Date.now(),
        payload: { agentName: this.config.name, messageId: message.messageId }
      });
    }

    // Prepare MCP config for agent-driven memory (if enabled)
    const mcpFiles = this.prepareMcpConfig(executionId);

    return new Promise((resolve, reject) => {
      const sessionKey = `${message.channelId}::${message.chatId}`;
      const existingSessionId = isRetry ? undefined : (this.sessions.get(sessionKey) || this.fileStore?.get(sessionKey));

      const { executable, initialArgs } = this.parseCommand();

      // Build args: command initial args → configured args → config-derived flags → session flags → prompt
      const args = [
        ...initialArgs,
        ...(this.config.args || []),
        ...this.buildConfigArgs()
      ];

      // Attach memory MCP server if prepared
      if (mcpFiles) {
        args.push("--mcp-config", mcpFiles.mcpConfigPath);
      }

      if (existingSessionId) {
        args.push("--resume", existingSessionId);
        // Ensure in-memory map is populated (may have been loaded from file store)
        this.sessions.set(sessionKey, existingSessionId);
      } else {
        const newSessionId = randomUUID();
        this.sessions.set(sessionKey, newSessionId);
        this.fileStore?.set(sessionKey, newSessionId);
        args.push("--session-id", newSessionId);
      }

      // Pass prompt as a positional argument (after "--" to prevent flag interpretation).
      // This avoids stdin pipe race conditions where the child process may not be ready
      // to read stdin, causing EPIPE errors.
      args.push("--", message.text);

      const child = spawn(executable, args, {
        cwd: this.config.workingDir,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          ...(this.config.env || {}),
          // Pass channel/chat context so the sudo wrapper can route
          // permission requests back to the correct Telegram chat.
          TELEGRAMABLE_CHANNEL_ID: message.channelId,
          TELEGRAMABLE_CHAT_ID: message.chatId,
        }
      });

      const stdoutChunks: string[] = [];
      const stderrChunks: string[] = [];
      let receivedAnyOutput = false;
      const timeoutMs = this.config.timeoutMs ?? 10 * 60 * 1000;

      // Periodic "still alive" logging to diagnose hangs
      const heartbeat = setInterval(() => {
        this.logger.warn("CLI runtime still running — no exit yet.", {
          executionId,
          pid: child.pid,
          receivedAnyOutput,
          stdoutBytes: stdoutChunks.join("").length,
          stderrBytes: stderrChunks.join("").length
        });
      }, 30_000);

      // Activity-based timeout: resets on each stdout/stderr chunk so
      // long-running but active processes don't get killed.
      let timeout: NodeJS.Timeout;
      // Cleanup helper — safe to call multiple times.
      let permissionUnsub: (() => void) | undefined;
      const cleanupPermissionSub = () => { permissionUnsub?.(); permissionUnsub = undefined; };

      const resetTimeout = () => {
        clearTimeout(timeout);
        timeout = setTimeout(() => {
          child.kill("SIGKILL");
          cleanupPermissionSub();
          this.cleanupPendingBlocks(executionId);
          if (mcpFiles) this.cleanupMcpFiles(mcpFiles.mcpDir, mcpFiles.mcpConfigPath, mcpFiles.stateFilePath);
          this.logger.error("CLI runtime timeout — killing process.", {
            executionId,
            pid: child.pid,
            timeoutMs,
            receivedAnyOutput,
            stderr: stderrChunks.join("").slice(0, 500)
          });
          eventBus.emit({
            executionId,
            channelId: message.channelId,
            chatId: message.chatId,
            type: "error",
            timestamp: Date.now(),
            payload: { reason: "Runtime timeout." }
          });
          reject(new Error("Runtime timeout."));
        }, timeoutMs);
      };
      resetTimeout();

      // Subscribe to permission events so the timeout resets while waiting
      // for the user to approve/deny sudo requests via Telegram.  The child
      // process produces no stdout/stderr during that wait, so without this
      // the inactivity timeout would fire and kill a legitimately active run.
      permissionUnsub = eventBus.on((event) => {
        if (
          (event.type === "permission-request" || event.type === "permission-response") &&
          event.channelId === message.channelId &&
          event.chatId === message.chatId
        ) {
          resetTimeout();
        }
      });

      // When using stream-json, we need to buffer partial lines because
      // chunks may split across JSON line boundaries.
      let ndjsonBuffer = "";

      child.stdout?.on("data", (chunk: Buffer) => {
        receivedAnyOutput = true;
        resetTimeout(); // Reset inactivity timeout on output
        const text = chunk.toString();
        stdoutChunks.push(text);

        if (this.resolvedOutputFormat === "stream-json") {
          // Parse NDJSON: buffer incoming text, process complete lines
          ndjsonBuffer += text;
          const lines = ndjsonBuffer.split("\n");
          // Keep the last (potentially incomplete) line in the buffer
          ndjsonBuffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const parsed = JSON.parse(trimmed);
              this.handleStreamJsonEvent(parsed, executionId, message, eventBus);
            } catch {
              // Not valid JSON — emit as raw text (e.g. startup messages)
              eventBus.emit({
                executionId,
                channelId: message.channelId,
                chatId: message.chatId,
                type: "stream-text",
                timestamp: Date.now(),
                payload: { text: trimmed }
              });
            }
          }
        } else {
          eventBus.emit({
            executionId,
            channelId: message.channelId,
            chatId: message.chatId,
            type: "stream-text",
            timestamp: Date.now(),
            payload: { text }
          });
        }
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        receivedAnyOutput = true;
        resetTimeout(); // Reset inactivity timeout on output
        const text = chunk.toString();
        stderrChunks.push(text);
        this.logger.warn("CLI stderr output.", { executionId, text: text.slice(0, 500) });
        eventBus.emit({
          executionId,
          channelId: message.channelId,
          chatId: message.chatId,
          type: "stderr",
          timestamp: Date.now(),
          payload: { text }
        });
      });

      child.on("error", (error: NodeJS.ErrnoException) => {
        clearTimeout(timeout);
        clearInterval(heartbeat);
        cleanupPermissionSub();
        this.cleanupPendingBlocks(executionId);
        if (mcpFiles) this.cleanupMcpFiles(mcpFiles.mcpDir, mcpFiles.mcpConfigPath, mcpFiles.stateFilePath);
        let reason = error.message;
        if (error.code === "ENOENT") {
          reason = this.config.workingDir && !existsSync(this.config.workingDir)
            ? `Working directory not found: ${this.config.workingDir}`
            : `Command not found: "${executable}". Ensure it is installed and available in PATH.`;
        }
        this.logger.error("CLI runtime process error.", { executionId, reason, code: error.code });
        eventBus.emit({
          executionId,
          channelId: message.channelId,
          chatId: message.chatId,
          type: "error",
          timestamp: Date.now(),
          payload: { reason }
        });
        reject(new Error(reason));
      });

      child.on("close", (code: number | null) => {
        clearTimeout(timeout);
        clearInterval(heartbeat);
        cleanupPermissionSub();

        // Flush any remaining NDJSON buffer (last line without trailing newline)
        if (this.resolvedOutputFormat === "stream-json" && ndjsonBuffer.trim()) {
          try {
            const parsed = JSON.parse(ndjsonBuffer.trim());
            this.handleStreamJsonEvent(parsed, executionId, message, eventBus);
          } catch {
            // Not valid JSON — ignore on close
          }
          ndjsonBuffer = "";
        }

        const stderr = stderrChunks.join("").trim();

        this.logger.info("CLI runtime exited.", {
          executionId,
          pid: child.pid,
          exitCode: code,
          stdoutBytes: stdoutChunks.join("").length,
          stderrBytes: stderr.length,
          stderr: stderr.slice(0, 500) || undefined
        });

        // Exit code 127 means the shell could not find the command
        if (code === 127) {
          if (mcpFiles) this.cleanupMcpFiles(mcpFiles.mcpDir, mcpFiles.mcpConfigPath, mcpFiles.stateFilePath);
          const reason = `Command not found: "${executable}". Ensure it is installed and available in PATH.`;
          eventBus.emit({
            executionId,
            channelId: message.channelId,
            chatId: message.chatId,
            type: "error",
            timestamp: Date.now(),
            payload: { reason }
          });
          reject(new Error(reason));
          return;
        }

        // If the CLI failed, clear the session so the next attempt starts fresh
        if (code !== 0) {
          this.logger.warn("CLI runtime exited with non-zero code.", {
            executionId,
            exitCode: code,
            stderr: stderr.slice(0, 1000) || undefined
          });
          this.sessions.delete(sessionKey);
          this.fileStore?.delete(sessionKey);

          // If this was a resumed session that failed because the conversation
          // no longer exists, transparently retry with a fresh session.
          if (existingSessionId && !isRetry && /no conversation found/i.test(stderr)) {
            if (mcpFiles) this.cleanupMcpFiles(mcpFiles.mcpDir, mcpFiles.mcpConfigPath, mcpFiles.stateFilePath);
            this.logger.info("Retrying with fresh session after stale resume ID.", { executionId, staleSessionId: existingSessionId });
            resolve(this._execute(message, executionId, eventBus, true));
            return;
          }
        }

        const rawOutput = stdoutChunks.join("").trim();

        // When using stream-json, extract the text result from the NDJSON output.
        // The raw stdout is NDJSON lines, not the actual response text.
        let response: string;
        if (this.resolvedOutputFormat === "stream-json") {
          response = this.extractResultFromStreamJson(rawOutput);
        } else {
          response = rawOutput;
        }

        if (!response && code === 0) {
          this.logger.warn("CLI runtime exited successfully but produced no stdout output.", { executionId });
        }

        // Clean up any in-flight block state (in case the CLI exited mid-block)
        this.cleanupPendingBlocks(executionId);

        eventBus.emit({
          executionId,
          channelId: message.channelId,
          chatId: message.chatId,
          type: "complete",
          timestamp: Date.now(),
          payload: { code: code ?? null, response: response || undefined }
        });

        // Clean up MCP files if they were prepared (paused but kept for the
        // async memory worker — #91 reuses this wire-up inside a subprocess).
        if (mcpFiles) {
          this.cleanupMcpFiles(mcpFiles.mcpDir, mcpFiles.mcpConfigPath, mcpFiles.stateFilePath);
        }

        // Memory writes have moved off the user-facing path. The async memory worker
        // (#91) subscribes to `turn-complete` and dispatches a subprocess on idle.
        if (code === 0 && response) {
          eventBus.emit({
            executionId,
            channelId: message.channelId,
            chatId: message.chatId,
            type: "turn-complete",
            timestamp: Date.now(),
            payload: { userText: message.text, response }
          });
        }

        resolve();
      });

      this.logger.info("Spawned CLI runtime.", {
        executionId,
        command: this.config.command,
        fullArgs: args.slice(0, -1).join(" "),  // omit user prompt for brevity
        sessionId: this.sessions.get(sessionKey),
        resumed: !!existingSessionId,
        pid: child.pid,
        hasOAuthToken: !!process.env.CLAUDE_CODE_OAUTH_TOKEN,
        hasApiKey: !!process.env.ANTHROPIC_API_KEY,
        cwd: this.config.workingDir || "(inherited)",
        memoryMcp: mcpFiles ? "attached" : "none",
        mcpConfigPath: mcpFiles?.mcpConfigPath
      });
    });
  }

  /**
   * Extract the final text result from stream-json NDJSON output.
   * Looks for the "result" line which contains the final response text,
   * falls back to accumulating text from assistant message content blocks,
   * and finally returns the raw output if no JSON was parsed.
   */
  private extractResultFromStreamJson(rawOutput: string): string {
    const lines = rawOutput.split("\n");
    let hasAnyJson = false;

    // Try to find a "result" message which contains the final text
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        hasAnyJson = true;
        if (parsed.type === "result" && typeof parsed.result === "string") {
          return parsed.result;
        }
      } catch {
        // skip non-JSON lines
      }
    }

    // Fallback: accumulate text from assistant messages
    const texts: string[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed.type === "assistant") {
          const content = parsed.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "text" && typeof block.text === "string") {
                texts.push(block.text);
              }
            }
          }
        }
      } catch {
        // skip
      }
    }
    if (texts.length > 0) return texts.join("\n");

    // No JSON found at all (e.g. non-Claude command) — return raw output
    if (!hasAnyJson) return rawOutput;

    return "";
  }

  /**
   * Process a parsed NDJSON event from `--output-format stream-json`.
   *
   * Claude Code CLI emits wrapper objects like:
   *   { type: "stream_event", event: { type: "content_block_start", content_block: { type: "tool_use", name: "Read", ... } } }
   *   { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "..." } } }
   *   { type: "assistant", message: { ... } }   — complete assistant turn
   *   { type: "result", ... }                    — final result
   */
  private handleStreamJsonEvent(
    parsed: Record<string, unknown>,
    executionId: string,
    message: IMMessage,
    eventBus: EventBus,
  ): void {
    const type = parsed.type as string | undefined;

    if (type === "stream_event") {
      const event = parsed.event as Record<string, unknown> | undefined;
      if (!event) return;
      const eventType = event.type as string | undefined;

      // parent_tool_use_id is set on events originating from a subagent context.
      // We thread it through to emitted events so the hub can display them differently.
      const parentToolUseId = (parsed.parent_tool_use_id as string | undefined) || undefined;

      if (eventType === "content_block_start") {
        const block = event.content_block as Record<string, unknown> | undefined;
        if (block?.type === "tool_use") {
          const index = typeof event.index === "number" ? event.index : 0;
          const toolUseId = typeof block.id === "string" ? block.id : undefined;
          // Start accumulating input for this tool block
          this.pendingToolBlocks.set(executionId, {
            name: block.name as string,
            inputJson: "",
            index,
            toolUseId,
          });
          // Emit immediate tool-use with name only so the hub shows activity right away
          eventBus.emit({
            executionId,
            channelId: message.channelId,
            chatId: message.chatId,
            type: "tool-use",
            timestamp: Date.now(),
            payload: {
              toolName: block.name as string,
              toolUseId,
              parentToolUseId,
            }
          });
        } else if (block?.type === "tool_result") {
          // Tool result arrives in its own content block. Pair to its tool_use by id.
          const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id : undefined;
          if (toolUseId) {
            const result = extractToolResult(block);
            eventBus.emit({
              executionId,
              channelId: message.channelId,
              chatId: message.chatId,
              type: "tool-use",
              timestamp: Date.now(),
              payload: {
                toolUseId,
                toolResult: result,
                parentToolUseId,
              }
            });
          }
        } else if (block?.type === "thinking") {
          const index = typeof event.index === "number" ? event.index : 0;
          // Start accumulating thinking text
          this.pendingThinkingBlocks.set(executionId, { index, text: "" });
          // Emit thinking event immediately so the hub can show an indicator
          eventBus.emit({
            executionId,
            channelId: message.channelId,
            chatId: message.chatId,
            type: "thinking",
            timestamp: Date.now(),
            payload: { parentToolUseId },
          });
        } else if (block?.type !== "text") {
          // "text" blocks are expected and handled via text_delta below.
          // Log any other unknown block types for future visibility.
          this.logger.info("Unhandled content_block_start type.", { executionId, blockType: block?.type });
        }
      } else if (eventType === "content_block_delta") {
        const delta = event.delta as Record<string, unknown> | undefined;
        if (delta?.type === "text_delta") {
          const text = delta.text as string;
          if (text) {
            eventBus.emit({
              executionId,
              channelId: message.channelId,
              chatId: message.chatId,
              type: "stream-text",
              timestamp: Date.now(),
              payload: { text, parentToolUseId }
            });
          }
        } else if (delta?.type === "input_json_delta") {
          // Accumulate tool input JSON fragments for the matching tool block
          const pending = this.pendingToolBlocks.get(executionId);
          const blockIndex = typeof event.index === "number" ? event.index : 0;
          if (pending && pending.index === blockIndex) {
            pending.inputJson += (delta.partial_json as string) || "";
          }
        } else if (delta?.type === "thinking_delta") {
          // Accumulate thinking text fragments for the matching thinking block
          const pending = this.pendingThinkingBlocks.get(executionId);
          const blockIndex = typeof event.index === "number" ? event.index : 0;
          if (pending && pending.index === blockIndex) {
            pending.text += (delta.thinking as string) || "";
          }
        } else if (delta?.type === "signature_delta") {
          // Integrity verification signature for thinking blocks — no action needed
        } else if (delta?.type) {
          this.logger.info("Unhandled content_block_delta type.", { executionId, deltaType: delta.type });
        }
      } else if (eventType === "content_block_stop") {
        const blockIndex = typeof event.index === "number" ? event.index : 0;

        // Tool block complete — emit enriched tool-use event with parsed input
        const pendingTool = this.pendingToolBlocks.get(executionId);
        if (pendingTool && pendingTool.index === blockIndex) {
          if (pendingTool.inputJson) {
            try {
              const toolInput = JSON.parse(pendingTool.inputJson) as Record<string, unknown>;
              eventBus.emit({
                executionId,
                channelId: message.channelId,
                chatId: message.chatId,
                type: "tool-use",
                timestamp: Date.now(),
                payload: {
                  toolName: pendingTool.name,
                  toolInput,
                  toolUseId: pendingTool.toolUseId,
                  parentToolUseId,
                }
              });
            } catch {
              // Malformed JSON — the initial tool-use event already showed the name
            }
          }
          this.pendingToolBlocks.delete(executionId);
        }

        // Thinking block complete — clean up accumulated text
        const pendingThinking = this.pendingThinkingBlocks.get(executionId);
        if (pendingThinking && pendingThinking.index === blockIndex) {
          this.pendingThinkingBlocks.delete(executionId);
        }
      } else if (eventType !== "message_start" && eventType !== "message_stop" && eventType !== "message_delta" && eventType !== "ping") {
        // message_start, message_stop, message_delta, and ping are expected lifecycle/keep-alive events.
        // Log any other unknown stream event types for future visibility.
        this.logger.info("Unhandled stream event type.", { executionId, eventType });
      }
      return;
    }

    // "assistant" messages contain the complete turn. We intentionally skip
    // them here because tool-use and text events have already been emitted
    // via the stream_event path (--include-partial-messages is always set).
    // Emitting again would cause duplicate tool steps in the hub.
    if (type === "assistant") {
      return;
    }

    // "user" messages may carry tool_result content blocks. The Anthropic
    // protocol delivers tool results as user-role messages; emit a tool-use
    // event with the result attached so the hub can pair it by tool_use_id.
    if (type === "user") {
      const userMessage = parsed.message as Record<string, unknown> | undefined;
      const content = userMessage?.content;
      const parentToolUseId = (parsed.parent_tool_use_id as string | undefined) || undefined;
      if (Array.isArray(content)) {
        for (const block of content as Array<Record<string, unknown>>) {
          if (block?.type === "tool_result") {
            const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id : undefined;
            if (!toolUseId) continue;
            const result = extractToolResult(block);
            eventBus.emit({
              executionId,
              channelId: message.channelId,
              chatId: message.chatId,
              type: "tool-use",
              timestamp: Date.now(),
              payload: {
                toolUseId,
                toolResult: result,
                parentToolUseId,
              }
            });
          }
        }
      }
      return;
    }

    // "result" type is handled by the close event — ignore here.
    // "system" events (api_retry, etc.) are logged but not forwarded.
    if (type === "system") {
      this.logger.info("CLI stream-json system event.", { executionId, subtype: (parsed as Record<string, unknown>).subtype });
    }
  }

  private async extractMemory(userText: string, response: string): Promise<void> {
    try {
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
    } catch (err) {
      this.logger.warn("Memory extraction failed.", {
        reason: err instanceof Error ? err.message : "unknown",
      });
    }
  }
}

/**
 * Pull a flat result payload out of a tool_result content block.
 * `content` may be a string, or an array of text/image blocks per the
 * Anthropic protocol — join text parts and drop everything else.
 */
function extractToolResult(block: Record<string, unknown>): ToolResult {
  const isError = block.is_error === true;
  const raw = block.content;
  let content: string | undefined;
  if (typeof raw === "string") {
    content = raw;
  } else if (Array.isArray(raw)) {
    const parts: string[] = [];
    for (const part of raw as Array<Record<string, unknown>>) {
      if (part?.type === "text" && typeof part.text === "string") {
        parts.push(part.text);
      }
    }
    if (parts.length > 0) content = parts.join("\n");
  }
  return { content, isError };
}
