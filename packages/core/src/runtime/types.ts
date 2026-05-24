import { EventBus } from "../events/eventBus";
import { IMMessage } from "../gateway/types";
import { SessionStore } from "./session/sessionStore";

export interface Runtime {
  execute: (message: IMMessage, executionId: string, eventBus: EventBus) => Promise<void>;
  /**
   * Optional best-effort cleanup hook called during graceful shutdown.
   * Implementations should release runtime-owned resources (e.g. SIGTERM child
   * processes) within `graceMs` and then return.
   */
  shutdown?: (graceMs?: number) => Promise<void>;
  /**
   * Multi-session metadata store, exposed for the hub's `/sessions` / `/new` UX.
   * Undefined for runtimes without a persistent metadata store.
   */
  readonly sessionStore?: SessionStore;
  /**
   * Agent name this runtime was created for — used by the hub when composing
   * the SessionStore key `${channelId}::${chatId}::${agentName}`.
   */
  readonly agentName?: string;
}
