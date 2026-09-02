import type { TaskEnvelope, WorkerResult } from "../protocol/contracts.js";

export interface ModuleWorker {
  run(task: TaskEnvelope): Promise<WorkerResult>;
}
