import { EventBus } from "./event-bus.js";
import { ModuleRegistry } from "./module-registry.js";
import type { StatefulModuleWorker } from "./worker.js";
import type { TaskEnvelope, WorkerResult } from "../protocol/contracts.js";

export class Supervisor {
  public constructor(
    private readonly registry: ModuleRegistry,
    private readonly workers: Map<string, StatefulModuleWorker>,
    private readonly events: EventBus
  ) {}

  public async start(): Promise<void> {
    await Promise.all([...this.workers.values()].map((worker) => worker.start?.()));
  }

  public async close(): Promise<void> {
    await Promise.all([...this.workers.values()].map((worker) => worker.close?.()));
  }

  public async dispatch(tasks: TaskEnvelope[]): Promise<WorkerResult[]> {
    for (const task of tasks) {
      this.registry.get(task.module);
      if (!this.workers.has(task.module)) {
        throw new Error(`No worker registered for module: ${task.module}`);
      }
    }

    const results = await Promise.all(
      tasks.map(async (task) => {
        this.events.publish({
          eventId: `${task.taskId}:started`,
          taskId: task.taskId,
          type: "task.started",
          sourceModule: task.module,
          targetModules: task.relatedModules,
          summary: task.goal,
          artifacts: []
        });
        const result = await this.workers.get(task.module)!.run(task);
        this.events.publish({
          eventId: `${task.taskId}:completed`,
          taskId: task.taskId,
          type: result.status === "completed" ? "task.completed" : "task.blocked",
          sourceModule: task.module,
          targetModules: task.relatedModules,
          summary: `${result.status}; ${result.changedFiles.length} file(s) changed`,
          artifacts: result.changedFiles
        });
        return result;
      })
    );

    return results;
  }
}
