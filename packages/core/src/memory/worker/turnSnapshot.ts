import { TurnRecord } from "./types";

/** Snapshot file is truncated to the most recent N turns to bound input size. */
export const MAX_TURNS_PER_SNAPSHOT = 50;

/**
 * Build the prompt-file body the memory worker passes to its Claude Code
 * subprocess. The current memory facts are intentionally NOT repeated here —
 * they are injected via --append-system-prompt at spawn time, which keeps the
 * snapshot stable across changing memory state.
 */
export const formatTurnSnapshot = (turns: ReadonlyArray<TurnRecord>): string => {
  const recent = turns.length > MAX_TURNS_PER_SNAPSHOT ? turns.slice(-MAX_TURNS_PER_SNAPSHOT) : turns;

  const lines: string[] = ["=== Conversation since last memory update ==="];
  for (const turn of recent) {
    lines.push(`[user] ${turn.userText}`);
    lines.push(`[assistant] ${turn.response}`);
  }
  lines.push("");
  lines.push("=== Current memory facts ===");
  lines.push("(injected via system prompt — no need to repeat here)");
  lines.push("");
  lines.push("=== Task ===");
  lines.push("Review the conversation above. Be conservative — only record durable facts:");
  lines.push("- Projects the user is working on");
  lines.push("- Stable personal context (role, location, preferences)");
  lines.push("- Architectural decisions");
  lines.push("Skip transient questions, one-off lookups, and trivial details.");

  return lines.join("\n");
};
