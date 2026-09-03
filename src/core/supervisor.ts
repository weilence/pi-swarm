import { EventBus } from "./event-bus.ts";
import type { StepRequest, StepResult } from "../protocol/contracts.ts";

/** Anything that can execute a step: today the Pi-backed SubAgent. */
export interface StepRunner {
  run(request: StepRequest): Promise<StepResult>;
  close?(): Promise<void> | void;
}

/**
 * Thin dispatcher over lazily resolved agent runners: runs each step's agent
 * session in parallel and publishes task lifecycle events. Routing decisions
 * (which agent, or supervisor self-execution) live in the Orchestrator.
 */
export class Supervisor {
  private readonly runners = new Map<string, StepRunner>();

  public constructor(
    private readonly resolveRunner: (agent: string) => StepRunner,
    private readonly events: EventBus
  ) {}

  public async dispatch(requests: StepRequest[]): Promise<StepResult[]> {
    const resolved = requests.map((request) => ({ request, runner: this.runnerFor(request.agent) }));
    return await Promise.all(
      resolved.map(async ({ request, runner }) => {
        this.events.publish({
          eventId: `${request.taskId}:started`,
          taskId: request.taskId,
          type: "task.started",
          source: request.agent,
          target: [],
          summary: request.goal,
          artifacts: []
        });
        const result = await runner.run(request);
        this.events.publish({
          eventId: `${request.taskId}:completed`,
          taskId: request.taskId,
          type: result.status === "completed" ? "task.completed" : "task.blocked",
          source: request.agent,
          target: [],
          summary: `${result.status}; ${result.changedFiles.length} file(s) changed`,
          artifacts: result.changedFiles
        });
        return result;
      })
    );
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
