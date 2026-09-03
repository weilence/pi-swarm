import { randomUUID } from "node:crypto";

/** One executed step, built from real session observation (never self-reported). */
export interface StepRecord {
  id: string;
  /** Agent name that executed the step. */
  agent: string;
  goal: string;
  status: "completed" | "failed" | "timeout";
  /** Assistant final text captured from the step's session. */
  summary: string;
  changedFiles: string[];
  toolCalls: number;
  error?: string;
}

/** One delegate batch item as assigned by the supervisor model. */
export interface PlannedStep {
  id: string;
  goal: string;
  agent: string;
  /** Step ids inside the same batch that must finish first; unknown ids are ignored. */
  dependsOn?: string[];
}

export interface TaskBudget {
  delegateCalls: number;
  stepsUsed: number;
}

export interface TaskRun {
  id: string;
  goal: string;
  status: "running" | "completed" | "budget_exhausted";
  steps: StepRecord[];
  budget: TaskBudget;
  createdAt: string;
}

/**
 * Hard guardrails for the model-driven loop. The model owns the control flow;
 * these numbers bound how far a runaway or looping plan can go.
 */
export const BUDGET_LIMITS = {
  maxDelegateCalls: 8,
  maxSteps: 24,
  maxStepsPerBatch: 6,
  maxConcurrency: 4,
  stepTimeoutMs: 10 * 60 * 1000,
  maxRetries: 1,
  /** Summary chars injected into delegate results and downstream prompts. */
  maxSummaryChars: 1500
} as const;

export function createTaskRun(goal: string): TaskRun {
  return {
    id: randomUUID(),
    goal,
    status: "running",
    steps: [],
    budget: { delegateCalls: 0, stepsUsed: 0 },
    createdAt: new Date().toISOString()
  };
}

export function remainingSteps(taskRun: TaskRun): number {
  return Math.max(0, BUDGET_LIMITS.maxSteps - taskRun.budget.stepsUsed);
}

/**
 * Groups steps into dependency layers that can run in parallel: a step lands in
 * the first layer after all of its known dependencies. Unknown dependency ids
 * are ignored; a dependency cycle degrades to running the remainder together.
 */
export function dependencyLayers(steps: PlannedStep[]): PlannedStep[][] {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const remaining = new Set(steps.map((step) => step.id));
  const done = new Set<string>();
  const layers: PlannedStep[][] = [];
  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter((id) => {
        const step = byId.get(id)!;
        return (step.dependsOn ?? []).every((dep) => done.has(dep) || !byId.has(dep));
      })
      .sort();
    if (ready.length === 0) {
      layers.push([...remaining].map((id) => byId.get(id)!).sort((a, b) => a.id.localeCompare(b.id)));
      break;
    }
    layers.push(ready.map((id) => byId.get(id)!));
    for (const id of ready) {
      done.add(id);
      remaining.delete(id);
    }
  }
  return layers;
}

/** Thrown when a step exceeds its wall-clock limit; the session is aborted first. */
export class StepTimeoutError extends Error {}

/** Renders an error for step records and retry prompts. */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Retryable = transient infrastructure errors (network, rate limits, timeouts).
 * Semantic failures — the step ran but the work did not land — are never
 * retried blindly; they go back to the supervisor model to decide.
 */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof StepTimeoutError) return true;
  const message = describeError(error);
  return /fetch failed|network|econnreset|econnrefused|etimedout|enotfound|eai_again|socket|rate limit|overloaded|timeout|\b429\b|\b502\b|\b503\b|\b504\b/i.test(message);
}

/** Truncates long text for model-facing result payloads. */
export function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…（已截断）`;
}

/**
 * Renders finished step records as context text appended to a dependent
 * step's goal: one status line per dependency plus a truncated summary.
 */
export function formatPriorSteps(records: StepRecord[]): string {
  return records
    .map((record) => {
      const line = `- ${record.id}（${record.agent}）${record.status}：${record.changedFiles.length} 个文件变更${record.error ? `；错误：${truncate(record.error, 200)}` : ""}`;
      return record.summary ? `${line}\n  摘要：${truncate(record.summary, BUDGET_LIMITS.maxSummaryChars)}` : line;
    })
    .join("\n");
}
