import assert from "node:assert/strict";
import { test } from "node:test";
import { createDelegateTool, type DelegateServices, type DelegateState } from "../src/pi/delegate-tool.ts";
import { BUDGET_LIMITS, createTaskRun, type StepRecord } from "../src/core/task-run.ts";
import type { AgentDefinition } from "../src/core/agent-format.ts";

function definition(name: string): AgentDefinition {
  return { name, description: `${name} agent`, capabilities: [], tools: [], tags: [], systemPrompt: "p", sourceFile: `${name}.md` };
}

function record(id: string, overrides: Partial<StepRecord> = {}): StepRecord {
  return {
    id,
    agent: "code-writer",
    goal: `${id} 目标`,
    status: "completed",
    summary: `${id} 的摘要`,
    changedFiles: [`${id}.ts`],
    toolCalls: 1,
    ...overrides
  };
}

interface Harness {
  services: DelegateServices;
  state: DelegateState;
  runStep: (id: string, result: Partial<StepRecord>) => void;
  logs: string[];
  goals: string[];
}

/**
 * The fake executor resolves steps in FIFO order; each planned step must be
 * paired with a runStep() result before (or while) the tool executes.
 */
function makeHarness(): Harness {
  const state: DelegateState = { taskRun: createTaskRun("测试任务") };
  const pending = new Map<string, Partial<StepRecord>>();
  const goals: string[] = [];
  const logs: string[] = [];
  const services: DelegateServices = {
    agents: { list: () => [definition("code-writer"), definition("test-writer")] },
    async runStep(step) {
      goals.push(step.goal);
      const overrides = pending.get(step.id) ?? {};
      return record(step.id, { agent: step.agent, goal: step.goal, ...overrides });
    },
    log: (line) => logs.push(line)
  };
  return {
    services,
    state,
    runStep: (id, result) => pending.set(id, result),
    logs,
    goals
  };
}

async function execute(services: DelegateServices, state: DelegateState, steps: unknown) {
  const tool = createDelegateTool(services, state);
  return await tool.execute("call-1", { steps } as never, undefined, undefined, undefined as never);
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

test("executes independent steps in parallel and returns real records", async () => {
  const harness = makeHarness();
  const result = await execute(harness.services, harness.state, [
    { id: "s1", goal: "写模块", agent: "code-writer" },
    { id: "s2", goal: "写另一模块", agent: "test-writer" }
  ]);
  assert.match(resultText(result), /"id": "s1"/);
  assert.match(resultText(result), /"status": "completed"/);
  assert.match(resultText(result), /s1 的摘要/);
  assert.deepEqual(harness.state.taskRun!.budget, { delegateCalls: 1, stepsUsed: 2 });
  assert.equal(harness.state.taskRun!.steps.length, 2);
});

test("dependent steps run after their dependencies with prior context injected", async () => {
  const harness = makeHarness();
  await execute(harness.services, harness.state, [
    { id: "s2", goal: "实现逻辑", agent: "code-writer", dependsOn: ["s1"] },
    { id: "s1", goal: "定义接口", agent: "code-writer" }
  ]);
  assert.equal(harness.goals.length, 2);
  assert.equal(harness.goals[0], "定义接口", "s1 runs first");
  assert.match(harness.goals[1], /实现逻辑\n\n前序步骤结果：/);
  assert.match(harness.goals[1], /- s1（code-writer）completed：1 个文件变更/);
  assert.match(harness.goals[1], /摘要：s1 的摘要/);
});

test("validation failures return guidance without consuming budget", async () => {
  const harness = makeHarness();
  const unknown = await execute(harness.services, harness.state, [{ id: "s1", goal: "g", agent: "ghost" }]);
  assert.match(resultText(unknown), /未注册：ghost/);
  assert.match(resultText(unknown), /code-writer, test-writer/);

  const tooMany = await execute(harness.services, harness.state,
    Array.from({ length: BUDGET_LIMITS.maxStepsPerBatch + 1 }, (_, i) => ({ id: `s${i}`, goal: "g", agent: "code-writer" })));
  assert.match(resultText(tooMany), /一次最多 6 个步骤/);

  const duplicate = await execute(harness.services, harness.state, [
    { id: "s1", goal: "g", agent: "code-writer" },
    { id: "s1", goal: "g2", agent: "code-writer" }
  ]);
  assert.match(resultText(duplicate), /步骤 id 重复：s1/);

  assert.deepEqual(harness.state.taskRun!.budget, { delegateCalls: 0, stepsUsed: 0 }, "no budget consumed");
  assert.equal(harness.goals.length, 0);
});

test("budget exhaustion stops delegation and asks for a wrap-up", async () => {
  const harness = makeHarness();
  harness.state.taskRun = createTaskRun("大任务");
  harness.state.taskRun.budget.delegateCalls = BUDGET_LIMITS.maxDelegateCalls;
  const result = await execute(harness.services, harness.state, [{ id: "s1", goal: "g", agent: "code-writer" }]);
  assert.match(resultText(result), /任务预算已耗尽/);
  assert.equal(harness.state.taskRun.status, "budget_exhausted");
  assert.equal(harness.goals.length, 0);
});

test("step budget caps how many steps remain delegable", async () => {
  const harness = makeHarness();
  harness.state.taskRun!.budget.stepsUsed = BUDGET_LIMITS.maxSteps - 1;
  const result = await execute(harness.services, harness.state, [
    { id: "s1", goal: "g", agent: "code-writer" },
    { id: "s2", goal: "g", agent: "code-writer" }
  ]);
  assert.match(resultText(result), /任务总步骤预算只剩 1 个/);
  assert.equal(harness.goals.length, 0);
});

test("delegate without an active task is refused", async () => {
  const harness = makeHarness();
  harness.state.taskRun = undefined;
  const result = await execute(harness.services, harness.state, [{ id: "s1", goal: "g", agent: "code-writer" }]);
  assert.match(resultText(result), /当前没有活动任务/);
});

test("failed step records flow through to the model", async () => {
  const harness = makeHarness();
  harness.runStep("s1", { status: "failed", error: "缺少数据库凭据" });
  const result = await execute(harness.services, harness.state, [{ id: "s1", goal: "g", agent: "code-writer" }]);
  const text = resultText(result);
  assert.match(text, /"status": "failed"/);
  assert.match(text, /缺少数据库凭据/);
});
