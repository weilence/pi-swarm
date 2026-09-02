import type { ModuleWorker } from "../core/worker.js";
import type { TaskEnvelope, WorkerResult } from "../protocol/contracts.js";

/** Prototype-only worker. Replace with PiSdkWorker once the Pi version is pinned. */
export class MockPiWorker implements ModuleWorker {
  public async run(task: TaskEnvelope): Promise<WorkerResult> {
    await new Promise((resolve) => setTimeout(resolve, 50));
    return {
      taskId: task.taskId,
      module: task.module,
      status: "completed",
      changedFiles: [`${task.module}/src/prototype-change.ts`],
      tests: task.requiredTests.map((command) => ({ command, status: "passed" })),
      risks: [],
      messages: []
    };
  }
}
