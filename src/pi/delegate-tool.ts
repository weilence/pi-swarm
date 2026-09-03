import { Type } from "typebox";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { AgentDefinition } from "../core/agent-format.ts";
import {
  BUDGET_LIMITS,
  dependencyLayers,
  formatPriorSteps,
  remainingSteps,
  truncate,
  type PlannedStep,
  type StepRecord,
  type TaskRun
} from "../core/task-run.ts";

export interface DelegateServices {
  /** Registered agent catalog used to validate assignments. */
  agents: { list(): AgentDefinition[] };
  /** Executes one step on its agent; failures are contained inside the record. */
  runStep: (step: { id: string; goal: string; agent: string }) => Promise<StepRecord>;
  log: (line: string) => void;
}

/** Mutable per-task holder; runTask() swaps in a fresh TaskRun per user goal. */
export interface DelegateState {
  taskRun?: TaskRun;
}

const delegateSchema = Type.Object({
  steps: Type.Array(
    Type.Object({
      id: Type.String({ description: "本批内唯一的步骤 id，如 s1、s2" }),
      goal: Type.String({ description: "步骤目标：具体、可独立验收" }),
      agent: Type.String({ description: "执行该步骤的子 agent name（必须来自系统提示中的花名册）" }),
      dependsOn: Type.Optional(Type.Array(Type.String(), { description: "本批内必须先完成的前置步骤 id" }))
    }),
    { description: `本批步骤（最多 ${BUDGET_LIMITS.maxStepsPerBatch} 个，无依赖的并行执行）` }
  )
});

/**
 * The supervisor's only orchestration tool: it hands a batch of steps to the
 * registered sub-agents, runs them dependency-layered and concurrency-capped,
 * and returns the real observation records as the tool result — the feedback
 * the model's control loop decides from. Guardrails (batch size, budget,
 * roster validation) live here so a runaway plan hits hard limits.
 */
export function createDelegateTool(services: DelegateServices, state: DelegateState) {
  return defineTool({
    name: "delegate",
    label: "派发步骤",
    description: `把任务拆成一批步骤派发给子 agent 执行（≤${BUDGET_LIMITS.maxStepsPerBatch} 个/批），按 dependsOn 分层并行，返回每个步骤的真实结果（状态、变更文件、错误、摘要）。`,
    promptGuidelines: [
      "把可并行的独立步骤放进同一批 delegate；有数据依赖的步骤用 dependsOn 表达或留到下一批。",
      "根据返回的真实结果继续决策：再派下一批、换 agent 重做失败步骤，或自行完成剩余小步骤。",
      "全部工作完成后，向用户输出 markdown 总结：完成了什么、关键变更、失败与风险、后续建议。"
    ],
    parameters: delegateSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx): Promise<AgentToolResult<{ records: StepRecord[] }>> {
      const taskRun = state.taskRun;
      if (!taskRun) return textResult("当前没有活动任务，delegate 不可用。", []);
      if (taskRun.budget.delegateCalls >= BUDGET_LIMITS.maxDelegateCalls) {
        taskRun.status = "budget_exhausted";
        return textResult(
          `任务预算已耗尽（delegate 最多 ${BUDGET_LIMITS.maxDelegateCalls} 次）。请直接向用户输出任务总结并结束。`,
          []
        );
      }
      const steps = params.steps;
      if (steps.length === 0) return textResult("steps 为空：请给出至少一个步骤。", []);
      if (steps.length > BUDGET_LIMITS.maxStepsPerBatch) {
        return textResult(`一次最多 ${BUDGET_LIMITS.maxStepsPerBatch} 个步骤，本批给了 ${steps.length} 个；请拆成更小的批次。`, []);
      }
      const duplicate = findDuplicateId(steps);
      if (duplicate) return textResult(`步骤 id 重复：${duplicate}。请修正后重试。`, []);
      if (steps.length > remainingSteps(taskRun)) {
        return textResult(`任务总步骤预算只剩 ${remainingSteps(taskRun)} 个，本批给了 ${steps.length} 个；请精简步骤或收尾总结。`, []);
      }
      const known = new Set(services.agents.list().map((agent) => agent.name));
      const unknown = [...new Set(steps.map((step) => step.agent).filter((agent) => !known.has(agent)))];
      if (unknown.length > 0) {
        return textResult(
          `以下 agent 未注册：${unknown.join(", ")}。可用：${[...known].join(", ") || "（无）"}。请改用已注册的 agent，或自己完成该步骤。`,
          []
        );
      }

      taskRun.budget.delegateCalls += 1;
      taskRun.budget.stepsUsed += steps.length;
      const byId = new Map(steps.map((step) => [step.id, step]));
      const records: StepRecord[] = [];
      const layers = dependencyLayers(steps);
      for (const [index, layer] of layers.entries()) {
        services.log(`[delegate] 第 ${index + 1}/${layers.length} 批（${layer.length} 个并行）。`);
        const layerRecords = await runPool(layer, BUDGET_LIMITS.maxConcurrency, async (step) => {
          const prior = priorContext(step, byId, records);
          services.log(`[delegate] 步骤 ${step.id} → ${step.agent} 开始。`);
          const record = await services.runStep(prior ? { ...step, goal: `${step.goal}\n\n前序步骤结果：\n${prior}` } : step);
          services.log(
            `[delegate] 步骤 ${step.id}（${step.agent}）${record.status}：${record.changedFiles.length} 个文件变更${record.error ? `；${truncate(record.error, 200)}` : ""}。`
          );
          return record;
        });
        records.push(...layerRecords);
        taskRun.steps.push(...layerRecords);
      }
      return textResult(JSON.stringify(records.map(toModelRecord), null, 2), records);
    }
  });
}

/** Returns the text block appended to a step's goal when its dependencies are done. */
function priorContext(step: PlannedStep, byId: Map<string, PlannedStep>, records: StepRecord[]): string {
  const deps = (step.dependsOn ?? []).filter((dep) => byId.has(dep));
  if (deps.length === 0) return "";
  const depRecords = deps
    .map((id) => records.find((record) => record.id === id))
    .filter((record): record is StepRecord => Boolean(record));
  return depRecords.length > 0 ? formatPriorSteps(depRecords) : "";
}

/** Model-facing projection: truncated summary, full record stays in the TaskRun. */
function toModelRecord(record: StepRecord) {
  return {
    id: record.id,
    agent: record.agent,
    status: record.status,
    changedFiles: record.changedFiles,
    ...(record.error ? { error: record.error } : {}),
    summary: truncate(record.summary, BUDGET_LIMITS.maxSummaryChars)
  };
}

function findDuplicateId(steps: PlannedStep[]): string | undefined {
  const seen = new Set<string>();
  for (const step of steps) {
    if (seen.has(step.id)) return step.id;
    seen.add(step.id);
  }
  return undefined;
}

function textResult(text: string, records: StepRecord[]): AgentToolResult<{ records: StepRecord[] }> {
  return { content: [{ type: "text", text }], details: { records } };
}

/** Runs items through a fixed-size worker pool, preserving result order. */
async function runPool<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(lanes);
  return results;
}
