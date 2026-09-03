import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

export interface ToolObservation {
  toolCalls: number;
  errors: string[];
  changedFiles: string[];
}

/**
 * Ground-truth collector over agent session events. Tool events — not the
 * model's self-report — are the source of truth: every completed tool call is
 * counted, errored ones are recorded, and file-mutating calls (`edit`/`write`,
 * which carry `path` in their arguments) contribute to changedFiles.
 */
export class ToolObservationCollector {
  private readonly files = new Set<string>();
  private calls = 0;
  private readonly problems: string[] = [];

  public handle(event: AgentSessionEvent): void {
    if (event.type !== "tool_execution_end") return;
    this.calls += 1;
    const { toolName, args, isError } = event as {
      toolName: string;
      args?: Record<string, unknown>;
      isError?: boolean;
    };
    if (isError) {
      this.problems.push(`${toolName} 执行失败`);
    }
    const path = typeof args?.path === "string" ? args.path : undefined;
    if (path && (toolName === "edit" || toolName === "write")) {
      this.files.add(path);
    }
  }

  public get observation(): ToolObservation {
    return { toolCalls: this.calls, errors: [...this.problems], changedFiles: [...this.files] };
  }
}
