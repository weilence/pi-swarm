import type { ModuleWorker } from "../core/worker.js";
import type { TaskEnvelope, WorkerResult } from "../protocol/contracts.js";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

export class PiSdkWorker implements ModuleWorker {
  public constructor(private readonly workerName: string) {}

  public async run(task: TaskEnvelope): Promise<WorkerResult> {
    const resourceLoader = new DefaultResourceLoader({
      cwd: task.workingDirectory,
      agentDir: join(task.workingDirectory, ".pi-agent"),
      appendSystemPromptOverride: (base) => [
        ...base,
        `You are the ${this.workerName} module worker. Read these files before acting: ${task.contextFiles.join(", ")}.`,
        `Only modify paths allowed by the task: ${task.allowedPaths.join(", ")}.`,
        "At the end, summarize changed files, tests, risks, and cross-module messages."
      ]
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd: task.workingDirectory,
      resourceLoader,
      sessionManager: SessionManager.inMemory()
    });
    await session.prompt([
      `Task ${task.taskId}: ${task.goal}`,
      `Related modules: ${task.relatedModules.join(", ") || "none"}`,
      `Required tests: ${task.requiredTests.join(", ")}`
    ].join("\n"));

    return {
      taskId: task.taskId,
      module: task.module,
      status: "completed",
      changedFiles: [],
      tests: task.requiredTests.map((command) => ({ command, status: "skipped" })),
      risks: ["Pi response parsing and changed-file collection are not automated in the prototype."],
      messages: []
    };
  }
}
