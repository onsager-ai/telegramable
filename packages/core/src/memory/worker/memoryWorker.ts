import { spawn, ChildProcess } from "child_process";
import { existsSync, mkdtempSync, mkdirSync, rmdirSync, unlinkSync, writeFileSync, readFileSync, chmodSync, openSync, closeSync, constants as fsConstants } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Logger } from "../../logging";
import { buildMemoryPrompt } from "../store";
import type { MemorySnapshot } from "../store";
import { TelegramMemoryProvider } from "../telegramProvider";
import { formatTurnSnapshot } from "./turnSnapshot";
import { WorkerJob, WorkerJobRunner } from "./types";

export interface MemoryWorkerOptions {
  provider: TelegramMemoryProvider;
  /** Full command line of the Claude Code CLI, e.g. "claude --print". */
  claudeCommand: string;
  logger: Logger;
  dataDir?: string;
  timeoutMs?: number;
  maxTurns?: number;
  /**
   * Override the subprocess spawn function — used in tests to bypass the
   * actual Claude binary and simulate state-file writes.
   */
  spawnFn?: typeof spawn;
  /** Override the path to the compiled memoryMcpStdio.js script (for tests). */
  mcpStdioPath?: string;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_TURNS = 10;

const envInt = (name: string): number | undefined => {
  const raw = process.env[name];
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

/**
 * Spawns a Claude Code subprocess to write durable memories after a
 * conversation goes idle. Re-uses the same MCP stdio wire-up that the main
 * runtime used to attach inline — moved off the user-facing path so writes
 * never block a turn.
 */
export class MemoryWorker implements WorkerJobRunner {
  private readonly provider: TelegramMemoryProvider;
  private readonly logger: Logger;
  private readonly dataDir?: string;
  private readonly claudeCommand: string;
  private readonly timeoutMs: number;
  private readonly maxTurns: number;
  private readonly spawnFn: typeof spawn;
  private readonly mcpStdioPath: string;
  private currentChild?: ChildProcess;

  constructor(options: MemoryWorkerOptions) {
    this.provider = options.provider;
    this.claudeCommand = options.claudeCommand;
    this.logger = options.logger;
    this.dataDir = options.dataDir;
    this.timeoutMs = options.timeoutMs ?? envInt("MEMORY_WORKER_TIMEOUT_MS") ?? DEFAULT_TIMEOUT_MS;
    this.maxTurns = options.maxTurns ?? envInt("MEMORY_WORKER_MAX_TURNS") ?? DEFAULT_MAX_TURNS;
    this.spawnFn = options.spawnFn ?? spawn;
    this.mcpStdioPath = options.mcpStdioPath ?? join(__dirname, "..", "memoryMcpStdio.js");
  }

  async run(job: WorkerJob): Promise<void> {
    if (!existsSync(this.mcpStdioPath)) {
      throw new Error(`Memory MCP stdio script not found at ${this.mcpStdioPath}`);
    }

    // Snapshot dir lives under dataDir so it survives across runs; fall back
    // to tmpdir() when no dataDir is configured.
    const baseDir = this.dataDir ? join(this.dataDir, "memory-snapshots", job.channelId) : tmpdir();
    if (this.dataDir) {
      mkdirSync(baseDir, { recursive: true });
    }
    const snapshotPath = join(baseDir, `${job.dispatchedAt}-${job.chatId.replace(/[^\w-]/g, "_")}.txt`);
    writeFileSync(snapshotPath, formatTurnSnapshot(job.turns), { mode: 0o600 });

    // Temp dir for MCP config + state file with restrictive permissions
    const mcpDir = mkdtempSync(join(tmpdir(), `telegramable-memory-worker-${job.dispatchedAt}-`));
    chmodSync(mcpDir, 0o700);
    const stateFilePath = join(mcpDir, "memory-state.json");
    const mcpConfigPath = join(mcpDir, "mcp-config.json");

    const baseline = this.provider.store.snapshot();
    writeSecure(stateFilePath, JSON.stringify(baseline, null, 2));

    const mcpConfig = {
      mcpServers: {
        memory: {
          command: process.execPath,
          args: [this.mcpStdioPath, stateFilePath],
        },
      },
    };
    writeSecure(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));

    const memorySuffix = buildMemoryPrompt(this.provider.all(), /* agentDriven */ true);

    const { executable, initialArgs } = parseCommand(this.claudeCommand);
    const args = [
      ...initialArgs,
      "--append-system-prompt",
      memorySuffix,
      "--mcp-config",
      mcpConfigPath,
      "--allowed-tools",
      "save_memory,update_memory,delete_memory,list_memories,search_memories,get_memory",
      "--max-turns",
      String(this.maxTurns),
      "--permission-mode",
      "bypassPermissions",
      "--",
      `Please read the snapshot at ${snapshotPath} and update memories accordingly.`,
    ];

    this.logger.info("Memory worker spawning.", {
      channelId: job.channelId,
      chatId: job.chatId,
      turnCount: job.turns.length,
      timeoutMs: this.timeoutMs,
      maxTurns: this.maxTurns,
    });

    let timedOut = false;
    try {
      await this.runSubprocess(executable, args, () => { timedOut = true; });
      if (timedOut) {
        throw new Error("Memory worker subprocess timed out.");
      }
      await this.syncMemoryFromFile(stateFilePath, baseline);
    } finally {
      tryUnlink(snapshotPath);
      tryUnlink(stateFilePath);
      tryUnlink(mcpConfigPath);
      tryRmdir(mcpDir);
    }
  }

  /** Kill any in-flight subprocess.  Safe to call when nothing is running. */
  async shutdown(): Promise<void> {
    if (this.currentChild && !this.currentChild.killed) {
      this.logger.info("Memory worker shutdown — killing in-flight subprocess.");
      this.currentChild.kill("SIGTERM");
      // Allow a beat for graceful exit; SIGKILL forcibly cleans up.
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (this.currentChild && !this.currentChild.killed) {
        this.currentChild.kill("SIGKILL");
      }
    }
    this.currentChild = undefined;
  }

  private runSubprocess(executable: string, args: string[], onTimeout: () => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = this.spawnFn(executable, args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      });
      this.currentChild = child;

      const stderrChunks: string[] = [];
      child.stdout?.on("data", () => { /* drain */ });
      child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk.toString()));

      const timer = setTimeout(() => {
        onTimeout();
        child.kill("SIGKILL");
      }, this.timeoutMs);

      child.on("error", (err) => {
        clearTimeout(timer);
        this.currentChild = undefined;
        reject(err);
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        this.currentChild = undefined;
        if (code === 0) {
          resolve();
        } else {
          const stderr = stderrChunks.join("").slice(0, 500);
          reject(new Error(`Memory worker exited with code ${code}${stderr ? ` — ${stderr}` : ""}`));
        }
      });
    });
  }

  /**
   * Read back the MCP state file and apply only the subprocess's diff against
   * the baseline captured at spawn time.  Diffing against the baseline (not
   * the live store) avoids re-applying changes the live store already has.
   */
  private async syncMemoryFromFile(stateFilePath: string, baseline: MemorySnapshot): Promise<void> {
    let raw: string;
    try {
      raw = readFileSync(stateFilePath, "utf-8");
    } catch (err) {
      this.logger.warn("Memory worker state file unreadable; nothing to sync.", {
        reason: err instanceof Error ? err.message : "unknown",
      });
      return;
    }

    let after: MemorySnapshot;
    try {
      after = JSON.parse(raw) as MemorySnapshot;
    } catch (err) {
      this.logger.warn("Memory worker state file malformed; nothing to sync.", {
        reason: err instanceof Error ? err.message : "unknown",
      });
      return;
    }
    if (!after.v || !Array.isArray(after.facts)) return;

    const baselineMap = new Map(baseline.facts.map((f) => [f.id, f]));
    const afterMap = new Map(after.facts.map((f) => [f.id, f]));

    const changelogParts: string[] = [];
    const store = this.provider.store;

    for (const fact of after.facts) {
      if (!baselineMap.has(fact.id)) {
        const added = store.add(fact.tag, fact.text);
        changelogParts.push(`➕ <code>${added.id}</code> [${fact.tag}] ${fact.text}`);
      }
    }

    for (const [id, baseFact] of baselineMap) {
      const afterFact = afterMap.get(id);
      if (afterFact && afterFact.text !== baseFact.text) {
        store.update(id, afterFact.text);
        changelogParts.push(`✏️ <code>${id}</code> → ${afterFact.text}`);
      }
    }

    for (const [id, baseFact] of baselineMap) {
      if (!afterMap.has(id)) {
        store.remove(id);
        changelogParts.push(`🗑️ <code>${id}</code> ${baseFact.text}`);
      }
    }

    if (changelogParts.length === 0) return;

    await this.provider.syncToTelegram();
    await this.provider.sendChangelog(`<b>🧠 Memory updated</b>\n\n${changelogParts.join("\n")}`);
    this.logger.info("Memory worker applied diff.", { changes: changelogParts.length });
  }
}

const parseCommand = (cmd: string): { executable: string; initialArgs: string[] } => {
  const parts = cmd.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) throw new Error("Memory worker claudeCommand is empty.");
  return { executable: parts[0], initialArgs: parts.slice(1) };
};

const writeSecure = (path: string, data: string): void => {
  const fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
  try {
    writeFileSync(fd, data, "utf-8");
  } finally {
    closeSync(fd);
  }
};

const tryUnlink = (p: string): void => {
  try { unlinkSync(p); } catch { /* ignore */ }
};

const tryRmdir = (p: string): void => {
  try { rmdirSync(p); } catch { /* ignore */ }
};
