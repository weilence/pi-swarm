import type { ModuleDefinition, TaskEnvelope, WorkerResult } from "../protocol/contracts.ts";
import type { AgentDefinition } from "./agent-format.ts";

/** Minimal supervisor surface; the real Supervisor satisfies it structurally. */
export interface TaskDispatcher {
  dispatch(tasks: TaskEnvelope[]): Promise<WorkerResult[]>;
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

/** One step of a planned task, routed to a module worker. */
export interface PlannedStep {
  id: string;
  module: string;
  goal: string;
  dependsOn: string[];
}

export interface StepOutcome {
  step: PlannedStep;
  result?: WorkerResult;
  error?: string;
}

/** Model-backed brain used by the orchestrator (satisfied by SupervisorAgent). */
export interface AgentBrain {
  analyzeIntent?(input: string, modules: ModuleDefinition[], clarifications?: string): Promise<IntentAnalysis>;
  planSteps?(goal: string, modules: ModuleDefinition[], clarifications?: string): Promise<PlannedStep[]>;
  /** Picks a user-created agent for a task by its description; null = none fits. */
  matchAgent?(task: string, agents: AgentDefinition[]): Promise<string | null>;
  /** Streams a markdown summary of the finished steps to the UI. */
  summarize?(goal: string, outcomes: StepOutcome[]): Promise<void>;
}

export interface OrchestratorServices {
  agent?: AgentBrain;
  supervisor: TaskDispatcher;
  modules: ModuleDefinition[];
  defaultModule: string;
  /** User-created agents; when present, unmatched steps try agent routing. */
  agents?: { list(): AgentDefinition[] };
  /** Supervisor self-execution path for steps with no matching agent. */
  selfExecute?: (step: PlannedStep) => Promise<WorkerResult>;
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
      module: typeof record.module === "string" && record.module.trim() ? record.module.trim() : "",
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
 * clarification round, dependency-layered parallel dispatch to module workers,
 * and a streamed summary. Falls back to direct dispatch without a model.
 */
export class Orchestrator {
  public constructor(private readonly services: OrchestratorServices) {}

  public async run(goal: string): Promise<void> {
    const { agent } = this.services;
    if (!agent?.analyzeIntent) {
      await this.executeDirect(goal);
      return;
    }

    let analysis: IntentAnalysis | undefined;
    try {
      analysis = await agent.analyzeIntent(goal, this.services.modules);
    } catch (error) {
      this.services.log(`[主 agent] supervisor 模型不可用，跳过意图分析直接派发：${errorMessage(error)}`);
    }
    if (!analysis) {
      await this.executeDirect(goal);
      return;
    }
    this.services.log(`[主 agent] 意图分析：${analysis.clarity === "simple" ? "简单任务，直接执行" : analysis.clarity === "complex" ? "复杂任务，进入规划" : "任务不明确，需要澄清"}`);

    let clarifications = "";
    if (analysis.clarity === "unclear") {
      clarifications = await this.clarify(goal, analysis);
      if (clarifications) {
        try {
          const refined = await agent.analyzeIntent(goal, this.services.modules, clarifications);
          if (refined) analysis = refined;
        } catch {
          // keep the unclear analysis and proceed with what we have
        }
      }
    }

    if (analysis.clarity === "simple") {
      await this.executeSteps(
        [{ id: "s1", module: this.services.defaultModule, goal: analysis.task || goal, dependsOn: [] }],
        goal
      );
      return;
    }

    if (!agent.planSteps) {
      await this.executeDirect(analysis.task || goal);
      return;
    }
    let steps: PlannedStep[] | undefined;
    try {
      steps = await agent.planSteps(analysis.task || goal, this.services.modules, clarifications || undefined);
    } catch (error) {
      this.services.log(`[主 agent] 规划失败，退化为直接执行：${errorMessage(error)}`);
    }
    if (!steps) {
      await this.executeDirect(analysis.task || goal);
      return;
    }
    this.services.log(`[主 agent] 计划就绪：${steps.length} 个步骤。`);
    await this.executeSteps(steps, goal);
  }

  /** Asks the user for the missing decisions; returns their answer or "". */
  private async clarify(goal: string, analysis: IntentAnalysis): Promise<string> {
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

  private async executeDirect(goal: string): Promise<void> {
    await this.executeSteps([{ id: "s1", module: this.services.defaultModule, goal, dependsOn: [] }], goal);
  }

  private async executeSteps(steps: PlannedStep[], goal: string): Promise<void> {
    const layers = dependencyLayers(steps);
    const outcomes: StepOutcome[] = [];
    for (const [index, layer] of layers.entries()) {
      this.services.log(`[主 agent] 执行第 ${index + 1}/${layers.length} 批（${layer.length} 个并行）。`);
      const tasks: TaskEnvelope[] = [];
      const selfSteps: PlannedStep[] = [];
      for (const step of layer) {
        const route = await this.routeStep(step);
        if (route.kind === "self") {
          selfSteps.push(step);
          continue;
        }
        tasks.push(this.toTask(step, outcomes, route.target));
      }
      const selfResults = new Map<string, WorkerResult>();
      for (const step of selfSteps) {
        try {
          selfResults.set(step.id, await this.services.selfExecute!(step));
        } catch (error) {
          outcomes.push({ step, error: errorMessage(error) });
        }
      }
      let results: WorkerResult[] | undefined;
      if (tasks.length > 0) {
        try {
          results = await this.services.supervisor.dispatch(tasks);
        } catch (error) {
          for (const task of tasks) {
            const step = layer.find((candidate) => candidate.id === task.taskId)!;
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
        const position = tasks.findIndex((task) => task.taskId === step.id);
        if (position >= 0) outcomes.push({ step, result: results?.[position] });
      }
    }
    for (const outcome of outcomes) {
      if (outcome.error) this.services.log(`[主 agent] 步骤 ${outcome.step.id} 失败：${outcome.error}`);
      else if (outcome.result) {
        this.services.log(`[主 agent] 步骤 ${outcome.step.id} ${outcome.result.status}：${outcome.result.changedFiles.length} 个文件变更。`);
      }
    }
    await this.summarize(goal, outcomes);
  }

  /** Resolves where a step runs: a registered module, a matched agent, or the supervisor itself. */
  private async routeStep(step: PlannedStep): Promise<{ kind: "worker"; target: string } | { kind: "self" }> {
    if (this.services.modules.some((module) => module.id === step.module)) {
      return { kind: "worker", target: step.module };
    }
    const agents = this.services.agents?.list() ?? [];
    const matchAgent = this.services.agent?.matchAgent;
    if (agents.length > 0 && matchAgent && this.services.selfExecute) {
      let name: string | null = null;
      try {
        name = await matchAgent(step.goal, agents);
      } catch {
        name = null;
      }
      const agent = name ? agents.find((candidate) => candidate.name === name) : undefined;
      if (agent) {
        this.services.log(`[主 agent] 步骤 ${step.id} 匹配到 agent：${agent.name}。`);
        return { kind: "worker", target: agent.name };
      }
      this.services.log(`[主 agent] 步骤 ${step.id} 无匹配 agent，由 supervisor 自行执行。`);
      return { kind: "self" };
    }
    if (step.module) {
      this.services.log(`[主 agent] 步骤 ${step.id} 指定的模块 ${step.module} 不存在，改用 ${this.services.defaultModule}。`);
    }
    return { kind: "worker", target: this.services.defaultModule };
  }

  private toTask(step: PlannedStep, outcomes: StepOutcome[], target?: string): TaskEnvelope {
    const module = this.services.modules.find((candidate) => candidate.id === target);
    if (target && !module) {
      this.services.log(`[主 agent] 步骤 ${step.id} 路由到 ${target}。`);
    }
    if (!module && target) {
      // Routed to a user-created agent: no module metadata, runs in its own session.
      return {
        taskId: step.id,
        module: target,
        goal: step.goal,
        workingDirectory: process.cwd(),
        contextFiles: [],
        allowedPaths: [],
        relatedModules: [],
        requiredTests: []
      };
    }
    const fallback = this.services.modules.find((module) => module.id === this.services.defaultModule)!;
    const resolved = module ?? fallback;
    const prior = outcomes
      .filter((outcome) => step.dependsOn.includes(outcome.step.id))
      .map((outcome) =>
        outcome.error
          ? `- ${outcome.step.id}（${outcome.step.module}）失败：${outcome.error}`
          : `- ${outcome.step.id}（${outcome.step.module}）${outcome.result?.status ?? "unknown"}：${outcome.result?.changedFiles.length ?? 0} 个文件变更`
      );
    return {
      taskId: step.id,
      module: resolved.id,
      goal: prior.length > 0 ? `${step.goal}\n\n前序步骤结果：\n${prior.join("\n")}` : step.goal,
      workingDirectory: resolved.path,
      contextFiles: resolved.contextFiles,
      allowedPaths: resolved.allowedPaths,
      relatedModules: [],
      requiredTests: [resolved.testCommand, resolved.contractCommand]
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
