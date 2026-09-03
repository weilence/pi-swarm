import type { AgentDefinition } from "./agent-format.ts";
import type { StepRequest, StepResult } from "../protocol/contracts.ts";

/** Minimal supervisor surface; the real Supervisor satisfies it structurally. */
export interface TaskDispatcher {
  dispatch(requests: StepRequest[]): Promise<StepResult[]>;
}

/** Outcome of an intent analysis: how to proceed with the user's input. */
export interface IntentAnalysis {
  /** simple: single step is enough; complex: multi-step plan needed; unclear: ask first. */
  clarity: "simple" | "complex" | "unclear";
  /** Condensed task description derived from the input plus clarifications. */
  task: string;
  /** Questions blocking a safe start (used when clarity is unclear). */
  questions: string[];
}

/** One step of a planned task, optionally pre-assigned to an agent. */
export interface PlannedStep {
  id: string;
  /** Agent name from the planner; empty means decide at routing time. */
  agent: string;
  goal: string;
  dependsOn: string[];
}

export interface StepOutcome {
  step: PlannedStep;
  result?: StepResult;
  error?: string;
}

/** Model-backed brain used by the orchestrator (satisfied by SupervisorAgent). */
export interface AgentBrain {
  analyzeIntent?(input: string, agents: AgentDefinition[], clarifications?: string): Promise<IntentAnalysis>;
  planSteps?(goal: string, agents: AgentDefinition[], clarifications?: string): Promise<PlannedStep[]>;
  /** LLM matcher over the registered agent catalog. */
  matchAgent?(task: string, agents: AgentDefinition[]): Promise<string | null>;
  /** Supervisor self-execution for steps no agent picks up. */
  executeTask?(step: { id: string; goal: string }): Promise<StepResult>;
  /** Streams a markdown summary of the finished steps to the UI. */
  summarize?(goal: string, outcomes: StepOutcome[]): Promise<void>;
}

export interface OrchestratorServices {
  agent?: AgentBrain;
  supervisor: TaskDispatcher;
  /** Registered sub-agent catalog (may be empty). */
  agents: { list(): AgentDefinition[] };
  /** Self-execution channel; required so every step always has a runner. */
  selfExecute: (step: { id: string; goal: string }) => Promise<StepResult>;
  /** Interactive question channel; absent or empty answers skip clarification. */
  askUser?: (question: string) => Promise<string>;
  log: (line: string) => void;
}

/** Extracts the first JSON object from a model reply (fenced or bare); undefined when absent. */
export function extractJson(text: string): unknown | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

/** Parses a loose intent payload defensively; returns undefined on garbage. */
export function parseIntentAnalysis(payload: unknown): IntentAnalysis | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const candidate = payload as Partial<IntentAnalysis>;
  if (candidate.clarity !== "simple" && candidate.clarity !== "complex" && candidate.clarity !== "unclear") {
    return undefined;
  }
  return {
    clarity: candidate.clarity,
    task: typeof candidate.task === "string" && candidate.task.trim() ? candidate.task.trim() : "",
    questions: Array.isArray(candidate.questions) ? candidate.questions.filter((q): q is string => typeof q === "string") : []
  };
}

/** Parses a loose plan payload defensively, normalizing ids and dependencies. */
export function parsePlannedSteps(payload: unknown): PlannedStep[] | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const steps = (payload as { steps?: unknown }).steps;
  if (!Array.isArray(steps) || steps.length === 0) return undefined;
  const parsed: PlannedStep[] = [];
  for (const step of steps) {
    if (typeof step !== "object" || step === null) continue;
    const record = step as Partial<PlannedStep>;
    if (typeof record.id !== "string" || !record.id.trim()) continue;
    if (typeof record.goal !== "string" || !record.goal.trim()) continue;
    parsed.push({
      id: record.id.trim(),
      agent: typeof record.agent === "string" ? record.agent.trim() : "",
      goal: record.goal.trim(),
      dependsOn: Array.isArray(record.dependsOn) ? record.dependsOn.filter((dep): dep is string => typeof dep === "string") : []
    });
  }
  return parsed.length > 0 ? parsed : undefined;
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
        return step.dependsOn.every((dep) => done.has(dep) || !byId.has(dep));
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

/**
 * Interaction pipeline behind every user goal: intent analysis, at most one
 * clarification round, agent routing (planner assignment first, LLM match as
 * fallback, supervisor self-execution last), dependency-layered parallel
 * execution, and a streamed summary. Model failures degrade to self-execution
 * instead of blocking.
 */
export class Orchestrator {
  public constructor(private readonly services: OrchestratorServices) {}

  public async run(goal: string): Promise<void> {
    const { agent } = this.services;
    const agents = this.services.agents.list();

    let analysis: IntentAnalysis | undefined;
    try {
      analysis = await agent?.analyzeIntent?.(goal, agents);
    } catch (error) {
      this.services.log(`[主 agent] supervisor 模型不可用，跳过意图分析直接执行：${errorMessage(error)}`);
    }
    if (!analysis) {
      await this.executeSteps([{ id: "s1", agent: "", goal, dependsOn: [] }], goal);
      return;
    }
    this.services.log(`[主 agent] 意图分析：${analysis.clarity === "simple" ? "简单任务，直接执行" : analysis.clarity === "complex" ? "复杂任务，进入规划" : "任务不明确，需要澄清"}`);

    let clarifications = "";
    if (analysis.clarity === "unclear") {
      clarifications = await this.clarify(analysis);
      if (clarifications) {
        try {
          const refined = await agent?.analyzeIntent?.(goal, agents, clarifications);
          if (refined) analysis = refined;
        } catch {
          // keep the unclear analysis and proceed with what we have
        }
      }
    }

    if (analysis.clarity === "simple") {
      await this.executeSteps([{ id: "s1", agent: "", goal: analysis.task || goal, dependsOn: [] }], goal);
      return;
    }

    let steps: PlannedStep[] | undefined;
    try {
      steps = await agent?.planSteps?.(analysis.task || goal, agents, clarifications || undefined);
    } catch (error) {
      this.services.log(`[主 agent] 规划失败，退化为直接执行：${errorMessage(error)}`);
    }
    if (!steps) {
      await this.executeSteps([{ id: "s1", agent: "", goal: analysis.task || goal, dependsOn: [] }], goal);
      return;
    }
    this.services.log(`[主 agent] 计划就绪：${steps.length} 个步骤。`);
    await this.executeSteps(steps, goal);
  }

  /** Asks the user for the missing decisions; returns their answer or "". */
  private async clarify(analysis: IntentAnalysis): Promise<string> {
    const questions = analysis.questions.filter((question) => question.trim());
    if (questions.length === 0) return "";
    if (!this.services.askUser) {
      this.services.log(`[主 agent] 非交互模式无法澄清，按现有信息继续。待确认：${questions.join("；")}`);
      return "";
    }
    const question = ["[主 agent] 开始前需要确认：", ...questions.map((item, index) => `${index + 1}. ${item}`), "请回复以上问题（直接回车跳过并按现有信息执行）："].join("\n");
    try {
      return (await this.services.askUser(question)).trim();
    } catch {
      return "";
    }
  }

  private async executeSteps(steps: PlannedStep[], goal: string): Promise<void> {
    const layers = dependencyLayers(steps);
    const outcomes: StepOutcome[] = [];
    for (const [index, layer] of layers.entries()) {
      this.services.log(`[主 agent] 执行第 ${index + 1}/${layers.length} 批（${layer.length} 个并行）。`);
      const requests: StepRequest[] = [];
      const selfSteps: PlannedStep[] = [];
      for (const step of layer) {
        const route = await this.routeStep(step);
        if (route.kind === "self") {
          selfSteps.push(step);
          continue;
        }
        requests.push(this.toRequest(step, outcomes, route.target));
      }
      const selfResults = new Map<string, StepResult>();
      for (const step of selfSteps) {
        try {
          selfResults.set(step.id, await this.services.selfExecute(step));
        } catch (error) {
          outcomes.push({ step, error: errorMessage(error) });
        }
      }
      let results: StepResult[] | undefined;
      if (requests.length > 0) {
        try {
          results = await this.services.supervisor.dispatch(requests);
        } catch (error) {
          for (const request of requests) {
            const step = layer.find((candidate) => candidate.id === request.taskId)!;
            outcomes.push({ step, error: errorMessage(error) });
          }
          results = undefined;
        }
      }
      for (const step of layer) {
        if (selfResults.has(step.id)) {
          outcomes.push({ step, result: selfResults.get(step.id)! });
          continue;
        }
        const position = requests.findIndex((request) => request.taskId === step.id);
        if (position >= 0) outcomes.push({ step, result: results?.[position] });
      }
    }
    for (const outcome of outcomes) {
      if (outcome.error) this.services.log(`[主 agent] 步骤 ${outcome.step.id} 失败：${outcome.error}`);
      else if (outcome.result) {
        this.services.log(`[主 agent] 步骤 ${outcome.step.id}（${outcome.result.agent}）${outcome.result.status}：${outcome.result.changedFiles.length} 个文件变更。`);
      }
    }
    await this.summarize(goal, outcomes);
  }

  /**
   * Resolves where a step runs: a planner-assigned agent wins when registered,
   * otherwise the LLM matcher picks from the catalog, else the supervisor
   * self-executes.
   */
  private async routeStep(step: PlannedStep): Promise<{ kind: "agent"; target: string } | { kind: "self" }> {
    const agents = this.services.agents.list();
    if (step.agent && agents.some((candidate) => candidate.name === step.agent)) {
      return { kind: "agent", target: step.agent };
    }
    if (step.agent) {
      this.services.log(`[主 agent] 步骤 ${step.id} 指定的 agent ${step.agent} 未注册，尝试运行时匹配。`);
    }
    if (agents.length > 0 && this.services.agent?.matchAgent) {
      let name: string | null = null;
      try {
        name = await this.services.agent.matchAgent(step.goal, agents);
      } catch {
        name = null;
      }
      const agent = name ? agents.find((candidate) => candidate.name === name) : undefined;
      if (agent) {
        this.services.log(`[主 agent] 步骤 ${step.id} 匹配到 agent：${agent.name}。`);
        return { kind: "agent", target: agent.name };
      }
      this.services.log(`[主 agent] 步骤 ${step.id} 无匹配 agent，由 supervisor 自行执行。`);
    }
    return { kind: "self" };
  }

  private toRequest(step: PlannedStep, outcomes: StepOutcome[], target: string): StepRequest {
    const prior = outcomes
      .filter((outcome) => step.dependsOn.includes(outcome.step.id))
      .map((outcome) =>
        outcome.error
          ? `- ${outcome.step.id}（${outcome.step.agent || "supervisor"}）失败：${outcome.error}`
          : `- ${outcome.step.id}（${outcome.result?.agent ?? (outcome.step.agent || "supervisor")}）${outcome.result?.status ?? "unknown"}：${outcome.result?.changedFiles.length ?? 0} 个文件变更`
      );
    return {
      taskId: step.id,
      agent: target,
      goal: prior.length > 0 ? `${step.goal}\n\n前序步骤结果：\n${prior.join("\n")}` : step.goal
    };
  }

  private async summarize(goal: string, outcomes: StepOutcome[]): Promise<void> {
    try {
      if (this.services.agent?.summarize) {
        await this.services.agent.summarize(goal, outcomes);
        return;
      }
    } catch (error) {
      this.services.log(`[主 agent] 总结生成失败：${errorMessage(error)}`);
    }
    const completed = outcomes.filter((outcome) => !outcome.error).length;
    this.services.log(`[主 agent] 完成：${completed}/${outcomes.length} 个步骤成功。`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
