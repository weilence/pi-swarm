import type { TaskEnvelope, WorkerResult } from "../protocol/contracts.js";

export interface ModuleWorker {
  run(task: TaskEnvelope): Promise<WorkerResult>;
}

/** Optional lifecycle for workers that keep a session alive across tasks. */
export interface StatefulModuleWorker extends ModuleWorker {
  start?(): Promise<void>;
  close?(): Promise<void> | void;
}
