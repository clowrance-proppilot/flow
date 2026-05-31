export type SessionStatus = "idle" | "running" | "failed";
export type SessionMessageDeliveryMode = "steer" | "followUp";

export interface SessionRef {
  readonly workspaceId: string;
  readonly sessionId: string;
}

export interface WorkspaceRef {
  readonly workspaceId: string;
  readonly path: string;
  readonly displayName?: string;
}

export interface SessionQueuedMessage {
  readonly id: string;
  readonly mode: SessionMessageDeliveryMode;
  readonly text: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SessionSnapshot {
  readonly ref: SessionRef;
  readonly workspace: WorkspaceRef;
  readonly title: string;
  readonly status: SessionStatus;
  readonly updatedAt: string;
  readonly preview?: string;
  readonly runningRunId?: string;
  readonly queuedMessages?: readonly SessionQueuedMessage[];
}

interface SessionEventBase {
  readonly type: string;
  readonly sessionRef: SessionRef;
  readonly timestamp: string;
  readonly runId?: string;
}

export interface SessionUpdatedEvent extends SessionEventBase {
  readonly type: "sessionUpdated";
  readonly snapshot: SessionSnapshot;
}

export interface AssistantDeltaEvent extends SessionEventBase {
  readonly type: "assistantDelta";
  readonly text: string;
}

export interface ToolStartedEvent extends SessionEventBase {
  readonly type: "toolStarted";
  readonly toolName: string;
  readonly callId: string;
  readonly input?: unknown;
}

export interface ToolUpdatedEvent extends SessionEventBase {
  readonly type: "toolUpdated";
  readonly callId: string;
  readonly text?: string;
  readonly progress?: number;
}

export interface ToolFinishedEvent extends SessionEventBase {
  readonly type: "toolFinished";
  readonly callId: string;
  readonly success: boolean;
  readonly output?: unknown;
}

export interface RunCompletedEvent extends SessionEventBase {
  readonly type: "runCompleted";
  readonly snapshot: SessionSnapshot;
}

export interface RunFailedEvent extends SessionEventBase {
  readonly type: "runFailed";
  readonly error: {
    readonly message: string;
    readonly code?: string;
    readonly details?: unknown;
  };
}

export type SessionDriverEvent =
  | SessionUpdatedEvent
  | AssistantDeltaEvent
  | ToolStartedEvent
  | ToolUpdatedEvent
  | ToolFinishedEvent
  | RunCompletedEvent
  | RunFailedEvent;

export type SessionEventListener = (event: SessionDriverEvent) => void | Promise<void>;
export type Unsubscribe = () => void;
