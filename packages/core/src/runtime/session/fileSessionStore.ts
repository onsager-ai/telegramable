import { readFileSync, writeFileSync, mkdirSync, existsSync, accessSync, constants as fsConstants } from "fs";
import { dirname, resolve } from "path";
import { Logger } from "../../logging";

export interface FileSessionEntry {
  id: string;
  /** Epoch ms when this entry was last set or refreshed. `0` for legacy bare-string entries. */
  lastUsedAt: number;
}

/**
 * Simple JSON file store for persisting session resume IDs across restarts.
 * Each runtime type gets its own file (e.g. "cli-sessions.json", "claude-sessions.json").
 *
 * Values are stored as `{ id, lastUsedAt }` so callers can implement idle eviction
 * across process restarts. Legacy bare-string values are coerced to
 * `{ id, lastUsedAt: 0 }` on load, which causes them to be treated as expired on
 * first access — one natural reset, no migration script.
 *
 * If the target directory is not writable (e.g. Railway volume with wrong ownership),
 * the store operates in memory-only mode and logs a warning.
 */
export class FileSessionStore {
  private readonly filePath: string | null;
  private data: Record<string, FileSessionEntry>;

  constructor(dataDir: string, fileName: string, private readonly logger?: Logger) {
    const candidate = resolve(dataDir, fileName);
    this.filePath = this.isWritable(candidate) ? candidate : null;
    this.data = this.load();
  }

  /**
   * Check whether we can write to the target file path.
   * If the file already exists, test it directly; otherwise test the parent directory.
   */
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
        "Session store path is not writable — running in memory-only mode. " +
        "Sessions will not persist across restarts.",
        {
          filePath,
          reason: error instanceof Error ? error.message : "unknown"
        }
      );
      return false;
    }
  }

  get(key: string): FileSessionEntry | undefined {
    return this.data[key];
  }

  set(key: string, id: string, lastUsedAt: number): void {
    this.data[key] = { id, lastUsedAt };
    this.save();
  }

  delete(key: string): void {
    delete this.data[key];
    this.save();
  }

  private load(): Record<string, FileSessionEntry> {
    if (!this.filePath) return {};
    try {
      if (!existsSync(this.filePath)) return {};
      const raw = readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const normalized: Record<string, FileSessionEntry> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === "string") {
          // Legacy bare-string format: coerce to expired entry so the next access
          // triggers idle reset rather than blindly resuming a stale session.
          normalized[key] = { id: value, lastUsedAt: 0 };
        } else if (value && typeof value === "object" && typeof (value as FileSessionEntry).id === "string") {
          const entry = value as FileSessionEntry;
          normalized[key] = {
            id: entry.id,
            lastUsedAt: typeof entry.lastUsedAt === "number" ? entry.lastUsedAt : 0
          };
        }
      }
      return normalized;
    } catch (error) {
      this.logger?.warn("Failed to load session store, starting fresh.", {
        filePath: this.filePath,
        reason: error instanceof Error ? error.message : "unknown"
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
      this.logger?.warn("Failed to save session store.", {
        filePath: this.filePath,
        reason: error instanceof Error ? error.message : "unknown"
      });
    }
  }
}
