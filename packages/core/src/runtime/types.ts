import { EventBus } from "../events/eventBus";
import { IMMessage } from "../gateway/types";

export interface Runtime {
  execute: (message: IMMessage, executionId: string, eventBus: EventBus) => Promise<void>;
  /**
   * Optional best-effort cleanup hook called during graceful shutdown.
   * Implementations should release runtime-owned resources (e.g. SIGTERM child
   * processes) within `graceMs` and then return.
   */
  shutdown?: (graceMs?: number) => Promise<void>;
}
