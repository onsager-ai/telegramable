import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeSync,
} from "fs";
import { dirname, join } from "path";
import { Logger } from "../../logging";
import { TurnRecord } from "./types";

interface PendingTurnsFile {
  v: number;
  channelId: string;
  chatId: string;
  turns: TurnRecord[];
}

export interface FailedAttempt {
  channelId: string;
  chatId: string;
  dispatchedAt: number;
  attempts: number;
  turnCount: number;
  lastError: string;
  droppedAt: number;
}

const FILE_VERSION = 1;

// Sanitize a Telegram channel/chat id for use as a path segment.  The sanitized
// name is *not* required to round-trip — original ids are stored inside the
// JSON file, so this only needs to produce a valid filesystem path.
const sanitize = (s: string): string => s.replace(/[^\w-]/g, "_").slice(0, 64);

const writeAtomicJson = (filePath: string, data: unknown): void => {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  const json = JSON.stringify(data, null, 2);
  const fd = openSync(tmpPath, "w", 0o600);
  try {
    writeSync(fd, json);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmpPath, filePath);
};

/**
 * File-backed store for the IdleScheduler's pendingTurns and the worker
 * queue's failed-attempt audit log.  Layout:
 *
 *   {baseDir}/{sanitize(channelId)}/{sanitize(chatId)}/pending.json
 *   {baseDir}/{sanitize(channelId)}/{sanitize(chatId)}/failed-attempts.json (NDJSON)
 *
 * The original (un-sanitized) channelId and chatId are stored inside the JSON
 * file so loadAll() can reconstruct them faithfully even when sanitization is
 * lossy.
 */
export class PendingTurnsStore {
  constructor(private readonly baseDir: string, private readonly logger?: Logger) {}

  private channelDir(channelId: string, chatId: string): string {
    return join(this.baseDir, sanitize(channelId), sanitize(chatId));
  }

  private pendingPath(channelId: string, chatId: string): string {
    return join(this.channelDir(channelId, chatId), "pending.json");
  }

  private failedPath(channelId: string, chatId: string): string {
    return join(this.channelDir(channelId, chatId), "failed-attempts.json");
  }

  /**
   * Walk the baseDir and load every pending.json. Malformed or unreadable
   * files are logged and skipped rather than failing the whole load.
   */
  loadAll(): Array<{ channelId: string; chatId: string; turns: TurnRecord[] }> {
    const result: Array<{ channelId: string; chatId: string; turns: TurnRecord[] }> = [];
    if (!existsSync(this.baseDir)) return result;

    let channelDirs: string[];
    try {
      channelDirs = readdirSync(this.baseDir);
    } catch (err) {
      this.logger?.warn("PendingTurnsStore: failed to enumerate baseDir.", {
        baseDir: this.baseDir,
        reason: err instanceof Error ? err.message : "unknown",
      });
      return result;
    }

    for (const channelDirName of channelDirs) {
      const channelPath = join(this.baseDir, channelDirName);
      try {
        if (!statSync(channelPath).isDirectory()) continue;
      } catch {
        continue;
      }

      let chatDirs: string[];
      try {
        chatDirs = readdirSync(channelPath);
      } catch {
        continue;
      }

      for (const chatDirName of chatDirs) {
        const pendingPath = join(channelPath, chatDirName, "pending.json");
        if (!existsSync(pendingPath)) continue;
        try {
          const raw = readFileSync(pendingPath, "utf-8");
          const parsed = JSON.parse(raw) as PendingTurnsFile;
          if (parsed.v !== FILE_VERSION || !Array.isArray(parsed.turns)) {
            this.logger?.warn("PendingTurnsStore: dropping malformed pending file.", { pendingPath });
            continue;
          }
          result.push({
            channelId: parsed.channelId,
            chatId: parsed.chatId,
            turns: parsed.turns,
          });
        } catch (err) {
          this.logger?.warn("PendingTurnsStore: failed to read pending file.", {
            pendingPath,
            reason: err instanceof Error ? err.message : "unknown",
          });
        }
      }
    }

    return result;
  }

  save(channelId: string, chatId: string, turns: ReadonlyArray<TurnRecord>): void {
    const file: PendingTurnsFile = {
      v: FILE_VERSION,
      channelId,
      chatId,
      turns: [...turns],
    };
    writeAtomicJson(this.pendingPath(channelId, chatId), file);
  }

  /** Append-only NDJSON audit log of batches that exhausted their retry cap. */
  appendFailedAttempt(entry: FailedAttempt): void {
    const path = this.failedPath(entry.channelId, entry.chatId);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(entry) + "\n", { mode: 0o600 });
  }

  /** Read all audit entries — used by tests / observability. */
  readFailedAttempts(channelId: string, chatId: string): FailedAttempt[] {
    const path = this.failedPath(channelId, chatId);
    if (!existsSync(path)) return [];
    const raw = readFileSync(path, "utf-8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as FailedAttempt);
  }
}
