export interface TurnRecord {
  userText: string;
  response: string;
  timestamp: number;
}

export interface WorkerJob {
  channelId: string;
  chatId: string;
  turns: TurnRecord[];
  dispatchedAt: number;
}

export interface WorkerJobRunner {
  run(job: WorkerJob): Promise<void>;
  /** Best-effort termination of any in-flight subprocess. */
  shutdown(): Promise<void>;
}
