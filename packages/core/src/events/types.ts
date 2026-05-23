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
  | "response-end"
  | "tool-use"
  | "thinking"
  | "turn-complete"
  | "retry-reset";

/** Result of a tool execution, paired to a tool-use by toolUseId. */
export interface ToolResult {
  /** Joined text content of the tool_result block (string content or text parts of an array). */
  content?: string;
  /** True if the tool_result block was marked is_error. */
  isError?: boolean;
}

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

    /** Anthropic tool_use id (e.g. "toolu_..."). Pairs tool-use to its tool_result. */
    toolUseId?: string;
    /** Set on tool-use events that carry the matching tool_result. */
    toolResult?: ToolResult;

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
