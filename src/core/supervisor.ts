import { EventBus } from "./event-bus.ts";
import { describeError, type StepRecord } from "./task-run.ts";

/** One step handed to an agent runner. */
export interface StepJob {
  id: string;
  goal: string;
  agent: string;
}

/** Anything that can execute a step: today a Pi-backed Agent from createAgent. */
export interface StepRunner {
  run(step: StepJob): Promise<StepRecord>;
  close?(): Promise<void> | void;
}

/**
 * Resolves and runs steps on lazily created agent runners, containing failures
 * into failed StepRecords and publishing task lifecycle events. Batch
 * composition, dependencies, and concurrency live in the delegate tool.
 */
export class Supervisor {
  private readonly runners = new Map<string, StepRunner>();

  public constructor(
    private readonly resolveRunner: (agent: string) => StepRunner,
    private readonly events: EventBus
  ) {}

  public async run(job: StepJob): Promise<StepRecord> {
    this.events.publish({
      eventId: `${job.id}:started`,
      taskId: job.id,
      type: "task.started",
      source: job.agent,
      target: [],
      summary: job.goal,
      artifacts: []
    });
    let record: StepRecord;
    try {
      record = await this.runnerFor(job.agent).run(job);
    } catch (error) {
      record = {
        id: job.id,
        agent: job.agent,
        goal: job.goal,
        status: "failed",
        summary: "",
        changedFiles: [],
        toolCalls: 0,
        error: describeError(error)
      };
    }
    this.events.publish({
      eventId: `${job.id}:finished`,
      taskId: job.id,
      type: record.status === "completed" ? "task.completed" : "task.blocked",
      source: job.agent,
      target: [],
      summary: `${record.status}；${record.changedFiles.length} 个文件变更`,
      artifacts: record.changedFiles
    });
    return record;
  }

  private runnerFor(agent: string): StepRunner {
    const existing = this.runners.get(agent);
    if (existing) return existing;
    const runner = this.resolveRunner(agent);
    this.runners.set(agent, runner);
    return runner;
  }

  public async close(): Promise<void> {
    await Promise.all([...this.runners.values()].map((runner) => runner.close?.()));
    this.runners.clear();
  }
}
