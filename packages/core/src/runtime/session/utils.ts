import { spawn } from "child_process";
import { existsSync } from "fs";

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

export type CommandRunner = (
  command: string,
  args: string[],
  options?: {
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
  },
  onChunk?: (type: "stdout" | "stderr", text: string) => void
) => Promise<CommandResult>;

const toSpawnError = (error: unknown, command: string, cwd?: string): Error => {
  if (error instanceof Error && "code" in error && error.code === "ENOENT") {
    if (cwd && !existsSync(cwd)) {
      return new Error(`Working directory not found: ${cwd}`);
    }
    return new Error(
      `Command not found: "${command}". Ensure it is installed and available in PATH.`
    );
  }
  return error instanceof Error ? error : new Error(String(error));
};

export const stripAnsi = (text: string): string => {
  return text.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
};

const SESSION_PATTERNS = [
  /session\s*id\s*[:=]\s*([a-zA-Z0-9._-]+)/i,
  /chat\s*id\s*[:=]\s*([a-zA-Z0-9._-]+)/i,
  /--resume\s+([a-zA-Z0-9._-]+)/i,
  /--chat-id\s+([a-zA-Z0-9._-]+)/i
];

export const parseNativeId = (output: string): string | undefined => {
  for (const pattern of SESSION_PATTERNS) {
    const match = output.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }
  return undefined;
};

export const spawnAndCollect: CommandRunner = async (command, args, options) => {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options?.cwd,
      shell: true,
      env: {
        ...process.env,
        ...(options?.env || {})
      }
    });

    let stdout = "";
    let stderr = "";

    const timeoutMs = options?.timeoutMs ?? 10 * 60 * 1000;
    let timeout: ReturnType<typeof setTimeout>;
    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("Runtime timeout."));
      }, timeoutMs);
    };
    resetTimeout();

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      resetTimeout();
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      resetTimeout();
    });

    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(toSpawnError(error, command, options?.cwd));
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ stdout, stderr, code });
    });
  });
};

export type NdjsonRunner = (
  command: string,
  args: string[],
  options?: {
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
  },
  onJson?: (event: unknown) => void,
  onStderr?: (text: string) => void
) => Promise<{ code: number | null; stderr: string }>;

/**
 * Spawn a process that emits newline-delimited JSON on stdout. Each complete
 * line is JSON-parsed and forwarded via `onJson`; non-JSON lines (CLI warnings,
 * blank lines, partial mid-stream) are skipped silently. Stderr is plain text.
 *
 * Used by the Claude CLI runtime to react to `result` events ahead of process
 * exit — the multi-second shutdown tail no longer delays draft finalization.
 */
export const spawnAndStreamNdjson: NdjsonRunner = async (command, args, options, onJson, onStderr) => {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options?.cwd,
      shell: true,
      env: {
        ...process.env,
        ...(options?.env || {})
      }
    });

    let stderr = "";
    let buffer = "";

    const timeoutMs = options?.timeoutMs ?? 10 * 60 * 1000;
    let timeout: ReturnType<typeof setTimeout>;
    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("Runtime timeout."));
      }, timeoutMs);
    };
    resetTimeout();

    const dispatch = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const obj = JSON.parse(trimmed);
        onJson?.(obj);
      } catch {
        // Non-JSON output (warnings, banners) — drop silently. The CLI puts
        // operational messages on stderr, so this should be rare.
      }
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      resetTimeout();
      let newlineIdx = buffer.indexOf("\n");
      while (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        dispatch(line);
        newlineIdx = buffer.indexOf("\n");
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      resetTimeout();
      onStderr?.(text);
    });

    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(toSpawnError(error, command, options?.cwd));
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      // Trailing partial line (no terminating newline) is discarded — the CLI
      // always newline-terminates events, and a half-line can't be parsed.
      buffer = "";
      resolve({ stderr, code });
    });
  });
};

export const spawnAndStream: CommandRunner = async (command, args, options, onChunk) => {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options?.cwd,
      shell: true,
      env: {
        ...process.env,
        ...(options?.env || {})
      }
    });

    let stdout = "";
    let stderr = "";

    const timeoutMs = options?.timeoutMs ?? 10 * 60 * 1000;
    let timeout: ReturnType<typeof setTimeout>;
    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("Runtime timeout."));
      }, timeoutMs);
    };
    resetTimeout();

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      resetTimeout();
      onChunk?.("stdout", text);
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      resetTimeout();
      onChunk?.("stderr", text);
    });

    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(toSpawnError(error, command, options?.cwd));
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ stdout, stderr, code });
    });
  });
};