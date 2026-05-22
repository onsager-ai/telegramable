export type ExecutionEventType =
  | "start"
  | "queued"
  | "stdout"
  | "stderr"
  | "complete"
  | "error"
  | "permission-request"
  | "permission-response"
  | "stream-text"
  | "tool-use"
  | "thinking"
  | "turn-complete";

export interface ExecutionEvent {
  executionId: string;
  channelId: string;
  chatId: string;
  type: ExecutionEventType;
  timestamp: number;
  threadId?: number;
  payload?: {
    text?: string;
    code?: number | null;
    reason?: string;
    response?: string;
    agentName?: string;

    // Permission request/response fields
    toolName?: string;
    toolInput?: Record<string, unknown>;
    permissionRequestId?: string;
    decision?: "allow" | "deny";

    // Streaming fields
    sessionId?: string;

    // Subagent context — set when the event originates from within a subagent's execution
    parentToolUseId?: string;

    // Source message metadata (e.g. for reactions)
    messageId?: number;

    // turn-complete fields: user's original prompt for memory worker snapshots
    userText?: string;
  };
}
