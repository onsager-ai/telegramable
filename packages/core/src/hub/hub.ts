import { randomUUID } from "crypto";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { basename, join } from "path";
import { tmpdir } from "os";
import { EventBus } from "../events/eventBus";
import { ExecutionEvent, ToolResult } from "../events/types";
import { IMAdapter, IMAdapterStartOptions, IMMessage } from "../gateway/types";
import { Logger } from "../logging";
import { formatMemoryList } from "../memory";
import { MemoryProvider } from "../memory/provider";
import { MemoryRefinementScheduler } from "../memory/scheduler";
import { MemorySync } from "../memory/sync";
import { IdleScheduler } from "../memory/worker/idleScheduler";
import { MemoryWorkerQueue } from "../memory/worker/workerQueue";
import { WorkerJobRunner } from "../memory/worker/types";
import { FileSessionStore } from "../runtime/session/fileSessionStore";
import { ChunkThrottler } from "./chunkThrottler";
import { ExecutionRegistry, InMemoryExecutionRegistry } from "./executionRegistry";
import { markdownToTelegramHtml } from "./markdownToHtml";
import {
  MEMORY_CALLBACK_PREFIX,
  buildMemoryListMarkup,
  buildClearConfirmMarkup,
  buildChannelInfoMarkup,
} from "./memoryMarkup";
import { PermissionBridge } from "./permissionBridge";
import { Router } from "./router";
import { SudoWatcher } from "./sudoWatcher";

const TELEGRAM_MSG_LIMIT = 4000;

const truncate = (text: string, max: number): string => {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max - 3)}...`;
};

/**
 * Split text into chunks that fit within Telegram's message limit.
 * Tries to break at paragraph boundaries, then line boundaries, then hard-cuts.
 */
const splitMessage = (text: string, max: number = TELEGRAM_MSG_LIMIT): string[] => {
  if (text.length <= max) {
    return [text];
  }
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > max) {
    let splitAt = remaining.lastIndexOf("\n\n", max);
    if (splitAt <= 0) {
      splitAt = remaining.lastIndexOf("\n", max);
    }
    if (splitAt <= 0) {
      splitAt = max;
    }
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n+/, "");
  }
  if (remaining.length > 0) {
    chunks.push(remaining);
  }
  return chunks;
};

type BuiltinCommand =
  | { type: "start" }
  | { type: "help" }
  | { type: "status"; executionId: string }
  | { type: "logs"; executionId: string }
  | { type: "list" }
  | { type: "memory" }
  | { type: "memory-search"; query: string }
  | { type: "memory-edit"; id: string; text: string }
  | { type: "memory-delete"; id: string }
  | { type: "memory-export" }
  | { type: "memory-clear" }
  | { type: "memory-channel" }
  | { type: "memory-refine" }
  | null;

export const parseBuiltinCommand = (text: string): BuiltinCommand => {
  const trimmed = text.trim();

  if (/^\/start\s*$/i.test(trimmed)) {
    return { type: "start" };
  }

  if (/^\/help\s*$/i.test(trimmed)) {
    return { type: "help" };
  }

  const statusMatch = trimmed.match(/^\/status\s+([^\s]+)\s*$/i);
  if (statusMatch?.[1]) {
    return { type: "status", executionId: statusMatch[1] };
  }

  const logsMatch = trimmed.match(/^\/logs\s+([^\s]+)\s*$/i);
  if (logsMatch?.[1]) {
    return { type: "logs", executionId: logsMatch[1] };
  }

  if (/^\/list\s*$/i.test(trimmed)) {
    return { type: "list" };
  }

  // Memory commands
  const memEditMatch = trimmed.match(/^\/memory\s+edit\s+(f\d+)\s+(.+)$/i);
  if (memEditMatch?.[1] && memEditMatch[2]) {
    return { type: "memory-edit", id: memEditMatch[1], text: memEditMatch[2] };
  }

  const memDeleteMatch = trimmed.match(/^\/memory\s+delete\s+(f\d+)\s*$/i);
  if (memDeleteMatch?.[1]) {
    return { type: "memory-delete", id: memDeleteMatch[1] };
  }

  const memSearchMatch = trimmed.match(/^\/memory\s+search\s+(.+)$/i);
  if (memSearchMatch?.[1]) {
    return { type: "memory-search", query: memSearchMatch[1] };
  }

  if (/^\/memory\s+export\s*$/i.test(trimmed)) {
    return { type: "memory-export" };
  }

  if (/^\/memory\s+clear\s*$/i.test(trimmed)) {
    return { type: "memory-clear" };
  }

  if (/^\/memory\s+channel\s*$/i.test(trimmed)) {
    return { type: "memory-channel" };
  }

  if (/^\/memory\s+refine\s*$/i.test(trimmed)) {
    return { type: "memory-refine" };
  }

  if (/^\/memory\s*$/i.test(trimmed)) {
    return { type: "memory" };
  }

  return null;
};

const formatEvent = (event: ExecutionEvent): string | null => {
  switch (event.type) {
    case "complete":
      return event.payload?.response || null;
    case "error":
      return `Error: ${event.payload?.reason || "unknown"}`;
    default:
      return null;
  }
};

const PERMISSION_CALLBACK_PREFIX = "perm:";

/** Escape HTML special characters for Telegram HTML parse mode. */
const escapeHtml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Format a duration in milliseconds to a human-readable string. */
const formatDuration = (ms: number): string => {
  const totalSeconds = Math.floor(ms / 1_000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
};

/**
 * Resolve the display name and primary argument for a tool, per the unified
 * step template `<b>{name}</b> <code>{arg}</code>`. Pulls the salient input
 * (file basename / command / pattern / agent description) and maps the tool
 * to a friendly display name — Grep → Search, Task → Agent, etc.
 *
 * `name` is plain (not HTML-escaped); `arg` is plain text suitable for
 * wrapping in `<code>`. Callers escape on output.
 */
const formatToolDisplay = (
  toolName: string,
  toolInput?: Record<string, unknown>,
): { name: string; arg?: string } => {
  const lower = toolName.toLowerCase();

  const fileBasename = (val: unknown): string | undefined => {
    if (typeof val !== "string" || val.length === 0) return undefined;
    return basename(val);
  };

  const asString = (val: unknown): string | undefined =>
    typeof val === "string" && val.length > 0 ? val : undefined;

  const input = toolInput ?? {};
  const filePath = input.file_path ?? input.path ?? input.filePath;
  const command = input.command;
  const pattern = input.pattern ?? input.query ?? input.regex;
  const description = input.description;
  const prompt = input.prompt;

  switch (lower) {
    case "read":
      return { name: "Read", arg: fileBasename(filePath) };
    case "write":
      return { name: "Write", arg: fileBasename(filePath) };
    case "edit":
    case "multiedit":
      return { name: "Edit", arg: fileBasename(filePath) };
    case "bash":
      return { name: "Bash", arg: asString(command) };
    case "grep":
      return { name: "Search", arg: asString(pattern) };
    case "glob":
      return { name: "Glob", arg: asString(pattern) };
    case "task":
    case "agent": {
      const arg = asString(description) ?? (asString(prompt) ? truncate(prompt as string, 40) : undefined);
      return { name: "Agent", arg };
    }
    default: {
      // Unknown / MCP tools: keep the tool name as-is, use the first string-valued input
      const firstVal = Object.values(input).find((v) => typeof v === "string" && v.length > 0);
      return { name: toolName, arg: asString(firstVal) };
    }
  }
};

/**
 * Render a single step's body (without the `✓/▸/✗` prefix) per the unified
 * template `<b>{name}</b> <code>{arg}</code>`. Used by both the running-state
 * `▸` cue and the completed/error blockquote rows.
 */
const formatToolDescription = (toolName: string, toolInput?: Record<string, unknown>): string => {
  const { name, arg } = formatToolDisplay(toolName, toolInput);
  const nameHtml = `<b>${escapeHtml(name)}</b>`;
  if (!arg) return nameHtml;
  return `${nameHtml} <code>${escapeHtml(arg)}</code>`;
};

/** Format a tool permission request as an HTML message for Telegram. */
const formatPermissionRequest = (toolName: string, toolInput: Record<string, unknown>): string => {
  const inputPreview = truncate(JSON.stringify(toolInput, null, 2), 500);
  return (
    `<b>🔐 Permission Request</b>\n\n` +
    `<b>Tool:</b> <code>${escapeHtml(toolName)}</code>\n` +
    `<blockquote expandable>${escapeHtml(inputPreview)}</blockquote>`
  );
};

// --- Tool activity rendering (#88) ----------------------------------

type ToolCategory = "read" | "edit" | "bash" | "search" | "agent" | "thinking" | "other";

const CATEGORY_EMOJI: Record<Exclude<ToolCategory, "thinking">, string> = {
  read: "📖",
  edit: "✏️",
  bash: "⚡",
  search: "🔍",
  agent: "🤖",
  other: "⚙️",
};

const CATEGORY_ORDER: Array<Exclude<ToolCategory, "thinking">> = ["read", "edit", "bash", "search", "agent", "other"];

export const categorizeToolName = (toolName: string): ToolCategory => {
  const lower = toolName.toLowerCase();
  switch (lower) {
    case "read":
      return "read";
    case "write":
    case "edit":
    case "multiedit":
      return "edit";
    case "bash":
      return "bash";
    case "grep":
    case "glob":
      return "search";
    case "agent":
    case "task":
      return "agent";
    case "thinking":
      return "thinking";
    default:
      return "other";
  }
};

const formatCategoryCounters = (tools: ReadonlyArray<{ name: string }>): string => {
  const counts = new Map<Exclude<ToolCategory, "thinking">, number>();
  for (const t of tools) {
    const cat = categorizeToolName(t.name);
    if (cat === "thinking") continue; // filtered upstream, defense-in-depth here
    counts.set(cat, (counts.get(cat) ?? 0) + 1);
  }
  const parts: string[] = [];
  for (const cat of CATEGORY_ORDER) {
    const n = counts.get(cat);
    if (n) parts.push(`${CATEGORY_EMOJI[cat]}${n}`);
  }
  return parts.join(" ");
};

/**
 * Build a single-line plain-text suffix summarizing the result of a tool call,
 * to be appended to the step row inside the Done-state blockquote. Returns
 * `undefined` when there is nothing useful to say (missing result, unknown tool).
 *
 * The suffix is plain text by design — no `<code>`, no `<pre>` — so it can't
 * spawn an independent Telegram widget that breaks the blockquote's collapse.
 */
export const formatToolResultSuffix = (
  toolName: string,
  result: ToolResult | undefined,
): string | undefined => {
  if (!result) return undefined;
  const category = categorizeToolName(toolName);

  // Bash failure dominates — surface it regardless of content shape
  if (category === "bash" && result.isError) return "(failed)";

  const content = result.content ?? "";

  switch (category) {
    case "bash": {
      const lines = countNonEmptyLines(content);
      return `(${lines} line${lines === 1 ? "" : "s"})`;
    }
    case "read": {
      const lines = countNonEmptyLines(content);
      return `(${lines} line${lines === 1 ? "" : "s"})`;
    }
    case "edit": {
      // Try to parse "+N -M" style diff stats; fall back to (updated)
      const stats = parseDiffStats(content);
      if (stats) return `(-${stats.removed} +${stats.added})`;
      return "(updated)";
    }
    case "search": {
      const lower = toolName.toLowerCase();
      if (lower === "glob") {
        const files = countNonEmptyLines(content);
        return files === 0 ? "(no files)" : `(${files} file${files === 1 ? "" : "s"})`;
      }
      // Grep
      const matches = countNonEmptyLines(content);
      return matches === 0 ? "(no matches)" : `(${matches} ${matches === 1 ? "match" : "matches"})`;
    }
    case "agent": {
      const firstLine = content.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
      if (!firstLine) return undefined;
      return `("${truncate(firstLine, 40)}")`;
    }
    default:
      return undefined;
  }
};

const countNonEmptyLines = (text: string): number => {
  if (!text) return 0;
  let count = 0;
  for (const line of text.split("\n")) {
    if (line.trim().length > 0) count++;
  }
  return count;
};

/**
 * Extract `+N -M` style diff stats from an Edit/MultiEdit tool result.
 * Handles common Claude Code confirmation patterns like
 * "Applied 1 edit to file.ts: +12 -3" or "5 additions / 2 deletions".
 * Returns `undefined` if no recognizable pattern is found.
 */
const parseDiffStats = (text: string): { added: number; removed: number } | undefined => {
  if (!text) return undefined;
  // "+12 -3", "+12/-3"
  const plusFirst = text.match(/\+(\d+)[^\d+-]+-(\d+)/);
  if (plusFirst) return { added: parseInt(plusFirst[1], 10), removed: parseInt(plusFirst[2], 10) };
  // "-3 +12", "-3/+12"
  const minusFirst = text.match(/-(\d+)[^\d+-]+\+(\d+)/);
  if (minusFirst) return { added: parseInt(minusFirst[2], 10), removed: parseInt(minusFirst[1], 10) };
  // "12 additions, 3 deletions"
  const verbose = text.match(/(\d+)\s+addition[s]?[,\s/]+\s*(\d+)\s+deletion[s]?/i);
  if (verbose) return { added: parseInt(verbose[1], 10), removed: parseInt(verbose[2], 10) };
  return undefined;
};

/** Max number of (deduplicated) entries shown inside the expandable blockquote. */
const TOOL_ACTIVITY_BLOCKQUOTE_MAX = 150;

export interface ActivityTool {
  name: string;
  input?: Record<string, unknown>;
  isSubagent?: boolean;
  /** Anthropic tool_use id — used to pair with tool_result. */
  toolUseId?: string;
  /** Populated once the matching tool_result arrives. */
  result?: ToolResult;
}

interface RenderActivityState {
  status: "running" | "complete" | "error";
  tools: ReadonlyArray<ActivityTool>;
  executionId: string;
  durationMs?: number;
  errorReason?: string;
}

/**
 * Render a tool-activity status message for Telegram.
 *
 * Completed:
 *   ✅ <b>Done</b> · <i>3 steps · 10s</i>
 *   ⚡1 📖1 ✏️1
 *   <blockquote expandable>
 *   ✓ <b>Read</b> <code>hub.ts</code> (1790 lines)
 *   …
 *   </blockquote>
 *
 * Running (no blockquote — keeps edit payloads short and avoids Telegram's
 * "blockquote does not collapse under ~4 lines" footgun):
 *   ⚙️ <b>Working</b> · <i>3 steps</i>
 *   ⚡1 📖1 · ▸ <b>Edit</b> <code>hub.ts</code>
 *
 * Error: like Done, plus `<i>{reason}</i>` between counter and blockquote;
 * the failing (last) step row is prefixed `✗` instead of `✓`.
 *
 * Thinking steps are filtered out before any counting happens — they don't
 * contribute to the step total, the counter, or the blockquote.
 */
export const renderActivity = (state: RenderActivityState): string => {
  const visibleTools = state.tools.filter((t) => categorizeToolName(t.name) !== "thinking");
  const total = visibleTools.length;

  // Header line: icon + label + optional steps/duration
  const icon = state.status === "complete" ? "✅" : state.status === "error" ? "❌" : "⚙️";
  const label = state.status === "complete" ? "Done" : state.status === "error" ? "Error" : "Working";
  const headerExtras: string[] = [];
  if (total > 0) headerExtras.push(`${total} step${total === 1 ? "" : "s"}`);
  if (state.durationMs != null && state.durationMs > 0) headerExtras.push(formatDuration(state.durationMs));
  let header = `${icon} <b>${label}</b>`;
  if (headerExtras.length > 0) header += ` · <i>${headerExtras.join(" · ")}</i>`;

  const lines: string[] = [header];

  // Counter line + (running only) ▸ current
  if (total > 0) {
    const counters = formatCategoryCounters(visibleTools);
    if (state.status === "running") {
      const lastTool = visibleTools[visibleTools.length - 1];
      const currentDesc = formatToolDescription(lastTool.name, lastTool.input);
      lines.push(`${counters} · ▸ ${currentDesc}`);
    } else {
      lines.push(counters);
    }
  }

  // Error reason between counters and blockquote
  if (state.status === "error" && state.errorReason) {
    lines.push(`<i>${escapeHtml(state.errorReason)}</i>`);
  }

  // Running state: skip blockquote entirely. The `▸ current` cue on the
  // counter line already covers "what's happening now"; past steps will
  // appear in the Done summary once the run finishes.
  if (state.status === "running") {
    return lines.join("\n");
  }

  // Dedup-consecutive step list inside an expandable blockquote.
  // Each row carries: prefix (✓ / ✗), the unified body, optional suffix
  // describing the tool's result.
  if (total > 0) {
    type Row = { body: string; count: number; isSubagent?: boolean; prefix: string };
    const deduped: Row[] = [];

    for (let i = 0; i < visibleTools.length; i++) {
      const tool = visibleTools[i];
      const desc = formatToolDescription(tool.name, tool.input);
      const suffix = formatToolResultSuffix(tool.name, tool.result);
      const bashFailed =
        categorizeToolName(tool.name) === "bash" && tool.result?.isError === true;
      const isLast = i === visibleTools.length - 1;
      // ✗ for the failing step (the last step of an Error-state run, or any
      // bash step whose result reported an error). Everything else is ✓.
      const isFailing = (state.status === "error" && isLast) || bashFailed;
      const prefix = isFailing ? "✗" : "✓";
      const body = suffix ? `${desc} ${escapeHtml(suffix)}` : desc;

      const last = deduped[deduped.length - 1];
      if (
        last &&
        last.body === body &&
        last.isSubagent === tool.isSubagent &&
        last.prefix === prefix
      ) {
        last.count++;
      } else {
        deduped.push({ body, count: 1, isSubagent: tool.isSubagent, prefix });
      }
    }

    const visible = deduped.slice(0, TOOL_ACTIVITY_BLOCKQUOTE_MAX);
    const blockquoteLines = visible.map((entry) => {
      const sub = entry.isSubagent ? "↳ " : "";
      const row = `${entry.prefix} ${sub}${entry.body}`;
      return entry.count > 1 ? `${row} <i>x${entry.count}</i>` : row;
    });
    if (deduped.length > TOOL_ACTIVITY_BLOCKQUOTE_MAX) {
      const more = deduped.length - TOOL_ACTIVITY_BLOCKQUOTE_MAX;
      blockquoteLines.push(`<i>… (${more} more, /logs ${state.executionId} for full)</i>`);
    }
    lines.push(`<blockquote expandable>${blockquoteLines.join("\n")}</blockquote>`);
  }

  return lines.join("\n");
};

export interface MemoryChannelInfo {
  /** The resolved numeric chat ID currently in use. */
  resolvedChatId: string;
  /** The raw configured value (e.g. @my_agent_memory). */
  rawChatId?: string;
  /** How the chat ID was obtained. */
  cacheSource?: "cached" | "resolved" | "direct";
  /** Cache store for flushing entries. */
  cacheStore?: FileSessionStore;
}

export class ChannelHub {
  private readonly adapters = new Map<string, IMAdapter>();
  private readonly executionRegistry: ExecutionRegistry;
  private readonly chunkThrottlers = new Map<string, ChunkThrottler>();
  private readonly permissionBridge: PermissionBridge;
  private readonly topicMap = new Map<string, number>(); // "channelId:chatId:executionId" → topicId
  private readonly streamDrafts = new Map<string, { text: string; messageId?: number; draftId?: number; draftFailed?: boolean }>(); // for streaming text accumulation
  private readonly completionPending = new Set<string>(); // executionIds whose complete/error/response-end event is already queued — used to short-circuit pending stream-text sends
  private readonly alreadyFlushed = new Set<string>(); // executionIds whose draft was already finalized by a `response-end` event — the later `complete` event must not re-send the response
  private readonly cleanupDone = new Set<string>(); // executionIds whose user-visible cleanup (reaction, tool-activity, throttler) ran early on `response-end` — the later `complete` event must skip those Tier-A steps to avoid re-mutation after the reply settles
  private draftIdCounter = 0; // monotonic counter for Telegram draft IDs
  private readonly typingIntervals = new Map<string, ReturnType<typeof setInterval>>(); // periodic typing indicators
  private readonly toolActivityMessages = new Map<string, { executionId: string; tools: ActivityTool[]; messageId?: number; promotionTimer?: ReturnType<typeof setTimeout>; promoted: boolean; sendingPromise?: Promise<void> }>(); // tool activity tracking
  private readonly eventQueues = new Map<string, Promise<void>>(); // serialize events per execution
  private readonly reactionMessageIds = new Map<string, number>(); // executionId → source messageId for clearing reactions
  private readonly downloadedFiles = new Map<string, string[]>(); // executionId → local file paths to clean up
  private unsubscribeEvents?: () => void;
  private readonly sudoWatcher?: SudoWatcher;

  constructor(
    adapters: IMAdapter[],
    private readonly router: Router,
    private readonly eventBus: EventBus,
    private readonly logger: Logger,
    executionRegistry?: ExecutionRegistry,
    private readonly memoryProvider?: MemoryProvider,
    private readonly memoryChannelInfo?: MemoryChannelInfo,
    /** @deprecated Use memoryProvider instead. Kept for backward compat with MemorySync audit log. */
    private readonly memorySync?: MemorySync,
    private readonly refinementScheduler?: MemoryRefinementScheduler,
    private readonly memoryWorker?: {
      scheduler: IdleScheduler;
      queue: MemoryWorkerQueue;
      runner: WorkerJobRunner;
    },
  ) {
    this.executionRegistry = executionRegistry ?? new InMemoryExecutionRegistry();
    this.permissionBridge = new PermissionBridge(logger);

    // Start the sudo wrapper watcher if a directory is configured (or use default)
    const sudoDir = process.env.TELEGRAMABLE_SUDO_DIR || "/tmp/telegramable-sudo";
    this.sudoWatcher = new SudoWatcher(sudoDir, eventBus, logger);

    for (const adapter of adapters) {
      if (this.adapters.has(adapter.id)) {
        throw new Error(`Duplicate channel id '${adapter.id}' in channel configuration.`);
      }
      this.adapters.set(adapter.id, adapter);
    }
  }

  async start(options?: IMAdapterStartOptions): Promise<void> {
    this.subscribeEvents();
    this.sudoWatcher?.start();

    // Start the async memory worker if it was wired up.  It subscribes to the
    // shared EventBus and dispatches per-channel jobs to its queue.
    if (this.memoryWorker) {
      this.memoryWorker.scheduler.start(this.eventBus, (job) => this.memoryWorker!.queue.enqueue(job));
    }

    await Promise.all(Array.from(this.adapters.values()).map((adapter) => {
      return adapter.start((message) => void this.handleMessage({
        ...message,
        channelId: adapter.id
      }), options);
    }));

    this.logger.info("ChannelHub started.", { channels: Array.from(this.adapters.keys()) });
  }

  /** Hard upper bound on best-effort Telegram cleanup during shutdown. */
  private static readonly SHUTDOWN_GRACE_MS = 5_000;

  async stop(): Promise<void> {
    if (this.unsubscribeEvents) {
      this.unsubscribeEvents();
      this.unsubscribeEvents = undefined;
    }

    this.permissionBridge.cancelAll();
    this.sudoWatcher?.stop();

    // Stop the memory worker first so it stops accepting new turn-complete
    // events; kill any in-flight subprocess so the bot can exit cleanly.
    if (this.memoryWorker) {
      this.memoryWorker.scheduler.stop();
      this.memoryWorker.queue.stop();
      await this.memoryWorker.runner.shutdown();
    }

    // Clear all typing indicator intervals before the best-effort flush so
    // the user sees activity stop while we're finalizing state.
    for (const interval of this.typingIntervals.values()) {
      clearInterval(interval);
    }
    this.typingIntervals.clear();

    // Phase 2: best-effort flush of user-visible in-flight state, bounded by
    // SHUTDOWN_GRACE_MS so we fit inside Docker's stop-grace window.
    await Promise.race([
      this.flushInflightStateOnShutdown(),
      new Promise<void>((r) => setTimeout(r, ChannelHub.SHUTDOWN_GRACE_MS)),
    ]);

    for (const throttler of this.chunkThrottlers.values()) {
      await throttler.flush();
      throttler.destroy();
    }
    this.chunkThrottlers.clear();
    for (const activity of this.toolActivityMessages.values()) {
      if (activity.promotionTimer) clearTimeout(activity.promotionTimer);
    }
    this.toolActivityMessages.clear();
    this.eventQueues.clear();
    this.reactionMessageIds.clear();
    this.streamDrafts.clear();
    this.completionPending.clear();
    this.alreadyFlushed.clear();
    this.cleanupDone.clear();

    // Clean up any downloaded files from in-flight executions
    for (const executionId of Array.from(this.downloadedFiles.keys())) {
      this.cleanupDownloadedFiles(executionId);
    }

    await Promise.all(Array.from(this.adapters.values()).map((adapter) => adapter.stop()));
    this.logger.info("ChannelHub stopped.");
  }

  /**
   * Best-effort cleanup of user-visible Telegram state for in-flight executions.
   * Called from `stop()` under a bounded timeout to avoid orphan ⏳ drafts,
   * dangling 👀 reactions, and unsfinalized tool-activity messages after the
   * process exits (e.g. SIGTERM during Railway redeploy).
   *
   * All operations are best-effort: failures are swallowed so one bad adapter
   * call can't abort the rest of the cleanup.
   */
  private async flushInflightStateOnShutdown(): Promise<void> {
    // Let any in-flight per-execution event chain finish so streamDrafts /
    // toolActivityMessages reach a stable state before we read them.
    try {
      await Promise.allSettled(Array.from(this.eventQueues.values()));
    } catch { /* best-effort */ }

    const tasks: Promise<unknown>[] = [];

    // Snapshot entries before iterating — best-effort cleanup may race with
    // late event handlers that mutate these maps.
    const streamDraftEntries = Array.from(this.streamDrafts.entries());
    const reactionEntries = Array.from(this.reactionMessageIds.entries());
    const toolActivityEntries = Array.from(this.toolActivityMessages.entries());

    // 1. Finalize any visible streaming drafts so they don't disappear when the
    //    ephemeral draft expires after the process exits.
    for (const [draftKey, draft] of streamDraftEntries) {
      const parts = draftKey.split(":");
      // draftKey format: "channelId:chatId:executionId" — chatId may itself
      // contain ":" in Slack-style ids, so take channel from front, executionId
      // from back, and everything in the middle as chatId.
      if (parts.length < 3) continue;
      const channelId = parts[0];
      const executionId = parts[parts.length - 1];
      const chatId = parts.slice(1, -1).join(":");
      const adapter = this.adapters.get(channelId);
      if (!adapter || !draft.text.trim()) continue;

      const topicId = this.getTopicId(channelId, chatId, executionId);
      if (draft.messageId && adapter.editMessage) {
        tasks.push(
          adapter.editMessage(chatId, draft.messageId, markdownToTelegramHtml(draft.text)).catch(() => { /* best-effort */ })
        );
      } else if (adapter.sendMessage) {
        // No visible draft yet — send the accumulated text as a new message so
        // it isn't lost when the draft would have expired.
        tasks.push(
          (topicId && adapter.sendMessageWithMarkup
            ? adapter.sendMessageWithMarkup(chatId, markdownToTelegramHtml(draft.text), undefined, { threadId: topicId })
            : adapter.sendMessage(chatId, markdownToTelegramHtml(draft.text))
          ).catch(() => { /* best-effort */ })
        );
      }
    }

    // 2. Clear any dangling reactions (⏳ from queued / 👀 from start) on the
    //    user's source messages so they don't sit indefinitely after exit.
    for (const [executionId, msgId] of reactionEntries) {
      // Look up the adapter via the eventQueues map (key matches executionId)
      // — fall back to scanning adapters since we don't have channelId here.
      // The reaction map is keyed only by executionId, so we have to resolve
      // channelId via the executionRegistry record.
      const record = this.executionRegistry.get(executionId);
      if (!record) continue;
      const adapter = this.adapters.get(record.channelId);
      if (!adapter?.setMessageReaction) continue;
      tasks.push(
        adapter.setMessageReaction(record.chatId, msgId, null).catch(() => { /* best-effort */ })
      );
    }

    // 3. Finalize tool-activity messages (edit them into the collapsed summary
    //    or delete if empty) so the user doesn't see a permanently "Working…"
    //    status hanging around.
    for (const [activityKey, activity] of toolActivityEntries) {
      const parts = activityKey.split(":");
      if (parts.length < 3) continue;
      const channelId = parts[0];
      const executionId = parts[parts.length - 1];
      const chatId = parts.slice(1, -1).join(":");
      const adapter = this.adapters.get(channelId);
      if (!adapter || !activity.promoted || !activity.messageId) continue;

      if (activity.tools.length > 0 && adapter.editMessage) {
        const record = this.executionRegistry.get(executionId);
        const summary = renderActivity({
          status: "error",
          tools: activity.tools,
          executionId,
          durationMs: record?.startedAt ? Date.now() - record.startedAt : undefined,
          errorReason: "Interrupted by shutdown.",
        });
        tasks.push(
          adapter.editMessage(chatId, activity.messageId, summary).catch(() => { /* best-effort */ })
        );
      } else if (adapter.deleteMessage) {
        tasks.push(
          adapter.deleteMessage(chatId, activity.messageId).catch(() => { /* best-effort */ })
        );
      }
    }

    await Promise.allSettled(tasks);
  }

  private subscribeEvents(): void {
    if (this.unsubscribeEvents) {
      return;
    }

    this.unsubscribeEvents = this.eventBus.on((event) => {
      const adapter = this.adapters.get(event.channelId);
      if (!adapter) {
        this.logger.warn("No adapter found for execution event.", {
          channelId: event.channelId,
          executionId: event.executionId
        });
        return;
      }

      this.trackEvent(event);

      // Mark completion as pending SYNCHRONOUSLY (before queueing) so any
      // still-queued stream-text events can short-circuit their expensive
      // sendMessageDraft calls. The complete handler will flush the final
      // accumulated draft text by editing the existing streamed message when
      // one exists, or by sending a new message if streaming was short-
      // circuited before any draft send — avoiding a visible delay between
      // the end of streaming and the draft→permanent transition.
      //
      // `response-end` is the Claude CLI stream-json signal that the assistant
      // turn is logically finished (received ahead of process exit). Treating
      // it as pending lets us flush the draft seconds before `complete` would
      // otherwise fire, so the ephemeral Telegram draft can't expire on the
      // CLI's shutdown tail.
      if (event.type === "complete" || event.type === "error" || event.type === "response-end") {
        this.completionPending.add(event.executionId);
      }

      // Serialize event processing per execution to prevent race conditions
      // (e.g. stream-text sendMessage not yet resolved when complete fires)
      const queueKey = event.executionId;
      const prev = this.eventQueues.get(queueKey) ?? Promise.resolve();
      const next = prev.then(async () => {
        try {
          await this.forwardEvent(adapter, event);
        } catch (error) {
          this.logger.error("Failed to dispatch execution event.", {
            channelId: event.channelId,
            executionId: event.executionId,
            reason: error instanceof Error ? error.message : "unknown"
          });
        }
      });
      this.eventQueues.set(queueKey, next);

      // Clean up queue entry when chain settles
      void next.then(() => {
        if (this.eventQueues.get(queueKey) === next) {
          this.eventQueues.delete(queueKey);
        }
      });
    });
  }

  private async handleMessage(message: IMMessage): Promise<void> {
    // Handle callback queries (inline keyboard responses)
    if (message.callbackData) {
      await this.handleCallbackQuery(message);
      return;
    }

    if (!message.text || message.text.trim().length === 0) {
      // Allow file-only messages to pass through
      if (!message.fileId) {
        this.logger.warn("Ignoring empty message.", {
          channelId: message.channelId,
          chatId: message.chatId
        });
        return;
      }
    }

    const adapter = this.adapters.get(message.channelId);
    const builtin = message.text ? parseBuiltinCommand(message.text) : null;
    if (adapter && builtin) {
      await this.handleBuiltinCommand(adapter, message, builtin);
      return;
    }

    // Prepend quoted/reply message context so the agent sees what the user is replying to.
    // Truncate to avoid exceeding OS argv limits in CLI runtime path.
    const MAX_REPLY_CONTEXT = 500;
    const replyContext = message.replyToText
      ? truncate(message.replyToText, MAX_REPLY_CONTEXT)
      : undefined;
    let enrichedMessage: IMMessage = replyContext
      ? { ...message, text: `[Quoted message]\n${replyContext}\n[End quoted message]\n\n${message.text}` }
      : message;

    const executionId = randomUUID();

    // Download any attached file and make it accessible to the agent as a local path.
    // Prepend the path to the prompt so the agent knows where to find it.
    if (message.fileId && adapter?.getFileUrl) {
      try {
        const fileUrl = await adapter.getFileUrl(message.fileId);
        const localPath = await this.downloadAndSaveFile(fileUrl, executionId, message.fileName);
        const tracked = this.downloadedFiles.get(executionId) ?? [];
        tracked.push(localPath);
        this.downloadedFiles.set(executionId, tracked);
        const fileNote = `[Attached file: ${localPath}]`;
        enrichedMessage = {
          ...enrichedMessage,
          text: enrichedMessage.text.trim()
            ? `${fileNote}\n\n${enrichedMessage.text}`
            : fileNote,
        };
        this.logger.debug("File downloaded for agent.", { executionId, localPath });
      } catch (error) {
        this.logger.warn("Failed to download attached file.", {
          executionId,
          fileId: message.fileId,
          reason: error instanceof Error ? error.message : "unknown",
        });
      }
    }

    const { runtime, message: routedMessage } = this.router.select(enrichedMessage);

    if (adapter) {
      // Try to create a forum topic for this execution
      await this.tryCreateForumTopic(adapter, message.chatId, executionId, message.text || "New task");
    }

    this.logger.info("Received message.", {
      executionId,
      channelId: message.channelId,
      chatId: message.chatId,
      text: message.text ? message.text.slice(0, 200) : undefined,
      fileId: message.fileId || undefined
    });

    // Start typing indicator immediately so user sees activity
    if (adapter) {
      this.startTypingIndicator(adapter, message.chatId, executionId, this.getTopicId(message.channelId, message.chatId, executionId));
    }

    try {
      await runtime.execute(routedMessage, executionId, this.eventBus);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown";
      this.eventBus.emit({
        executionId,
        channelId: message.channelId,
        chatId: message.chatId,
        type: "error",
        timestamp: Date.now(),
        payload: { reason }
      });
      this.logger.error("Runtime execution failed.", { executionId, reason });
    }
  }

  private async handleCallbackQuery(message: IMMessage): Promise<void> {
    if (message.callbackData?.startsWith(MEMORY_CALLBACK_PREFIX)) {
      await this.handleMemoryCallback(message);
      return;
    }

    if (!message.callbackData?.startsWith(PERMISSION_CALLBACK_PREFIX)) {
      return;
    }

    const adapter = this.adapters.get(message.channelId);

    // Parse: "perm:<requestId>:<allow|deny>"
    const parts = message.callbackData.slice(PERMISSION_CALLBACK_PREFIX.length).split(":");
    const requestId = parts[0];
    const decision = parts[1] === "allow" ? "allow" as const : "deny" as const;

    if (!requestId) {
      return;
    }

    const responded = this.permissionBridge.respond(requestId, decision);

    // Acknowledge the callback query
    if (adapter?.answerCallbackQuery && message.callbackQueryId) {
      await adapter.answerCallbackQuery(
        message.callbackQueryId,
        responded ? `${decision === "allow" ? "✅ Approved" : "❌ Denied"}` : "Request expired."
      );
    }

    // Edit the original message to reflect the decision
    if (adapter?.editMessage && message.messageId) {
      const statusText = decision === "allow" ? "✅ <b>Approved</b>" : "❌ <b>Denied</b>";
      await adapter.editMessage(message.chatId, message.messageId, statusText).catch(() => {
        // Non-critical — message may have been deleted
      });
    }
  }

  private async handleMemoryCallback(message: IMMessage): Promise<void> {
    const adapter = this.adapters.get(message.channelId);
    if (!adapter) return;

    const data = message.callbackData!.slice(MEMORY_CALLBACK_PREFIX.length);
    const [action, ...rest] = data.split(":");
    const param = rest.join(":");

    const ack = async (text?: string) => {
      if (adapter.answerCallbackQuery && message.callbackQueryId) {
        await adapter.answerCallbackQuery(message.callbackQueryId, text);
      }
    };

    const editMarkup = async (text: string, markup: unknown) => {
      if (adapter.editMessageWithMarkup && message.messageId) {
        await adapter.editMessageWithMarkup(message.chatId, message.messageId, text, markup).catch(() => {});
      } else if (adapter.editMessage && message.messageId) {
        await adapter.editMessage(message.chatId, message.messageId, text).catch(() => {});
      }
    };

    if (action === "noop") {
      await ack();
      return;
    }

    if (action === "delete") {
      if (!this.memoryProvider) {
        await ack("Memory not configured.");
        return;
      }
      // param may be "<factId>" or "<factId>:<page>"
      const [factId, pageStr] = param.split(":");
      const page = pageStr ? parseInt(pageStr, 10) || 0 : 0;
      if (await this.memoryProvider.remove(factId)) {
        await ack(`Deleted ${factId}`);
        // Re-render the list in-place, preserving the current page
        const { text, markup } = buildMemoryListMarkup(this.memoryProvider.all(), page);
        await editMarkup(text, markup);
      } else {
        await ack(`Unknown: ${factId}`);
      }
      return;
    }

    if (action === "page") {
      if (!this.memoryProvider) {
        await ack("Memory not configured.");
        return;
      }
      const page = parseInt(param, 10) || 0;
      const { text, markup } = buildMemoryListMarkup(this.memoryProvider.all(), page);
      await editMarkup(text, markup);
      await ack();
      return;
    }

    if (action === "clear") {
      if (!this.memoryProvider) {
        await ack("Memory not configured.");
        return;
      }

      if (param === "prompt") {
        const count = this.memoryProvider.all().length;
        if (count === 0) {
          await ack("No memories to clear.");
          return;
        }
        const { text, markup } = buildClearConfirmMarkup(count);
        await editMarkup(text, markup);
        await ack();
        return;
      }

      if (param === "confirm") {
        await this.memoryProvider.clear();
        await ack("All memories cleared.");
        const { text, markup } = buildMemoryListMarkup(this.memoryProvider.all());
        await editMarkup(text, markup);
        return;
      }

      if (param === "cancel") {
        // Re-render the list
        const { text, markup } = buildMemoryListMarkup(this.memoryProvider.all());
        await editMarkup(text, markup);
        await ack("Cancelled.");
        return;
      }
      return;
    }

    if (action === "export") {
      if (!this.memoryProvider) {
        await ack("Memory not configured.");
        return;
      }
      if (adapter.sendDocument) {
        const json = JSON.stringify(this.memoryProvider.all(), null, 2);
        await adapter.sendDocument(message.chatId, Buffer.from(json, "utf-8"), {
          fileName: "memory.json",
          caption: `${this.memoryProvider.all().length} facts exported.`,
        });
        await ack();
      } else {
        await ack("Export not supported on this adapter.");
      }
      return;
    }

    if (action === "channel") {
      if (!this.memoryChannelInfo) {
        await ack("No channel info available.");
        return;
      }
      const { text, markup } = buildChannelInfoMarkup(
        this.memoryChannelInfo.resolvedChatId,
        this.memoryChannelInfo.rawChatId,
        this.memoryChannelInfo.cacheSource
      );
      await editMarkup(text, markup);
      await ack();
      return;
    }

    if (action === "cache") {
      if (param === "flush") {
        if (!this.memoryChannelInfo?.cacheStore || !this.memoryChannelInfo.rawChatId) {
          await ack("No cache to flush.");
          return;
        }
        try {
          this.memoryChannelInfo.cacheStore.delete(this.memoryChannelInfo.rawChatId);
          this.logger.info("Memory chat ID cache flushed.", { rawChatId: this.memoryChannelInfo.rawChatId });
          await ack("Cache flushed!");
          if (adapter.editMessage && message.messageId) {
            await adapter.editMessage(
              message.chatId,
              message.messageId,
              "🔄 <b>Cache flushed.</b>\n\nThe memory chat ID cache has been cleared. Restart the bot to re-resolve the channel."
            ).catch(() => {});
          }
        } catch (error) {
          this.logger.error("Failed to flush memory chat ID cache.", {
            rawChatId: this.memoryChannelInfo.rawChatId,
            reason: error instanceof Error ? error.message : "unknown",
          });
          await ack("Failed to flush cache. Please try again.");
        }
        return;
      }
      return;
    }

    // Unknown callback — just acknowledge
    await ack();
  }

  /** Download a Telegram file and save it to a per-execution temp directory. */
  private async downloadAndSaveFile(
    fileUrl: string,
    executionId: string,
    fileName?: string
  ): Promise<string> {
    const dir = join(tmpdir(), "telegramable-uploads", executionId);
    mkdirSync(dir, { recursive: true });
    const safeName = fileName
      ? basename(fileName).replace(/[^\w.\-]/g, "_").slice(0, 100) || "attachment"
      : "attachment";
    const localPath = join(dir, safeName);
    const response = await fetch(fileUrl);
    if (!response.ok) throw new Error(`Failed to fetch file: HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    writeFileSync(localPath, buffer);
    return localPath;
  }

  /** Remove all temp files downloaded for an execution. */
  private cleanupDownloadedFiles(executionId: string): void {
    if (!this.downloadedFiles.has(executionId)) return;
    this.downloadedFiles.delete(executionId);
    try {
      rmSync(join(tmpdir(), "telegramable-uploads", executionId), { recursive: true, force: true });
    } catch {
      // Non-critical — OS will eventually clean up /tmp
    }
  }

  private async tryCreateForumTopic(
    adapter: IMAdapter,
    chatId: string,
    executionId: string,
    taskPreview: string
  ): Promise<number | undefined> {
    if (!adapter.createForumTopic) {
      return undefined;
    }

    try {
      const topicName = `Claude: ${truncate(taskPreview, 60)}`;
      const topicId = await adapter.createForumTopic(chatId, topicName);
      this.topicMap.set(`${adapter.id}:${chatId}:${executionId}`, topicId);
      this.logger.debug("Forum topic created.", { chatId, executionId, topicId });
      return topicId;
    } catch (error) {
      // Forum topics require supergroup with topics enabled — graceful fallback
      this.logger.debug("Forum topic creation failed, using flat chat.", {
        chatId,
        reason: error instanceof Error ? error.message : "unknown"
      });
      return undefined;
    }
  }

  private getTopicId(channelId: string, chatId: string, executionId: string): number | undefined {
    return this.topicMap.get(`${channelId}:${chatId}:${executionId}`);
  }

  private trackEvent(event: ExecutionEvent): void {
    switch (event.type) {
      case "start":
        this.executionRegistry.start({
          executionId: event.executionId,
          channelId: event.channelId,
          chatId: event.chatId,
          agentName: event.payload?.agentName || "unknown",
          startedAt: event.timestamp
        });
        break;
      case "stdout":
      case "stderr":
      case "stream-text": {
        const label = event.type === "stream-text" ? "[stdout]" : `[${event.type}]`;
        const text = event.payload?.text || "";
        this.executionRegistry.append(event.executionId, `${label} ${text}`);
        break;
      }
      case "tool-use": {
        const payload = event.payload || {};
        // tool_result events ride the same event type — pair by toolUseId.
        if (payload.toolResult && payload.toolUseId) {
          this.executionRegistry.trackToolResult(
            event.executionId,
            payload.toolUseId,
            payload.toolResult,
          );
        } else {
          this.executionRegistry.trackToolUse(
            event.executionId,
            payload.toolName || "unknown",
            payload.toolInput,
            payload.toolUseId,
          );
        }
        break;
      }
      case "complete":
        this.executionRegistry.complete(event.executionId, event.timestamp);
        break;
      case "error":
        this.executionRegistry.error(event.executionId, event.payload?.reason || "unknown", event.timestamp);
        break;
      default:
        break;
    }
  }

  private startTypingIndicator(adapter: IMAdapter, chatId: string, executionId: string, topicId?: number): void {
    if (!adapter.sendChatAction) return;

    const key = `${adapter.id}:${chatId}:${executionId}`;

    // Clear any existing interval to prevent leaked timers from piling up
    const existing = this.typingIntervals.get(key);
    if (existing) clearInterval(existing);

    // Send immediately, then repeat every 4s (Telegram typing expires after ~5s)
    const sendTyping = () => {
      adapter.sendChatAction!(chatId, "typing", { threadId: topicId }).catch(() => {
        // Non-critical — chat action may fail if bot was blocked
      });
    };

    sendTyping();
    const interval = setInterval(sendTyping, 4_000);
    this.typingIntervals.set(key, interval);
  }

  private stopTypingIndicator(channelId: string, chatId: string, executionId: string): void {
    const key = `${channelId}:${chatId}:${executionId}`;
    const interval = this.typingIntervals.get(key);
    if (interval) {
      clearInterval(interval);
      this.typingIntervals.delete(key);
    }
  }

  private async forwardEvent(adapter: IMAdapter, event: ExecutionEvent): Promise<void> {
    const topicId = this.getTopicId(event.channelId, event.chatId, event.executionId);

    // Stale-resume retry from CliRuntime: drop hub-side stream state from the
    // failed attempt so the retry's events don't interleave with leftover
    // content from the first run. We don't clear `reactionMessageIds` — the
    // 👀 reaction set on the source message is fine to keep through the retry,
    // and dropping it would prevent the eventual `complete` handler from
    // clearing the reaction.
    if (event.type === "retry-reset") {
      const draftKey = `${event.channelId}:${event.chatId}:${event.executionId}`;
      const stranded = this.streamDrafts.get(draftKey);

      // If the failed attempt already promoted a draft to a real Telegram
      // message (e.g. a tool-use event triggered an early flush), best-effort
      // delete that message so it doesn't sit alongside the retry's output as
      // a duplicate fragment. Messages sent via plain `sendMessage` (no
      // returned messageId) can't be recovered — accept that as cost of the
      // synchronous retry path.
      if (stranded?.messageId && adapter.deleteMessage) {
        adapter.deleteMessage(event.chatId, stranded.messageId).catch(() => { /* non-critical */ });
      }

      this.streamDrafts.delete(draftKey);
      this.completionPending.delete(event.executionId);
      this.alreadyFlushed.delete(event.executionId);
      this.cleanupDone.delete(event.executionId);

      const activityKey = `${event.channelId}:${event.chatId}:${event.executionId}`;
      const activity = this.toolActivityMessages.get(activityKey);
      if (activity) {
        if (activity.promotionTimer) clearTimeout(activity.promotionTimer);
        if (activity.promoted && activity.messageId && adapter.deleteMessage) {
          adapter.deleteMessage(event.chatId, activity.messageId).catch(() => { /* non-critical */ });
        }
        this.toolActivityMessages.delete(activityKey);
      }
      return;
    }

    // Handle queued — react with hourglass to show the message is waiting
    if (event.type === "queued") {
      if (adapter.setMessageReaction && event.payload?.messageId) {
        this.reactionMessageIds.set(event.executionId, event.payload.messageId);
        adapter.setMessageReaction(event.chatId, event.payload.messageId, "⏳").catch(() => {
          // Non-critical — reaction may not be supported in this chat
        });
      }
      return;
    }

    // Handle start — replace queued reaction with eyes to show processing
    if (event.type === "start") {
      const msgId = event.payload?.messageId ?? this.reactionMessageIds.get(event.executionId);
      if (adapter.setMessageReaction && msgId) {
        this.reactionMessageIds.set(event.executionId, msgId);
        adapter.setMessageReaction(event.chatId, msgId, "👀").catch(() => {
          // Non-critical
        });
      }
    }

    // Handle permission requests — send inline keyboard
    if (event.type === "permission-request") {
      await this.forwardPermissionRequest(adapter, event, topicId);
      return;
    }

    // Handle thinking — show as an activity step in the tool timeline
    if (event.type === "thinking") {
      await this.flushStreamDraft(adapter, event.channelId, event.chatId, event.executionId, topicId);
      await this.forwardToolActivity(adapter, {
        ...event,
        payload: { ...event.payload, toolName: "Thinking" },
      }, topicId);
      this.startTypingIndicator(adapter, event.chatId, event.executionId, topicId);
      return;
    }

    // Handle tool-use — show activity and restart typing indicator
    if (event.type === "tool-use") {
      // If we were streaming text, flush the current draft so the text message
      // is finalized ABOVE the upcoming tool activity messages.
      await this.flushStreamDraft(adapter, event.channelId, event.chatId, event.executionId, topicId);
      await this.forwardToolActivity(adapter, event, topicId);
      // Restart typing indicator so user sees activity during tool execution
      this.startTypingIndicator(adapter, event.chatId, event.executionId, topicId);
      return;
    }

    // Handle streaming text — accumulate and send via sendMessageDraft (or edit fallback)
    // Skip subagent text — it's intermediate and only the Agent tool result matters.
    if ((event.type === "stream-text" || event.type === "stdout") && event.payload?.parentToolUseId) {
      return;
    }
    if (event.type === "stream-text" || event.type === "stdout") {
      // Stop typing indicator once we start streaming actual text
      this.stopTypingIndicator(event.channelId, event.chatId, event.executionId);
      // Finalize tool activity message into a compact summary
      await this.finalizeToolActivity(adapter, event.channelId, event.chatId, event.executionId);
      await this.forwardStreamText(adapter, event, topicId);
      return;
    }

    // Early draft finalization — the Claude CLI stream-json `result` event tells us
    // the assistant turn is logically done, ahead of the CLI's multi-second shutdown
    // tail. Flush the draft to a permanent message immediately so the ephemeral
    // Telegram draft can't expire while we wait for `complete`.
    if (event.type === "response-end") {
      this.stopTypingIndicator(event.channelId, event.chatId, event.executionId);
      const draftKey = `${event.channelId}:${event.chatId}:${event.executionId}`;
      const draft = this.streamDrafts.get(draftKey);
      if (draft && draft.text.trim().length > 0) {
        try {
          await this.flushStreamDraft(adapter, event.channelId, event.chatId, event.executionId, topicId);
        } catch {
          // Best-effort — flushStreamDraft cleans up its own state in `finally`.
        }
        // Mark as flushed so the later `complete` event skips the duplicate flush
        // and the duplicate response send. Set even on flush failure, since the
        // draft may already be partially visible — re-sending would duplicate.
        this.alreadyFlushed.add(event.executionId);
      }

      // Tier A user-visible cleanup — runs here so the chat goes still the
      // moment the reply settles, instead of continuing to mutate during the
      // CLI's multi-second shutdown tail. The later `complete`/`error` event
      // skips these via `cleanupDone`. Tier B (summary, topic close, file
      // cleanup) stays on `complete` since it depends on final record state or
      // on the agent process having exited.
      await this.runVisibleCleanup(adapter, event.channelId, event.chatId, event.executionId);
      this.cleanupDone.add(event.executionId);
      return;
    }

    if (event.type === "complete" || event.type === "error") {
      // Always stop typing indicator on completion
      this.stopTypingIndicator(event.channelId, event.chatId, event.executionId);

      // Clear the short-circuit flag now that we're handling the completion.
      // (It was set synchronously in subscribeEvents so earlier queued
      // stream-text events could skip their sendMessageDraft calls.)
      this.completionPending.delete(event.executionId);

      // If `response-end` already finalized the draft, skip the flush and the
      // duplicate-response send path. Tier B cleanup (summary, topic close,
      // file cleanup) still runs; Tier A cleanup (reaction, tool-activity,
      // throttler) is gated separately by `cleanupDone` so it isn't re-run
      // when `response-end` already drove it.
      const wasAlreadyFlushed = this.alreadyFlushed.has(event.executionId);
      this.alreadyFlushed.delete(event.executionId);
      const cleanupAlreadyDone = this.cleanupDone.has(event.executionId);
      this.cleanupDone.delete(event.executionId);

      // Check if the response is already visible via a streaming draft.
      // If so, flush it IMMEDIATELY — before any other Telegram API calls —
      // to convert the ephemeral draft into a permanent message via editMessage.
      // Delaying the flush behind finalizeToolActivity / flushAndDeleteThrottler
      // causes a visible gap where the draft disappears before the permanent
      // message appears. editMessage preserves the message position, so
      // subsequent messages (error text, summary) still appear below it.
      const draftKey = `${event.channelId}:${event.chatId}:${event.executionId}`;
      const draft = this.streamDrafts.get(draftKey);
      const hasDraftContent = draft && draft.text.trim().length > 0;

      if (hasDraftContent && !wasAlreadyFlushed) {
        try {
          await this.flushStreamDraft(adapter, event.channelId, event.chatId, event.executionId, topicId);
        } catch {
          // Best-effort: flushStreamDraft cleans up draft state in its finally
          // block. Continue with the rest of the completion path so error text,
          // summary, and topic close still happen.
        }
      }

      // Tier A user-visible cleanup. Skipped if `response-end` already ran it —
      // re-running would re-edit the tool-activity blockquote and re-clear an
      // already-cleared reaction, causing the post-reply "after-shake".
      if (!cleanupAlreadyDone) {
        await this.runVisibleCleanup(adapter, event.channelId, event.chatId, event.executionId);
      }

      if (hasDraftContent || wasAlreadyFlushed) {
        // Draft was already flushed (either above or by response-end) — send
        // error text and summary after it.
        if (event.type === "error") {
          const text = formatEvent(event);
          if (text) {
            const chunks = splitMessage(text);
            for (const chunk of chunks) {
              await adapter.sendMessage(event.chatId, markdownToTelegramHtml(chunk));
            }
          }
        }
        await this.sendExecutionSummary(adapter, event, topicId);
        this.closeForumTopicIfNeeded(adapter, event, topicId);
        this.cleanupDownloadedFiles(event.executionId);
        return;
      }

      // No visible draft — flush any pending draft (may be empty)
      const flushedContent = await this.flushStreamDraft(adapter, event.channelId, event.chatId, event.executionId, topicId);

      // Skip sending duplicate response if we already streamed it in-place
      if (flushedContent && event.type === "complete") {
        await this.sendExecutionSummary(adapter, event, topicId);
        this.closeForumTopicIfNeeded(adapter, event, topicId);
        this.cleanupDownloadedFiles(event.executionId);
        return;
      }
    }

    const text = formatEvent(event);
    if (text) {
      const chunks = splitMessage(text);
      for (const chunk of chunks) {
        await adapter.sendMessage(event.chatId, markdownToTelegramHtml(chunk));
      }
    }

    // Send execution summary after the response
    if (event.type === "complete" || event.type === "error") {
      await this.sendExecutionSummary(adapter, event, topicId);
      // Close forum topic after all messages are sent
      this.closeForumTopicIfNeeded(adapter, event, topicId);
      this.cleanupDownloadedFiles(event.executionId);
    }
  }

  /** Send a compact execution summary (duration, tool count) after completion. */
  private async sendExecutionSummary(adapter: IMAdapter, event: ExecutionEvent, topicId?: number): Promise<void> {
    // Opt-in via SHOW_EXECUTION_SUMMARY=true (disabled by default)
    if (process.env.SHOW_EXECUTION_SUMMARY?.trim().toLowerCase() !== "true") return;

    const record = this.executionRegistry.get(event.executionId);
    if (!record) return;

    const durationMs = (record.finishedAt ?? event.timestamp) - record.startedAt;
    const durationStr = formatDuration(durationMs);
    const toolCount = record.toolUses.length;

    // Only show summary if there was meaningful work (tools used or took > 5s)
    if (toolCount === 0 && durationMs < 5_000) return;

    const icon = record.status === "complete" ? "✅" : "❌";
    const parts: string[] = [`${icon} <i>${durationStr}`];
    if (toolCount > 0) {
      parts[0] += ` · ${toolCount} tool${toolCount === 1 ? "" : "s"} used`;
    }
    parts[0] += "</i>";

    if (topicId && adapter.sendMessageWithMarkup) {
      await adapter.sendMessageWithMarkup(event.chatId, parts.join(""), undefined, { threadId: topicId });
    } else {
      await adapter.sendMessage(event.chatId, parts.join(""));
    }
  }

  /** Close forum topic after all messages have been sent. Fire-and-forget. */
  private closeForumTopicIfNeeded(adapter: IMAdapter, event: ExecutionEvent, topicId?: number): void {
    if (topicId && adapter.closeForumTopic) {
      adapter.closeForumTopic(event.chatId, topicId).catch(() => {
        // Non-critical
      });
      this.topicMap.delete(`${event.channelId}:${event.chatId}:${event.executionId}`);
    }
  }

  private async forwardPermissionRequest(adapter: IMAdapter, event: ExecutionEvent, topicId?: number): Promise<void> {
    const requestId = event.payload?.permissionRequestId;
    const toolName = event.payload?.toolName || "unknown";
    const toolInput = event.payload?.toolInput || {};

    if (!requestId) {
      this.logger.warn("Permission request missing requestId.", { executionId: event.executionId });
      return;
    }

    // Register with the permission bridge
    const decisionPromise = this.permissionBridge.request({
      requestId,
      executionId: event.executionId,
      channelId: event.channelId,
      chatId: event.chatId,
      toolName,
      toolInput
    });

    // Send inline keyboard via adapter
    if (adapter.sendMessageWithMarkup) {
      const markup = {
        inline_keyboard: [[
          { text: "✅ Approve", callback_data: `${PERMISSION_CALLBACK_PREFIX}${requestId}:allow` },
          { text: "❌ Deny", callback_data: `${PERMISSION_CALLBACK_PREFIX}${requestId}:deny` }
        ]]
      };

      await adapter.sendMessageWithMarkup(
        event.chatId,
        formatPermissionRequest(toolName, toolInput),
        markup,
        { threadId: topicId }
      );
    } else {
      // Fallback: send plain text and auto-deny
      await adapter.sendMessage(
        event.chatId,
        `Permission request for tool "${toolName}" — auto-denied (no inline keyboard support).`
      );
      this.permissionBridge.respond(requestId, "deny");
    }

    // Wait for the decision and emit permission-response event
    const decision = await decisionPromise;
    this.eventBus.emit({
      executionId: event.executionId,
      channelId: event.channelId,
      chatId: event.chatId,
      type: "permission-response",
      timestamp: Date.now(),
      payload: {
        permissionRequestId: requestId,
        decision
      }
    });
  }

  /** Delay before tool activity becomes visible. Short turns never send a status message. */
  private static readonly TOOL_ACTIVITY_PROMOTION_MS = 1_500;

  private async forwardToolActivity(adapter: IMAdapter, event: ExecutionEvent, topicId?: number): Promise<void> {
    const payload = event.payload || {};
    const toolName = payload.toolName || "unknown";
    const toolInput = payload.toolInput;
    const toolUseId = payload.toolUseId;
    const toolResult = payload.toolResult;
    const isSubagent = !!payload.parentToolUseId;
    const activityKey = `${event.channelId}:${event.chatId}:${event.executionId}`;

    let activity = this.toolActivityMessages.get(activityKey);
    if (!activity) {
      activity = { executionId: event.executionId, tools: [], promoted: false };
      this.toolActivityMessages.set(activityKey, activity);
    }

    // tool_result rides the same event — pair it onto the matching tool entry
    // by toolUseId and skip the rest of the bookkeeping. There's nothing new
    // for the user to see between the running-state cue and the Done summary,
    // but the result is now attached for finalize-time rendering.
    if (toolResult && toolUseId) {
      const target = activity.tools.find((t) => t.toolUseId === toolUseId);
      if (target) target.result = toolResult;
      return;
    }

    // If the last tool has the same name and no input yet, this is an enriched
    // update (input arrived via input_json_delta) — update in-place instead of duplicating.
    const lastTool = activity.tools[activity.tools.length - 1];
    if (lastTool && lastTool.name === toolName && !lastTool.input && toolInput && Object.keys(toolInput).length > 0) {
      lastTool.input = toolInput;
      if (toolUseId && !lastTool.toolUseId) lastTool.toolUseId = toolUseId;
    } else {
      activity.tools.push({ name: toolName, input: toolInput, isSubagent, toolUseId });
    }

    if (activity.promoted) {
      // Wait for any in-flight initial send so messageId is set before editing
      if (activity.sendingPromise) {
        await activity.sendingPromise;
      }
      // Already visible — edit in-place immediately
      await this.sendOrEditToolActivity(adapter, event.chatId, activity, topicId);
    } else if (!activity.promotionTimer) {
      // First tool event — start the promotion timer
      activity.promotionTimer = setTimeout(() => {
        const current = this.toolActivityMessages.get(activityKey);
        if (!current) return; // cleared before timer fired
        current.promoted = true;
        current.promotionTimer = undefined;
        // Track the in-flight send so finalizeToolActivity can await it
        current.sendingPromise = this.sendOrEditToolActivity(adapter, event.chatId, current, topicId)
          .catch(() => { /* non-critical — message send may fail */ })
          .finally(() => { current.sendingPromise = undefined; });
      }, ChannelHub.TOOL_ACTIVITY_PROMOTION_MS);
    }
    // Otherwise: timer already running, tools are being accumulated — nothing to do yet
  }

  private async sendOrEditToolActivity(adapter: IMAdapter, chatId: string, activity: { executionId: string; tools: ActivityTool[]; messageId?: number; promoted: boolean }, topicId?: number): Promise<void> {
    const record = this.executionRegistry.get(activity.executionId);
    const durationMs = record ? Date.now() - record.startedAt : undefined;
    const statusMsg = renderActivity({
      status: "running",
      tools: activity.tools,
      executionId: activity.executionId,
      durationMs,
    });

    if (activity.messageId && adapter.editMessage) {
      await adapter.editMessage(chatId, activity.messageId, statusMsg).catch(() => {
        // Message may have been deleted — non-critical
      });
    } else if (adapter.sendMessageWithMarkup) {
      const messageId = await adapter.sendMessageWithMarkup(chatId, statusMsg, undefined, { threadId: topicId });
      activity.messageId = messageId;
    } else {
      await adapter.sendMessage(chatId, statusMsg);
    }
  }

  /**
   * Tier A cleanup — the user-visible mutations that should stop the moment
   * the reply settles: finalize the tool-activity blockquote, drain the
   * pending throttler, clear the 👀 reaction on the source message. Runs on
   * `response-end` in the normal path and falls back to `complete`/`error`
   * when `response-end` never arrived (CLI killed before `result`).
   */
  private async runVisibleCleanup(adapter: IMAdapter, channelId: string, chatId: string, executionId: string): Promise<void> {
    await Promise.allSettled([
      this.finalizeToolActivity(adapter, channelId, chatId, executionId),
      this.flushAndDeleteThrottler(channelId, chatId),
    ]);

    const reactionMsgId = this.reactionMessageIds.get(executionId);
    this.reactionMessageIds.delete(executionId);
    if (reactionMsgId && adapter.setMessageReaction) {
      adapter.setMessageReaction(chatId, reactionMsgId, null).catch(() => {
        // Non-critical
      });
    }
  }

  /**
   * Finalize and clean up tool activity for an execution.
   * If the activity was promoted (visible), edit it into a collapsed summary.
   * If it was never promoted, just discard it silently.
   */
  private async finalizeToolActivity(adapter: IMAdapter, channelId: string, chatId: string, executionId: string): Promise<void> {
    const key = `${channelId}:${chatId}:${executionId}`;
    const activity = this.toolActivityMessages.get(key);
    if (!activity) return;

    if (activity.promotionTimer) {
      clearTimeout(activity.promotionTimer);
    }

    // Wait for any in-flight send from the promotion timer to complete
    // so that messageId is available for editing/deleting
    if (activity.sendingPromise) {
      await activity.sendingPromise;
    }

    if (activity.promoted && activity.messageId && adapter.editMessage && activity.tools.length > 0) {
      const record = this.executionRegistry.get(executionId);
      const status: "complete" | "error" = record?.status === "error" ? "error" : "complete";
      const durationMs = record?.startedAt
        ? (record.finishedAt ?? Date.now()) - record.startedAt
        : undefined;
      const summary = renderActivity({
        status,
        tools: activity.tools,
        executionId,
        durationMs,
        errorReason: record?.errorReason,
      });
      await adapter.editMessage(chatId, activity.messageId, summary).catch(() => {});
    } else if (activity.promoted && activity.messageId && adapter.deleteMessage) {
      // If we can't edit (no tools recorded), just delete
      await adapter.deleteMessage(chatId, activity.messageId).catch(() => {});
    }

    this.toolActivityMessages.delete(key);
  }

  /** Cancel tool activity without finalizing (used only during stop/cleanup). */
  private clearToolActivity(channelId: string, chatId: string, executionId: string): void {
    const key = `${channelId}:${chatId}:${executionId}`;
    const activity = this.toolActivityMessages.get(key);
    if (activity?.promotionTimer) {
      clearTimeout(activity.promotionTimer);
    }
    this.toolActivityMessages.delete(key);
  }

  private async forwardStreamText(adapter: IMAdapter, event: ExecutionEvent, topicId?: number): Promise<void> {
    const text = event.payload?.text || "";
    const draftKey = `${event.channelId}:${event.chatId}:${event.executionId}`;

    let draft = this.streamDrafts.get(draftKey);
    if (!draft) {
      draft = { text: "" };
      this.streamDrafts.set(draftKey, draft);
    }

    draft.text += text;

    // If the complete/error event is already queued, skip the expensive
    // sendMessageDraft / editMessage call here. The complete handler will
    // flush the fully accumulated draft.text using the appropriate
    // finalization path (editing an existing message or sending a new one),
    // which avoids a multi-second delay between the end of streaming and
    // the final draft→permanent transition (the visible "Memory updated"
    // message landing before the response message is finalized).
    if (this.completionPending.has(event.executionId)) {
      return;
    }

    // If accumulated text exceeds the limit, finalize current message and start a new one
    if (draft.text.length > TELEGRAM_MSG_LIMIT && (draft.messageId || draft.draftId)) {
      let splitAt = draft.text.lastIndexOf("\n\n", TELEGRAM_MSG_LIMIT);
      if (splitAt <= 0) splitAt = draft.text.lastIndexOf("\n", TELEGRAM_MSG_LIMIT);
      if (splitAt <= 0) splitAt = TELEGRAM_MSG_LIMIT;

      const finalized = draft.text.slice(0, splitAt);
      const overflow = draft.text.slice(splitAt).replace(/^\n+/, "");

      // Finalize the current message — use editMessage to convert draft to permanent
      if (draft.messageId && adapter.editMessage) {
        await adapter.editMessage(event.chatId, draft.messageId, markdownToTelegramHtml(finalized)).catch(() => {});
      }

      // Reset per-message draft state for the overflow so the next update creates a new
      // message/draft, but preserve draftFailed to avoid retrying unsupported drafts.
      draft.text = overflow;
      draft.messageId = undefined;
      draft.draftId = undefined;
      return;
    }

    // Try native sendMessageDraft first (smooth streaming, no rate limits)
    if (adapter.sendMessageDraft && !draft.draftFailed) {
      if (!draft.draftId) {
        draft.draftId = ++this.draftIdCounter;
      }
      try {
        const msgId = await adapter.sendMessageDraft(
          event.chatId,
          draft.draftId,
          markdownToTelegramHtml(draft.text.length <= TELEGRAM_MSG_LIMIT ? draft.text : draft.text.slice(0, TELEGRAM_MSG_LIMIT)),
          { threadId: topicId }
        );
        draft.messageId = msgId;
        return;
      } catch {
        // sendMessageDraft may fail in group chats — fall back to edit pattern
        draft.draftFailed = true;
        draft.draftId = undefined;
      }
    }

    // Fallback: send + edit pattern (throttled to avoid rate limits)
    const shouldUpdate = !draft.messageId || draft.text.length % 500 < text.length;

    if (shouldUpdate && adapter.editMessage && draft.messageId) {
      await adapter.editMessage(event.chatId, draft.messageId, markdownToTelegramHtml(draft.text)).catch(() => {});
    } else if (!draft.messageId && draft.text.trim()) {
      if (adapter.sendMessageWithMarkup) {
        const messageId = await adapter.sendMessageWithMarkup(
          event.chatId,
          markdownToTelegramHtml(draft.text.length <= TELEGRAM_MSG_LIMIT ? draft.text : draft.text.slice(0, TELEGRAM_MSG_LIMIT)),
          undefined,
          { threadId: topicId }
        );
        draft.messageId = messageId;
      } else {
        await adapter.sendMessage(event.chatId, draft.text.length <= TELEGRAM_MSG_LIMIT ? draft.text : draft.text.slice(0, TELEGRAM_MSG_LIMIT));
      }
    }
  }

  private async flushStreamDraft(adapter: IMAdapter, channelId: string, chatId: string, executionId: string, topicId?: number): Promise<boolean> {
    const draftKey = `${channelId}:${chatId}:${executionId}`;
    const draft = this.streamDrafts.get(draftKey);
    if (!draft) return false;

    if (!draft.text.trim()) {
      this.streamDrafts.delete(draftKey);
      return false;
    }

    const chunks = splitMessage(draft.text);

    // Helper to send a chunk with thread awareness (for forum topics)
    const sendChunk = async (text: string) => {
      if (topicId && adapter.sendMessageWithMarkup) {
        await adapter.sendMessageWithMarkup(chatId, text, undefined, { threadId: topicId });
      } else {
        await adapter.sendMessage(chatId, text);
      }
    };

    try {
      // Final flush: convert draft to a permanent message via editMessage so it
      // doesn't disappear once the draft stream ends.
      if (draft.draftId && !draft.draftFailed && draft.messageId && adapter.editMessage) {
        await adapter.editMessage(chatId, draft.messageId, markdownToTelegramHtml(chunks[0])).catch(() => {});
        for (let i = 1; i < chunks.length; i++) {
          await sendChunk(markdownToTelegramHtml(chunks[i]));
        }
      } else if (draft.messageId && adapter.editMessage) {
        // Edit existing message with first chunk
        await adapter.editMessage(chatId, draft.messageId, markdownToTelegramHtml(chunks[0])).catch(() => {});
        // Send remaining chunks as new messages
        for (let i = 1; i < chunks.length; i++) {
          await sendChunk(markdownToTelegramHtml(chunks[i]));
        }
      } else if (chunks.length > 0) {
        // No existing message — send all chunks
        for (const chunk of chunks) {
          await sendChunk(markdownToTelegramHtml(chunk));
        }
      }
    } finally {
      // Always clean up the draft entry to prevent state leaks
      this.streamDrafts.delete(draftKey);
    }

    return true;
  }

  private getChunkThrottler(channelId: string, chatId: string, adapter: IMAdapter): ChunkThrottler {
    const key = `${channelId}:${chatId}`;
    const existing = this.chunkThrottlers.get(key);
    if (existing) {
      return existing;
    }

    const throttler = new ChunkThrottler({
      flushIntervalMs: 1_000,
      maxChunkLength: 3_500,
      send: async (text) => {
        await adapter.sendMessage(chatId, text);
      }
    });

    this.chunkThrottlers.set(key, throttler);
    return throttler;
  }

  private async flushAndDeleteThrottler(channelId: string, chatId: string): Promise<void> {
    const key = `${channelId}:${chatId}`;
    const throttler = this.chunkThrottlers.get(key);
    if (!throttler) {
      return;
    }

    await throttler.flush();
    throttler.destroy();
    this.chunkThrottlers.delete(key);
  }

  private async handleBuiltinCommand(
    adapter: IMAdapter,
    message: IMMessage,
    command: Exclude<BuiltinCommand, null>
  ): Promise<void> {
    if (command.type === "start") {
      const lines = [
        "👋 <b>Welcome!</b> I'm your AI assistant on Telegram.",
        "",
        "Just send me a message and I'll respond. Use /help to see available commands.",
      ];
      await adapter.sendMessage(message.chatId, lines.join("\n"));
      return;
    }

    if (command.type === "help") {
      const lines = [
        "<b>Available commands:</b>",
        "",
        "/memory — View and manage stored memories",
        "/memory search &lt;query&gt; — Search memories",
        "/memory edit &lt;id&gt; &lt;text&gt; — Update a memory",
        "/memory delete &lt;id&gt; — Remove a memory",
        "/memory export — Export memories as JSON",
        "/memory clear — Clear all memories",
        "/memory refine — Consolidate and deduplicate memories",
        "/list — List recent executions",
        "/status &lt;id&gt; — Check execution status",
        "/logs &lt;id&gt; — View execution logs",
        "/help — Show this message",
      ];
      await adapter.sendMessage(message.chatId, lines.join("\n"));
      return;
    }

    // Memory commands
    if (command.type === "memory") {
      if (!this.memoryProvider) {
        await adapter.sendMessage(message.chatId, "Memory is not configured. Set MEMORY_CHAT_ID for Telegram-backed memory, or set MEMORY_PROVIDER=mem0 and MEM0_API_KEY for Mem0.");
        return;
      }
      if (adapter.sendMessageWithMarkup) {
        const { text, markup } = buildMemoryListMarkup(this.memoryProvider.all());
        await adapter.sendMessageWithMarkup(message.chatId, text, markup);
      } else {
        const html = formatMemoryList(this.memoryProvider.all());
        await adapter.sendMessage(message.chatId, html);
      }
      return;
    }

    if (command.type === "memory-search") {
      if (!this.memoryProvider) {
        await adapter.sendMessage(message.chatId, "Memory is not configured.");
        return;
      }
      const results = this.memoryProvider.search(command.query);
      const html = results.length > 0
        ? formatMemoryList(results)
        : `No memories matching "${escapeHtml(command.query)}".`;
      await adapter.sendMessage(message.chatId, html);
      return;
    }

    if (command.type === "memory-edit") {
      if (!this.memoryProvider) {
        await adapter.sendMessage(message.chatId, "Memory is not configured.");
        return;
      }
      if (await this.memoryProvider.update(command.id, command.text)) {
        await adapter.sendMessage(message.chatId, `Updated <code>${command.id}</code>.`);
      } else {
        await adapter.sendMessage(message.chatId, `Unknown memory ID: ${command.id}`);
      }
      return;
    }

    if (command.type === "memory-delete") {
      if (!this.memoryProvider) {
        await adapter.sendMessage(message.chatId, "Memory is not configured.");
        return;
      }
      if (await this.memoryProvider.remove(command.id)) {
        await adapter.sendMessage(message.chatId, `Deleted <code>${command.id}</code>.`);
      } else {
        await adapter.sendMessage(message.chatId, `Unknown memory ID: ${command.id}`);
      }
      return;
    }

    if (command.type === "memory-clear") {
      if (!this.memoryProvider) {
        await adapter.sendMessage(message.chatId, "Memory is not configured.");
        return;
      }
      const count = this.memoryProvider.all().length;
      if (count === 0) {
        await adapter.sendMessage(message.chatId, "No memories to clear.");
        return;
      }
      if (adapter.sendMessageWithMarkup) {
        const { text, markup } = buildClearConfirmMarkup(count);
        await adapter.sendMessageWithMarkup(message.chatId, text, markup);
      } else {
        // No inline keyboard support — clear directly
        await this.memoryProvider.clear();
        await adapter.sendMessage(message.chatId, `Cleared all ${count} facts.`);
      }
      return;
    }

    if (command.type === "memory-channel") {
      if (!this.memoryChannelInfo) {
        await adapter.sendMessage(message.chatId, "No memory channel info available.");
        return;
      }
      if (adapter.sendMessageWithMarkup) {
        const { text, markup } = buildChannelInfoMarkup(
          this.memoryChannelInfo.resolvedChatId,
          this.memoryChannelInfo.rawChatId,
          this.memoryChannelInfo.cacheSource
        );
        await adapter.sendMessageWithMarkup(message.chatId, text, markup);
      } else {
        await adapter.sendMessage(
          message.chatId,
          `Memory channel: ${this.memoryChannelInfo.resolvedChatId}` +
          (this.memoryChannelInfo.rawChatId ? ` (configured as ${this.memoryChannelInfo.rawChatId})` : "")
        );
      }
      return;
    }

    if (command.type === "memory-refine") {
      if (!this.memoryProvider) {
        await adapter.sendMessage(message.chatId, "Memory is not configured.");
        return;
      }
      if (!this.refinementScheduler) {
        await adapter.sendMessage(message.chatId, "Memory refinement is not configured. Set ANTHROPIC_API_KEY or OPENAI_BASE_URL + OPENAI_API_KEY to enable.");
        return;
      }
      const factCount = this.memoryProvider.all().length;
      if (factCount < 2) {
        await adapter.sendMessage(message.chatId, "Too few facts to refine.");
        return;
      }
      await adapter.sendMessage(message.chatId, `Refining ${factCount} facts...`);
      try {
        const changelog = await this.refinementScheduler.runNow();
        if (changelog) {
          await adapter.sendMessage(
            message.chatId,
            `Refinement complete: ${changelog.beforeCount} → ${changelog.afterCount} facts` +
            (changelog.updated > 0 ? `, ${changelog.updated} rewritten` : "") +
            (changelog.removed > 0 ? `, ${changelog.removed} removed` : "") +
            (changelog.added > 0 ? `, ${changelog.added} synthesized` : "") +
            ".",
          );
        } else {
          await adapter.sendMessage(message.chatId, "No changes needed.");
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : "unknown";
        await adapter.sendMessage(message.chatId, `Refinement failed: ${escapeHtml(reason)}`);
      }
      return;
    }

    if (command.type === "memory-export") {
      if (!this.memoryProvider) {
        await adapter.sendMessage(message.chatId, "Memory is not configured.");
        return;
      }
      if (adapter.sendDocument) {
        const json = JSON.stringify(this.memoryProvider.all(), null, 2);
        await adapter.sendDocument(message.chatId, Buffer.from(json, "utf-8"), {
          fileName: "memory.json",
          caption: `${this.memoryProvider.all().length} facts exported.`,
        });
      } else {
        await adapter.sendMessage(message.chatId, JSON.stringify(this.memoryProvider.all(), null, 2));
      }
      return;
    }

    if (command.type === "list") {
      const records = this.executionRegistry.list(message.channelId, message.chatId).slice(0, 10);
      if (records.length === 0) {
        await adapter.sendMessage(message.chatId, "Recent executions (this chat):\n• (none)");
        return;
      }

      const lines = records.map((record) => {
        const icon = record.status === "complete" ? "✅" : record.status === "error" ? "❌" : "⏳";
        const endTime = record.finishedAt ?? Date.now();
        const durationStr = formatDuration(endTime - record.startedAt);
        const toolCount = record.toolUses.length;
        const shortId = record.executionId.slice(0, 8);
        const toolInfo = toolCount > 0 ? ` · ${toolCount} tools` : "";
        return `• <code>${shortId}</code> ${icon} ${durationStr}${toolInfo}`;
      });

      await adapter.sendMessage(message.chatId, `<b>Recent executions:</b>\n${lines.join("\n")}`);
      return;
    }

    const record = this.executionRegistry.get(command.executionId);
    if (!record || record.channelId !== message.channelId || record.chatId !== message.chatId) {
      await adapter.sendMessage(message.chatId, `Unknown execution ID: ${command.executionId}`);
      return;
    }

    if (command.type === "status") {
      const endTime = record.finishedAt ?? Date.now();
      const durationMs = endTime - record.startedAt;
      const durationStr = formatDuration(durationMs);
      const toolCount = record.toolUses.length;
      const shortId = record.executionId.slice(0, 8);

      const statusIcon = record.status === "running" ? "⏳" : record.status === "complete" ? "✅" : "❌";
      const statusLabel = record.status === "running" ? "Running" : record.status === "complete" ? "Complete" : "Error";
      const firstLine = `${statusIcon} <b>${statusLabel}</b> (${durationStr}) · <code>${shortId}</code>`;

      const lines: string[] = [firstLine];

      // Tool summary
      if (toolCount > 0) {
        lines.push(`🔧 ${toolCount} tool${toolCount === 1 ? "" : "s"} used`);
      }

      if (record.status === "running") {
        // Show last few tool calls for running executions
        if (toolCount > 0) {
          const recentTools = record.toolUses.slice(-3);
          for (const tool of recentTools) {
            const desc = formatToolDescription(tool.name, tool.input);
            lines.push(`  ▸ ${desc}`);
          }
        }
        const lastLine = record.outputLines[record.outputLines.length - 1];
        if (lastLine) {
          lines.push(`\nLast output: ${escapeHtml(truncate(lastLine, 200))}`);
        }
        await adapter.sendMessage(message.chatId, lines.join("\n"));
        return;
      }

      if (record.status === "complete") {
        lines.push(`Finished: ${new Date(record.finishedAt || Date.now()).toISOString()}`);
        await adapter.sendMessage(message.chatId, lines.join("\n"));
        return;
      }

      lines.push(`Reason: ${escapeHtml(record.errorReason || "unknown")}`);
      await adapter.sendMessage(message.chatId, lines.join("\n"));
      return;
    }

    const lines = record.outputLines;
    await adapter.sendMessage(
      message.chatId,
      lines.length > 0 ? lines.join("\n") : "No output captured for this execution yet."
    );
  }
}
