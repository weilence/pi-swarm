import assert from "node:assert/strict";
import { test } from "node:test";
import { buildMatchPrompt, dispatchTask, parseMatchReply, type AgentMatcher } from "../src/core/agent-dispatch.ts";
import type { AgentDefinition } from "../src/core/agent-format.ts";

const agents: AgentDefinition[] = [
  {
    name: "code-reviewer",
    description: "审查代码变更，输出分级评审意见",
    capabilities: ["识别逻辑缺陷", "输出结构化意见"],
    tools: ["read", "bash"],
    model: undefined,
    tags: [],
    systemPrompt: "你是资深代码评审员。",
    sourceFile: "code-reviewer.md"
  },
  {
    name: "test-writer",
    description: "为模块编写单元测试与契约测试",
    capabilities: ["node:test 用例设计"],
    tools: ["read", "bash"],
    model: undefined,
    tags: [],
    systemPrompt: "你是测试工程师。",
    sourceFile: "test-writer.md"
  }
];

const reply = (text: string): AgentMatcher => async () => text;

test("routes to the agent named by the matcher", async () => {
  const decision = await dispatchTask("帮我审查这段 diff", agents, reply('{"agent": "code-reviewer"}'));
  assert.equal(decision.mode, "agent");
  if (decision.mode === "agent") assert.equal(decision.agent.name, "code-reviewer");
});

test("explicit null falls back to supervisor self-execution", async () => {
  const decision = await dispatchTask("帮我订一杯咖啡", agents, reply('{"agent": null}'));
  assert.equal(decision.mode, "supervisor");
});

test("empty registry short-circuits to supervisor", async () => {
  let called = false;
  const decision = await dispatchTask("任意任务", [], async () => {
    called = true;
    return '{"agent": "code-reviewer"}';
  });
  assert.equal(decision.mode, "supervisor");
  assert.equal(called, false);
});

test("unknown agent name degrades to supervisor instead of crashing", async () => {
  const decision = await dispatchTask("任意任务", agents, reply('{"agent": "no-such-agent"}'));
  assert.equal(decision.mode, "supervisor");
});

test("unparsable or garbage replies degrade to supervisor", async () => {
  for (const garbage of ["我觉得 code-reviewer 不错", "{}", '```json\n{"agent": 42}\n```']) {
    const decision = await dispatchTask("任意任务", agents, reply(garbage));
    assert.equal(decision.mode, "supervisor");
  }
});

test("matcher failures degrade to supervisor with a reason", async () => {
  const decision = await dispatchTask("任意任务", agents, async () => {
    throw new Error("网络超时");
  });
  assert.equal(decision.mode, "supervisor");
  if (decision.mode === "supervisor") assert.match(decision.reason, /网络超时/);
});

test("parseMatchReply accepts fenced JSON and null", () => {
  assert.deepEqual(parseMatchReply('```json\n{"agent": "test-writer"}\n```'), { agent: "test-writer" });
  assert.deepEqual(parseMatchReply('{"agent": null}'), { agent: null });
  assert.equal(parseMatchReply("前置说明 {\"agent\": \"x\"} 后置说明")?.agent, "x");
  assert.equal(parseMatchReply("完全没有 JSON"), undefined);
});

test("buildMatchPrompt lists every agent with description and capabilities", () => {
  const prompt = buildMatchPrompt("帮我写测试", agents);
  assert.ok(prompt.includes("code-reviewer"));
  assert.ok(prompt.includes("test-writer"));
  assert.ok(prompt.includes("识别逻辑缺陷"));
  assert.ok(prompt.includes("帮我写测试"));
  assert.ok(prompt.includes("仅输出 JSON"));
});
