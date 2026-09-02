export type ModuleId = string;

export interface ModuleDefinition {
  id: ModuleId;
  path: string;
  contextFiles: string[];
  allowedPaths: string[];
  testCommand: string;
  contractCommand: string;
}

export interface TaskEnvelope {
  taskId: string;
  module: ModuleId;
  goal: string;
  workingDirectory: string;
  contextFiles: string[];
  allowedPaths: string[];
  relatedModules: ModuleId[];
  requiredTests: string[];
}

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
  sourceModule: ModuleId;
  targetModules: ModuleId[];
  summary: string;
  artifacts: string[];
}

export interface TestResult {
  command: string;
  status: "passed" | "failed" | "skipped";
  output?: string;
}

export interface WorkerResult {
  taskId: string;
  module: ModuleId;
  status: "completed" | "blocked" | "failed";
  changedFiles: string[];
  tests: TestResult[];
  risks: string[];
  messages: EventEnvelope[];
}
