import { readFileSync, writeFileSync, mkdirSync, existsSync, accessSync, constants as fsConstants } from "fs";
import { dirname, resolve } from "path";
import { Logger } from "../logging";
import type { UsageDelta } from "../events/types";

const ZERO: UsageDelta = { inputTokens: 0, outputTokens: 0, cacheTokens: 0, costUsd: 0 };

/** YYYY-MM-DD in UTC. UTC is intentional: deterministic across deployments and easy to reason about for billing periods. */
const utcDate = (millis: number): string => {
  const d = new Date(millis);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

/**
 * File-backed token + cost accumulator.
 *
 * Keyed by `${channelId}::${chatId}::${agentName}::${YYYY-MM-DD}` so the hub can
 * sum today's entries or this month's by date-prefix without scanning a full
 * timeseries. Per-turn deltas are added via `add()`; the `/usage` handler reads
 * via `sumToday` / `sumThisMonth`.
 *
 * Mirrors `FileSessionStore`'s writability/load/save pattern: if the target
 * path isn't writable, the store runs in memory-only mode and warns once.
 */
export class FileUsageStore {
  private readonly filePath: string | null;
  private data: Record<string, UsageDelta>;

  constructor(
    dataDir: string,
    fileName: string = "usage.json",
    private readonly logger?: Logger,
    private readonly now: () => number = () => Date.now(),
  ) {
    const candidate = resolve(dataDir, fileName);
    this.filePath = this.isWritable(candidate) ? candidate : null;
    this.data = this.load();
  }

  /** Accumulate a per-turn delta into today's bucket (UTC). */
  add(channelId: string, chatId: string, agentName: string, delta: Partial<UsageDelta>): void {
    const key = this.dayKey(channelId, chatId, agentName, utcDate(this.now()));
    const cur = this.data[key] ?? { ...ZERO };
    this.data[key] = {
      inputTokens: cur.inputTokens + (delta.inputTokens ?? 0),
      outputTokens: cur.outputTokens + (delta.outputTokens ?? 0),
      cacheTokens: cur.cacheTokens + (delta.cacheTokens ?? 0),
      costUsd: cur.costUsd + (delta.costUsd ?? 0),
    };
    this.save();
  }

  /** Sum all entries whose key matches the `${channelId}::${chatId}::${agentName}::${datePrefix}` prefix. */
  sumByPrefix(channelId: string, chatId: string, agentName: string, datePrefix: string): UsageDelta {
    const prefix = `${channelId}::${chatId}::${agentName}::${datePrefix}`;
    const sum: UsageDelta = { ...ZERO };
    for (const [key, entry] of Object.entries(this.data)) {
      if (key.startsWith(prefix)) {
        sum.inputTokens += entry.inputTokens;
        sum.outputTokens += entry.outputTokens;
        sum.cacheTokens += entry.cacheTokens;
        sum.costUsd += entry.costUsd;
      }
    }
    return sum;
  }

  sumToday(channelId: string, chatId: string, agentName: string): UsageDelta {
    return this.sumByPrefix(channelId, chatId, agentName, utcDate(this.now()));
  }

  sumThisMonth(channelId: string, chatId: string, agentName: string): UsageDelta {
    return this.sumByPrefix(channelId, chatId, agentName, utcDate(this.now()).slice(0, 7));
  }

  private dayKey(channelId: string, chatId: string, agentName: string, ymd: string): string {
    return `${channelId}::${chatId}::${agentName}::${ymd}`;
  }

  private isWritable(filePath: string): boolean {
    try {
      if (existsSync(filePath)) {
        accessSync(filePath, fsConstants.W_OK);
      } else {
        const dir = dirname(filePath);
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
        accessSync(dir, fsConstants.W_OK | fsConstants.X_OK);
      }
      return true;
    } catch (error) {
      this.logger?.warn(
        "Usage store path is not writable — running in memory-only mode. Usage will not persist across restarts.",
        { filePath, reason: error instanceof Error ? error.message : "unknown" },
      );
      return false;
    }
  }

  private load(): Record<string, UsageDelta> {
    if (!this.filePath) return {};
    try {
      if (!existsSync(this.filePath)) return {};
      const raw = readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const normalized: Record<string, UsageDelta> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (value && typeof value === "object") {
          const e = value as Partial<UsageDelta>;
          normalized[key] = {
            inputTokens: typeof e.inputTokens === "number" ? e.inputTokens : 0,
            outputTokens: typeof e.outputTokens === "number" ? e.outputTokens : 0,
            cacheTokens: typeof e.cacheTokens === "number" ? e.cacheTokens : 0,
            costUsd: typeof e.costUsd === "number" ? e.costUsd : 0,
          };
        }
      }
      return normalized;
    } catch (error) {
      this.logger?.warn("Failed to load usage store, starting fresh.", {
        filePath: this.filePath,
        reason: error instanceof Error ? error.message : "unknown",
      });
      return {};
    }
  }

  private save(): void {
    if (!this.filePath) return;
    try {
      const dir = dirname(this.filePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), "utf-8");
    } catch (error) {
      this.logger?.warn("Failed to save usage store.", {
        filePath: this.filePath,
        reason: error instanceof Error ? error.message : "unknown",
      });
    }
  }
}
