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
import type { ModuleDefinition, TaskEnvelope, WorkerResult } from "../src/protocol/contracts.ts";

const modules: ModuleDefinition[] = [
  { id: "user-service", path: ".temp/modules/user-service", contextFiles: [], allowedPaths: [], testCommand: "npm test", contractCommand: "" },
  { id: "order-service", path: ".temp/modules/order-service", contextFiles: [], allowedPaths: [], testCommand: "npm test", contractCommand: "" }
];

function resultFor(task: TaskEnvelope): WorkerResult {
  return {
    taskId: task.taskId,
    module: task.module,
    status: "completed",
    changedFiles: task.taskId === "s1" ? ["a.ts"] : [],
    tests: [],
    risks: [],
    messages: []
  };
}

interface Harness {
  orchestrator: Orchestrator;
  dispatched: TaskEnvelope[][];
  asked: string[];
  summaries: { goal: string; outcomes: StepOutcome[] }[];
  logs: string[];
  brain: {
    intent: IntentAnalysis[];
    plan?: PlannedStep[];
    failIntent?: boolean;
    failPlan?: boolean;
    clarifyAnswer?: string;
  };
  askUser(answer?: string): void;
}

function makeHarness(initialIntent: IntentAnalysis[], plan?: PlannedStep[]): Harness {
  const dispatched: TaskEnvelope[][] = [];
  const asked: string[] = [];
  const summaries: { goal: string; outcomes: StepOutcome[] }[] = [];
  const logs: string[] = [];
  const brain: Harness["brain"] = { intent: [...initialIntent], plan };
  const harness: Harness = {
    orchestrator: undefined as never,
    dispatched,
    asked,
    summaries,
    logs,
    brain,
    askUser(answer = "") {
      brain.clarifyAnswer = answer;
    }
  };
  const agent: AgentBrain = {
    async analyzeIntent(_input: string, _modules: ModuleDefinition[], _clarifications?: string) {
      if (brain.failIntent) throw new Error("no model configured");
      const next = brain.intent.shift();
      if (!next) throw new Error("no more canned analyses");
      return next;
    },
    async planSteps() {
      if (brain.failPlan || !brain.plan) throw new Error("plan unavailable");
      return brain.plan;
    },
    async summarize(goal, outcomes) {
      summaries.push({ goal, outcomes });
    }
  };
  harness.orchestrator = new Orchestrator({
    agent,
    supervisor: {
      async dispatch(tasks) {
        dispatched.push(tasks);
        return tasks.map(resultFor);
      }
    },
    modules,
    defaultModule: "user-service",
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
    { id: "s1", module: "user-service", goal: "a", dependsOn: [] },
    { id: "s2", module: "order-service", goal: "b", dependsOn: ["s1"] },
    { id: "s3", module: "user-service", goal: "c", dependsOn: ["s1"] },
    { id: "s4", module: "order-service", goal: "d", dependsOn: ["s2", "s3"] }
  ];
  assert.deepEqual(
    dependencyLayers(steps).map((layer) => layer.map((step) => step.id)),
    [["s1"], ["s2", "s3"], ["s4"]]
  );
});

test("dependencyLayers degrades cycles and ignores unknown dependencies", () => {
  const cyclic: PlannedStep[] = [
    { id: "s1", module: "user-service", goal: "a", dependsOn: ["s2"] },
    { id: "s2", module: "user-service", goal: "b", dependsOn: ["s1"] }
  ];
  assert.equal(dependencyLayers(cyclic).length, 1, "cycles run together in one batch");
  const unknown: PlannedStep[] = [{ id: "s1", module: "user-service", goal: "a", dependsOn: ["nope"] }];
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
    parsePlannedSteps({ steps: [{ id: " s1 ", module: 5, goal: "g", dependsOn: ["x", 3] }, { id: "", goal: "dropped" }] }),
    [{ id: "s1", module: "", goal: "g", dependsOn: ["x"] }]
  );
  assert.equal(parsePlannedSteps({ steps: [] }), undefined);
});

test("simple intents run a single step and summarize", async () => {
  const harness = makeHarness([{ clarity: "simple", task: "提炼后的任务", questions: [] }]);
  await harness.orchestrator.run("原始输入");
  assert.equal(harness.dispatched.length, 1);
  assert.equal(harness.dispatched[0].length, 1);
  assert.equal(harness.dispatched[0][0].goal, "提炼后的任务");
  assert.equal(harness.dispatched[0][0].module, "user-service");
  assert.equal(harness.summaries.length, 1);
  assert.equal(harness.asked.length, 0);
});

test("unclear intents ask once, re-analyze with the answer, then execute", async () => {
  const harness = makeHarness([
    { clarity: "unclear", task: "", questions: ["用哪个数据库？", "要不要兼容旧接口？"] },
    { clarity: "simple", task: "用 postgres 实现登录", questions: [] }
  ]);
  harness.askUser("用 postgres，不需要兼容");
  await harness.orchestrator.run("实现登录");
  assert.equal(harness.asked.length, 1);
  assert.match(harness.asked[0], /1\. 用哪个数据库/);
  assert.equal(harness.dispatched[0][0].goal, "用 postgres 实现登录");
});

test("unclear intents without an interactive channel proceed with planning", async () => {
  const harness = makeHarness([{ clarity: "unclear", task: "尽量实现登录", questions: ["用哪个数据库？"] }]);
  const logs: string[] = [];
  const orchestrator = new Orchestrator({
    agent: {
      async analyzeIntent() {
        return { clarity: "unclear", task: "尽量实现登录", questions: ["用哪个数据库？"] };
      },
      async planSteps() {
        return [{ id: "s1", module: "user-service", goal: "猜一个数据库实现登录", dependsOn: [] }];
      },
      async summarize() {
        undefined;
      }
    },
    supervisor: {
      async dispatch(tasks) {
        harness.dispatched.push(tasks);
        return tasks.map(resultFor);
      }
    },
    modules,
    defaultModule: "user-service",
    log: (line) => logs.push(line)
  });
  await orchestrator.run("实现登录");
  assert.match(logs.join("\n"), /非交互模式无法澄清/);
  assert.equal(harness.dispatched.length, 1);
  assert.equal(harness.dispatched[0][0].goal, "猜一个数据库实现登录");
});

test("complex intents run dependency layers with prior results injected", async () => {
  const harness = makeHarness(
    [{ clarity: "complex", task: "重构订单流程", questions: [] }],
    [
      { id: "s1", module: "user-service", goal: "定义用户接口", dependsOn: [] },
      { id: "s2", module: "order-service", goal: "实现订单逻辑", dependsOn: ["s1"] }
    ]
  );
  await harness.orchestrator.run("重构订单流程");
  assert.equal(harness.dispatched.length, 2, "dependent steps run in separate batches");
  assert.equal(harness.dispatched[0][0].taskId, "s1");
  assert.equal(harness.dispatched[1][0].goal, "实现订单逻辑\n\n前序步骤结果：\n- s1（user-service）completed：1 个文件变更");
  assert.equal(harness.summaries.length, 1);
  assert.equal(harness.summaries[0].outcomes.length, 2);
});

test("planning failures degrade to direct execution", async () => {
  const harness = makeHarness([{ clarity: "complex", task: "重构订单流程", questions: [] }]);
  harness.brain.failPlan = true;
  await harness.orchestrator.run("重构订单流程");
  assert.equal(harness.dispatched.length, 1);
  assert.equal(harness.dispatched[0][0].goal, "重构订单流程");
  assert.match(harness.logs.join("\n"), /规划失败，退化为直接执行/);
});

test("steps naming unknown modules fall back to the default module", async () => {
  const harness = makeHarness(
    [{ clarity: "complex", task: "任务", questions: [] }],
    [{ id: "s1", module: "ghost-service", goal: "做什么", dependsOn: [] }]
  );
  await harness.orchestrator.run("任务");
  assert.equal(harness.dispatched[0][0].module, "user-service");
  assert.match(harness.logs.join("\n"), /指定的模块 ghost-service 不存在，改用 user-service/);
});
