export type EventType =
  | "task.started"
  | "task.completed"
  | "task.blocked"
  | "contract.changed"
  | "test.failed"
  | "integration.blocked";

export interface EventEnvelope {
  eventId: string;
  taskId: string;
  type: EventType;
  /** Agent name that produced the event. */
  source: string;
  target: string[];
  summary: string;
  artifacts: string[];
}

export interface TestResult {
  command: string;
  status: "passed" | "failed" | "skipped";
  output?: string;
}

/** One planned step handed to an agent session for execution. */
export interface StepRequest {
  taskId: string;
  /** Agent name; "supervisor" marks supervisor self-execution. */
  agent: string;
  goal: string;
}

export interface StepResult {
  taskId: string;
  agent: string;
  status: "completed" | "blocked" | "failed";
  changedFiles: string[];
  tests: TestResult[];
  risks: string[];
  messages: EventEnvelope[];
}
