import assert from "node:assert/strict";
import { test } from "node:test";
import {
  dependencyLayers,
  extractJson,
  Orchestrator,
  parseIntentAnalysis,
  parsePlannedSteps,
  type AgentBrain,
  type IntentAnalysis,
  type PlannedStep,
  type StepOutcome
} from "../src/core/orchestrator.ts";
import type { AgentDefinition } from "../src/core/agent-format.ts";
import type { StepRequest, StepResult } from "../src/protocol/contracts.ts";

function makeDefinition(name: string): AgentDefinition {
  return { name, description: `${name} agent`, capabilities: [], tools: [], tags: [], systemPrompt: "prompt", sourceFile: `${name}.md` };
}

const definitions = [makeDefinition("code-reviewer"), makeDefinition("test-writer")];

function resultFor(request: StepRequest): StepResult {
  return {
    taskId: request.taskId,
    agent: request.agent,
    status: "completed",
    changedFiles: request.taskId === "s1" ? ["a.ts"] : [],
    tests: [],
    risks: [],
    messages: []
  };
}

interface Harness {
  orchestrator: Orchestrator;
  dispatched: StepRequest[];
  selfExecuted: { id: string; goal: string }[];
  asked: string[];
  summaries: { goal: string; outcomes: StepOutcome[] }[];
  logs: string[];
  matches: (string | null)[];
  brain: { intent: IntentAnalysis[]; plan?: PlannedStep[]; failIntent?: boolean; failPlan?: boolean; clarifyAnswer?: string };
}

function makeHarness(initialIntent: IntentAnalysis[], plan?: PlannedStep[], matches: (string | null)[] = []): Harness {
  const dispatched: StepRequest[] = [];
  const selfExecuted: { id: string; goal: string }[] = [];
  const asked: string[] = [];
  const summaries: { goal: string; outcomes: StepOutcome[] }[] = [];
  const logs: string[] = [];
  const brain: Harness["brain"] = { intent: [...initialIntent], plan };
  const harness: Harness = {
    orchestrator: undefined as never,
    dispatched,
    selfExecuted,
    asked,
    summaries,
    logs,
    matches: [...matches],
    brain
  };
  const agent: AgentBrain = {
    async analyzeIntent() {
      if (brain.failIntent) throw new Error("no model configured");
      const next = brain.intent.shift();
      if (!next) throw new Error("no more canned analyses");
      return next;
    },
    async planSteps() {
      if (brain.failPlan || !brain.plan) throw new Error("plan unavailable");
      return brain.plan;
    },
    async matchAgent() {
      const next = harness.matches.shift();
      return next === undefined ? null : next;
    },
    async summarize(goal, outcomes) {
      summaries.push({ goal, outcomes });
    }
  };
  harness.orchestrator = new Orchestrator({
    agent,
    supervisor: {
      async dispatch(requests) {
        dispatched.push(...requests);
        return requests.map(resultFor);
      }
    },
    agents: { list: () => definitions },
    selfExecute: async (step) => {
      selfExecuted.push(step);
      return resultFor({ taskId: step.id, agent: "supervisor", goal: step.goal });
    },
    askUser: async (question) => {
      asked.push(question);
      return brain.clarifyAnswer ?? "";
    },
    log: (line) => logs.push(line)
  });
  return harness;
}

test("dependencyLayers groups diamond dependencies into parallel batches", () => {
  const steps: PlannedStep[] = [
    { id: "s1", agent: "", goal: "a", dependsOn: [] },
    { id: "s2", agent: "", goal: "b", dependsOn: ["s1"] },
    { id: "s3", agent: "", goal: "c", dependsOn: ["s1"] },
    { id: "s4", agent: "", goal: "d", dependsOn: ["s2", "s3"] }
  ];
  assert.deepEqual(
    dependencyLayers(steps).map((layer) => layer.map((step) => step.id)),
    [["s1"], ["s2", "s3"], ["s4"]]
  );
});

test("dependencyLayers degrades cycles and ignores unknown dependencies", () => {
  const cyclic: PlannedStep[] = [
    { id: "s1", agent: "", goal: "a", dependsOn: ["s2"] },
    { id: "s2", agent: "", goal: "b", dependsOn: ["s1"] }
  ];
  assert.equal(dependencyLayers(cyclic).length, 1, "cycles run together in one batch");
  const unknown: PlannedStep[] = [{ id: "s1", agent: "", goal: "a", dependsOn: ["nope"] }];
  assert.deepEqual(
    dependencyLayers(unknown).map((layer) => layer.map((step) => step.id)),
    [["s1"]]
  );
});

test("extractJson and parsers tolerate fenced or noisy model output", () => {
  assert.deepEqual(extractJson('前置说明\n```json\n{"a":1}\n```\n结尾'), { a: 1 });
  assert.deepEqual(extractJson('好的 {"a":1} 以上'), { a: 1 });
  assert.equal(extractJson("no json here"), undefined);

  assert.deepEqual(parseIntentAnalysis({ clarity: "simple", task: " x ", questions: "bad" }), {
    clarity: "simple",
    task: "x",
    questions: []
  });
  assert.equal(parseIntentAnalysis({ clarity: "wild" }), undefined);

  assert.deepEqual(
    parsePlannedSteps({ steps: [{ id: " s1 ", agent: 5, goal: "g", dependsOn: ["x", 3] }, { id: "", goal: "dropped" }] }),
    [{ id: "s1", agent: "", goal: "g", dependsOn: ["x"] }]
  );
  assert.equal(parsePlannedSteps({ steps: [] }), undefined);
});

test("simple intents route through agent matching and summarize", async () => {
  const harness = makeHarness([{ clarity: "simple", task: "提炼后的任务", questions: [] }], undefined, ["code-reviewer"]);
  await harness.orchestrator.run("原始输入");
  assert.equal(harness.dispatched.length, 1);
  assert.equal(harness.dispatched[0].agent, "code-reviewer");
  assert.equal(harness.dispatched[0].goal, "提炼后的任务");
  assert.equal(harness.summaries.length, 1);
  assert.equal(harness.asked.length, 0);
});

test("unmatched simple intents self-execute", async () => {
  const harness = makeHarness([{ clarity: "simple", task: "提炼", questions: [] }], undefined, [null]);
  await harness.orchestrator.run("原始输入");
  assert.equal(harness.dispatched.length, 0);
  assert.deepEqual(
    harness.selfExecuted.map(({ id, goal }) => ({ id, goal })),
    [{ id: "s1", goal: "提炼" }]
  );
});

test("unclear intents ask once, re-analyze with the answer, then execute", async () => {
  const harness = makeHarness(
    [
      { clarity: "unclear", task: "", questions: ["用哪个数据库？", "要不要兼容旧接口？"] },
      { clarity: "simple", task: "用 postgres 实现登录", questions: [] }
    ],
    undefined,
    ["test-writer"]
  );
  harness.brain.clarifyAnswer = "用 postgres，不需要兼容";
  await harness.orchestrator.run("实现登录");
  assert.equal(harness.asked.length, 1);
  assert.match(harness.asked[0], /1\. 用哪个数据库/);
  assert.equal(harness.dispatched[0].goal, "用 postgres 实现登录");
});

test("unclear intents without an interactive channel proceed with planning", async () => {
  const logs: string[] = [];
  const selfExecuted: { id: string; goal: string }[] = [];
  const orchestrator = new Orchestrator({
    agent: {
      async analyzeIntent() {
        return { clarity: "unclear", task: "尽量实现登录", questions: ["用哪个数据库？"] };
      },
      async planSteps() {
        return [{ id: "s1", agent: "", goal: "猜一个数据库实现登录", dependsOn: [] }];
      },
      async matchAgent() {
        return null;
      },
      async summarize() {
        undefined;
      }
    },
    supervisor: {
      async dispatch(requests) {
        return requests.map(resultFor);
      }
    },
    agents: { list: () => definitions },
    selfExecute: async (step) => {
      selfExecuted.push(step);
      return resultFor({ taskId: step.id, agent: "supervisor", goal: step.goal });
    },
    log: (line) => logs.push(line)
  });
  await orchestrator.run("实现登录");
  assert.match(logs.join("\n"), /非交互模式无法澄清/);
  assert.deepEqual(
    selfExecuted.map(({ id, goal }) => ({ id, goal })),
    [{ id: "s1", goal: "猜一个数据库实现登录" }]
  );
});

test("planner-assigned agents win over runtime matching", async () => {
  const harness = makeHarness(
    [{ clarity: "complex", task: "任务", questions: [] }],
    [{ id: "s1", agent: "test-writer", goal: "写测试", dependsOn: [] }],
    ["code-reviewer"]
  );
  await harness.orchestrator.run("任务");
  assert.equal(harness.dispatched[0].agent, "test-writer");
  assert.equal(harness.matches.length, 1, "planner assignment skips the matcher");
});

test("planner-named unknown agents fall back to runtime matching", async () => {
  const harness = makeHarness(
    [{ clarity: "complex", task: "任务", questions: [] }],
    [{ id: "s1", agent: "ghost", goal: "做什么", dependsOn: [] }],
    ["code-reviewer"]
  );
  await harness.orchestrator.run("任务");
  assert.equal(harness.dispatched[0].agent, "code-reviewer");
  assert.match(harness.logs.join("\n"), /指定的 agent ghost 未注册，尝试运行时匹配/);
});

test("complex intents run dependency layers with prior results injected", async () => {
  const harness = makeHarness(
    [{ clarity: "complex", task: "重构流程", questions: [] }],
    [
      { id: "s1", agent: "code-reviewer", goal: "定义接口", dependsOn: [] },
      { id: "s2", agent: "test-writer", goal: "实现逻辑", dependsOn: ["s1"] }
    ]
  );
  await harness.orchestrator.run("重构流程");
  assert.equal(harness.dispatched.length, 2, "dependent steps run in separate batches");
  assert.equal(harness.dispatched[1].goal, "实现逻辑\n\n前序步骤结果：\n- s1（code-reviewer）completed：1 个文件变更");
  assert.equal(harness.summaries.length, 1);
  assert.equal(harness.summaries[0].outcomes.length, 2);
});

test("planning failures degrade to direct execution", async () => {
  const harness = makeHarness([{ clarity: "complex", task: "重构流程", questions: [] }], undefined, [null]);
  harness.brain.failPlan = true;
  await harness.orchestrator.run("重构流程");
  assert.deepEqual(harness.selfExecuted.map((step) => step.goal), ["重构流程"]);
  assert.match(harness.logs.join("\n"), /规划失败，退化为直接执行/);
});
