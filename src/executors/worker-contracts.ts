import type { WorkerTaskRequest, WorkerTaskResult } from "../contracts.js";

export interface WorkerSpawner {
  run(request: WorkerTaskRequest, onProgress?: WorkerProgressSink): Promise<WorkerTaskResult>;
}

export interface WorkerProgressEvent {
  taskId: string;
  issueRef: string;
  repoKey: string;
  summary: string;
  updatedAt: string;
}

export type WorkerProgressSink = (event: WorkerProgressEvent) => Promise<void> | void;
