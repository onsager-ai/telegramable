import { randomUUID } from "crypto";
import { AgentConfig } from "../../config";
import { EventBus } from "../../events/eventBus";
import { parseClaudeUsage } from "../cliRuntime";
import { NativeSessionState, AgentSession } from "./types";
import { NdjsonRunner, spawnAndStreamNdjson } from "./utils";

interface CliEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  parent_tool_use_id?: string | null;
  result?: string;
  is_error?: boolean;
  event?: {
    type?: string;
    delta?: { type?: string; text?: string };
  };
}

export class ClaudeSession implements AgentSession {
  readonly sessionId = randomUUID();
  private state: NativeSessionState | undefined;

  get resumeId(): string | undefined {
    return this.state?.nativeSessionId;
  }

  setResumeId(id: string): void {
    this.state = { strategy: "native", nativeSessionId: id };
  }

  constructor(
    readonly channelId: string,
    readonly chatId: string,
    private readonly config: AgentConfig,
    private readonly run: NdjsonRunner = spawnAndStreamNdjson
  ) { }

  async send(userText: string, executionId: string, eventBus: EventBus): Promise<string> {
    try {
      return await this.execute(userText, executionId, eventBus, this.state?.nativeSessionId);
    } catch {
      if (!this.state) {
        throw new Error("Failed to start Claude session.");
      }

      this.state = undefined;
      return this.execute(userText, executionId, eventBus, undefined);
    }
  }

  async close(): Promise<void> {
    this.state = undefined;
  }

  private async execute(userText: string, executionId: string, eventBus: EventBus, resumeId?: string): Promise<string> {
    const args = [
      ...(this.config.args || []),
      ...(resumeId ? ["--resume", resumeId] : []),
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "-p",
      userText
    ];

    let finalText = "";
    let resultIsError = false;
    let resultArrived = false;

    const result = await this.run(
      this.config.command,
      args,
      {
        cwd: this.config.workingDir,
        env: this.config.env,
        timeoutMs: this.config.timeoutMs
      },
      (raw) => {
        const evt = raw as CliEvent | null;
        if (!evt || typeof evt !== "object") return;

        // Capture native session id on first observation (first-message turns only).
        // Stream-json puts session_id on every event, so the system/init event is
        // the canonical source but any earlier event would also work.
        if (!resumeId && !this.state && typeof evt.session_id === "string" && evt.session_id.length > 0) {
          this.state = { strategy: "native", nativeSessionId: evt.session_id };
        }

        if (evt.type === "stream_event" && evt.event?.type === "content_block_delta") {
          const delta = evt.event.delta;
          if (delta?.type === "text_delta" && typeof delta.text === "string" && delta.text.length > 0) {
            eventBus.emit({
              executionId,
              channelId: this.channelId,
              chatId: this.chatId,
              type: "stream-text",
              timestamp: Date.now(),
              payload: {
                text: delta.text,
                parentToolUseId: evt.parent_tool_use_id ?? undefined
              }
            });
          }
          return;
        }

        if (evt.type === "result") {
          resultArrived = true;
          resultIsError = evt.is_error === true;
          finalText = typeof evt.result === "string" ? evt.result : "";
          eventBus.emit({
            executionId,
            channelId: this.channelId,
            chatId: this.chatId,
            type: "response-end",
            timestamp: Date.now(),
            payload: {
              text: finalText,
              ...(resultIsError ? { reason: "error" } : {})
            }
          });
          const delta = parseClaudeUsage(evt as unknown as Record<string, unknown>);
          if (delta) {
            eventBus.emit({
              executionId,
              channelId: this.channelId,
              chatId: this.chatId,
              type: "usage",
              timestamp: Date.now(),
              payload: { agentName: this.config.name, usage: delta },
            });
          }
          return;
        }

        // Other events (system init, assistant full message echo, user tool_result
        // echo, rate_limit_event, hook lifecycle) carry no user-visible signal here
        // and are intentionally ignored.
      },
      (stderrChunk) => {
        eventBus.emit({
          executionId,
          channelId: this.channelId,
          chatId: this.chatId,
          type: "stderr",
          timestamp: Date.now(),
          payload: { text: stderrChunk }
        });
      }
    );

    if (result.code !== 0) {
      throw new Error(result.stderr || `Claude command exited with code ${result.code ?? "unknown"}.`);
    }

    if (!resultArrived) {
      throw new Error("Claude CLI exited without a result event.");
    }

    if (resultIsError) {
      throw new Error(finalText || "Claude CLI reported an error result.");
    }

    return finalText;
  }
}
