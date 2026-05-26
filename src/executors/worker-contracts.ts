export interface WorkerProgressEvent {
  taskId: string;
  issueRef: string;
  repoKey: string;
  summary: string;
  updatedAt: string;
}

export type WorkerProgressSink = (event: WorkerProgressEvent) => Promise<void> | void;
