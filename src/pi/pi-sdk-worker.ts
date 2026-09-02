import type { StatefulModuleWorker } from "../core/worker.js";
import type { TaskEnvelope, WorkerResult } from "../protocol/contracts.js";
import { join } from "node:path";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

/** A Pi-backed worker that keeps one AgentSession alive for multiple tasks. */
export class PiSdkWorker implements StatefulModuleWorker {
  private session?: AgentSession;
  private unsubscribe?: () => void;
  private workingDirectory?: string;

  public constructor(
    private readonly workerName: string,
    private readonly onText: (text: string) => void = (text) => process.stdout.write(text)
  ) {}

  public async start(): Promise<void> {
    // Session creation is lazy because the task supplies the module cwd.
  }

  private async ensureSession(task: TaskEnvelope): Promise<AgentSession> {
    if (this.session) {
      if (this.workingDirectory !== task.workingDirectory) {
        throw new Error(`Worker ${this.workerName} is already bound to ${this.workingDirectory}`);
      }
      return this.session;
    }

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
    this.session = session;
    this.workingDirectory = task.workingDirectory;
    this.unsubscribe = session.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        this.onText(event.assistantMessageEvent.delta);
      }
    });
    return session;
  }

  public async run(task: TaskEnvelope): Promise<WorkerResult> {
    const session = await this.ensureSession(task);
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

  public async close(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.session?.dispose();
    this.session = undefined;
    this.workingDirectory = undefined;
  }
}
