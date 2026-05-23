import { ToolResult } from "../events/types";
import { stripAnsi } from "../runtime/session/utils";

export interface ToolUseRecord {
  name: string;
  input?: Record<string, unknown>;
  timestamp: number;
  /** Anthropic tool_use id ("toolu_..."), used to pair this record with its tool_result. */
  toolUseId?: string;
  /** Result of the tool execution, populated when the matching tool_result arrives. */
  result?: ToolResult;
}

export interface ExecutionRecord {
  executionId: string;
  channelId: string;
  chatId: string;
  agentName: string;
  status: "running" | "complete" | "error";
  startedAt: number;
  finishedAt?: number;
  outputLines: string[];
  errorReason?: string;
  /** Tool calls made during this execution, in chronological order. */
  toolUses: ToolUseRecord[];
}

export interface ExecutionRegistry {
  start(params: {
    executionId: string;
    channelId: string;
    chatId: string;
    agentName: string;
    startedAt: number;
  }): void;
  append(executionId: string, text: string): void;
  trackToolUse(
    executionId: string,
    name: string,
    input?: Record<string, unknown>,
    toolUseId?: string,
  ): void;
  trackToolResult(executionId: string, toolUseId: string, result: ToolResult): void;
  complete(executionId: string, finishedAt: number): void;
  error(executionId: string, reason: string, finishedAt: number): void;
  get(executionId: string): ExecutionRecord | undefined;
  list(channelId: string, chatId: string): ExecutionRecord[];
}

interface InMemoryExecutionRegistryOptions {
  maxLines?: number;
  ttlMs?: number;
  now?: () => number;
}

const DEFAULT_MAX_LINES = 200;
const DEFAULT_TTL_MS = 60 * 60 * 1_000;

export class InMemoryExecutionRegistry implements ExecutionRegistry {
  private readonly maxLines: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly records = new Map<string, ExecutionRecord>();

  constructor(options: InMemoryExecutionRegistryOptions = {}) {
    this.maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  start(params: {
    executionId: string;
    channelId: string;
    chatId: string;
    agentName: string;
    startedAt: number;
  }): void {
    this.pruneExpired();
    this.records.set(params.executionId, {
      executionId: params.executionId,
      channelId: params.channelId,
      chatId: params.chatId,
      agentName: params.agentName,
      status: "running",
      startedAt: params.startedAt,
      outputLines: [],
      toolUses: []
    });
  }

  append(executionId: string, text: string): void {
    const record = this.records.get(executionId);
    if (!record) {
      return;
    }

    const cleaned = stripAnsi(text);
    const lines = cleaned
      .split("\n")
      .map((line) => line.replace(/\r/g, "").trimEnd())
      .filter((line) => line.length > 0);

    if (lines.length === 0) {
      return;
    }

    record.outputLines.push(...lines);
    if (record.outputLines.length > this.maxLines) {
      record.outputLines.splice(0, record.outputLines.length - this.maxLines);
    }
  }

  trackToolUse(
    executionId: string,
    name: string,
    input?: Record<string, unknown>,
    toolUseId?: string,
  ): void {
    const record = this.records.get(executionId);
    if (!record) {
      return;
    }

    // If this is an enriched update for a tool-use that was already recorded
    // by toolUseId (input arrived after the initial name-only event), update
    // the existing record in-place rather than duplicating.
    if (toolUseId) {
      const existing = record.toolUses.find((t) => t.toolUseId === toolUseId);
      if (existing) {
        if (input && Object.keys(input).length > 0 && !existing.input) {
          existing.input = { ...input };
        }
        return;
      }
    }

    record.toolUses.push({
      name,
      input: input ? { ...input } : undefined,
      timestamp: this.now(),
      toolUseId,
    });

    if (record.toolUses.length > this.maxLines) {
      record.toolUses.splice(0, record.toolUses.length - this.maxLines);
    }
  }

  trackToolResult(executionId: string, toolUseId: string, result: ToolResult): void {
    const record = this.records.get(executionId);
    if (!record) {
      return;
    }
    // Pair to the existing tool_use by id. Walk from the end since results
    // usually arrive near the tool-use they belong to.
    for (let i = record.toolUses.length - 1; i >= 0; i--) {
      if (record.toolUses[i].toolUseId === toolUseId) {
        record.toolUses[i].result = result;
        return;
      }
    }
    // No matching tool_use — silently drop. Result without a use is unrenderable.
  }

  complete(executionId: string, finishedAt: number): void {
    const record = this.records.get(executionId);
    if (!record) {
      return;
    }

    record.status = "complete";
    record.finishedAt = finishedAt;
    record.errorReason = undefined;
  }

  error(executionId: string, reason: string, finishedAt: number): void {
    const record = this.records.get(executionId);
    if (!record) {
      return;
    }

    record.status = "error";
    record.finishedAt = finishedAt;
    record.errorReason = reason;
  }

  get(executionId: string): ExecutionRecord | undefined {
    return this.records.get(executionId);
  }

  list(channelId: string, chatId: string): ExecutionRecord[] {
    this.pruneExpired();

    return Array.from(this.records.values())
      .filter((record) => record.channelId === channelId && record.chatId === chatId)
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  private pruneExpired(): void {
    const cutoff = this.now() - this.ttlMs;

    for (const record of this.records.values()) {
      if (record.status === "running") {
        continue;
      }
      if ((record.finishedAt ?? 0) < cutoff) {
        this.records.delete(record.executionId);
      }
    }
  }
}
