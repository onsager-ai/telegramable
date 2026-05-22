import { EventBus } from "../../events/eventBus";
import { Logger } from "../../logging";
import { TurnRecord, WorkerJob } from "./types";

export interface ChannelState {
  channelId: string;
  chatId: string;
  lastTurnAt: number;
  /** Cleared when markSuccess runs; lets the scheduler know writes are durable. */
  lastWorkerRunAt: number;
  /** Turns accumulated since the last successful worker dispatch. */
  pendingTurns: TurnRecord[];
}

export interface IdleSchedulerOptions {
  idleThresholdMs?: number;
  tickIntervalMs?: number;
  /** Override `Date.now` — used in tests with fake clocks. */
  now?: () => number;
  logger?: Logger;
}

const DEFAULT_IDLE_THRESHOLD_MS = 300_000;
const DEFAULT_TICK_INTERVAL_MS = 30_000;

const envInt = (name: string): number | undefined => {
  const raw = process.env[name];
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

/**
 * Per-channel scheduler that batches turn records and dispatches a worker job
 * when the channel has been idle for long enough.
 *
 * Idleness criteria for a channel:
 *   - has pending turns
 *   - no worker dispatch has run since the latest turn arrived
 *   - now - lastTurnAt > idleThresholdMs
 *
 * `pendingTurns` is NOT cleared at dispatch time — only on `markSuccess`. This
 * keeps a failed worker run from silently dropping the batch.
 */
export class IdleScheduler {
  private readonly channels = new Map<string, ChannelState>();
  private readonly idleThresholdMs: number;
  private readonly tickIntervalMs: number;
  private readonly now: () => number;
  private readonly logger?: Logger;
  private tickTimer?: ReturnType<typeof setInterval>;
  private unsubscribe?: () => void;
  private onDispatch?: (job: WorkerJob) => void;

  constructor(options: IdleSchedulerOptions = {}) {
    this.idleThresholdMs = options.idleThresholdMs ?? envInt("MEMORY_IDLE_THRESHOLD_MS") ?? DEFAULT_IDLE_THRESHOLD_MS;
    this.tickIntervalMs = options.tickIntervalMs ?? envInt("MEMORY_WORKER_TICK_MS") ?? DEFAULT_TICK_INTERVAL_MS;
    this.now = options.now ?? Date.now;
    this.logger = options.logger;
  }

  start(eventBus: EventBus, dispatch: (job: WorkerJob) => void): void {
    if (this.unsubscribe) return; // idempotent

    this.onDispatch = dispatch;
    this.unsubscribe = eventBus.on((event) => {
      if (event.type !== "turn-complete") return;
      const userText = event.payload?.userText;
      const response = event.payload?.response;
      if (!userText || !response) return;
      this.recordTurn(event.channelId, event.chatId, {
        userText,
        response,
        timestamp: event.timestamp,
      });
    });

    this.tickTimer = setInterval(() => this.tick(), this.tickIntervalMs);
    // Don't keep the event loop alive solely for this timer.
    if (typeof this.tickTimer?.unref === "function") this.tickTimer.unref();

    this.logger?.info("Memory IdleScheduler started.", {
      idleThresholdMs: this.idleThresholdMs,
      tickIntervalMs: this.tickIntervalMs,
    });
  }

  stop(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = undefined;
    }
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.onDispatch = undefined;
  }

  recordTurn(channelId: string, chatId: string, turn: TurnRecord): void {
    const key = this.channelKey(channelId, chatId);
    let state = this.channels.get(key);
    if (!state) {
      state = {
        channelId,
        chatId,
        lastTurnAt: turn.timestamp,
        lastWorkerRunAt: 0,
        pendingTurns: [],
      };
      this.channels.set(key, state);
    }
    state.pendingTurns.push(turn);
    if (turn.timestamp > state.lastTurnAt) state.lastTurnAt = turn.timestamp;
  }

  /** Force a scheduling check.  Public so tests can drive deterministically. */
  tick(): void {
    if (!this.onDispatch) return;
    const now = this.now();
    for (const state of this.channels.values()) {
      if (state.pendingTurns.length === 0) continue;
      if (state.lastWorkerRunAt >= state.lastTurnAt) continue;
      if (now - state.lastTurnAt < this.idleThresholdMs) continue;

      const job: WorkerJob = {
        channelId: state.channelId,
        chatId: state.chatId,
        turns: state.pendingTurns.slice(),
        dispatchedAt: now,
      };
      // Mark dispatch time so we don't re-enqueue while the worker is in flight.
      state.lastWorkerRunAt = now;
      this.logger?.info("Memory worker enqueued.", {
        channelId: state.channelId,
        chatId: state.chatId,
        turnCount: state.pendingTurns.length,
      });
      this.onDispatch(job);
    }
  }

  /** Called by the worker queue when a job succeeds. Clears only that batch. */
  markSuccess(channelId: string, chatId: string, dispatchedAt: number): void {
    const state = this.channels.get(this.channelKey(channelId, chatId));
    if (!state) return;
    // Only drop turns that were part of the dispatched batch.  New turns that
    // arrived after dispatchedAt must survive for the next idle cycle.
    state.pendingTurns = state.pendingTurns.filter((t) => t.timestamp > dispatchedAt);
  }

  /** Called by the worker queue when a job fails — undoes the lastWorkerRunAt bump. */
  markFailure(channelId: string, chatId: string, dispatchedAt: number): void {
    const state = this.channels.get(this.channelKey(channelId, chatId));
    if (!state) return;
    // Only reset if no newer dispatch has happened.
    if (state.lastWorkerRunAt === dispatchedAt) {
      state.lastWorkerRunAt = 0;
    }
  }

  getChannelState(channelId: string, chatId: string): Readonly<ChannelState> | undefined {
    return this.channels.get(this.channelKey(channelId, chatId));
  }

  private channelKey(channelId: string, chatId: string): string {
    return `${channelId}::${chatId}`;
  }
}
