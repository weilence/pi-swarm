import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager as PiSessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { createAgent, type AgentFactoryOptions } from "../src/pi/agent-factory.ts";
import type { Agent } from "../src/pi/agent.ts";
import type { StreamMetrics } from "../src/pi/stream-metrics.ts";
import { SessionBusyError } from "../src/core/session/session-types.ts";
import type { AgentConfigSnapshot, ConfigStore } from "../src/core/config/config-store.ts";
import type { AgentDefinition } from "../src/core/agent-format.ts";

/** 测试用最小定义：supervisor 角色的内置提示词等价物。 */
function makeDefinition(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    name: "supervisor",
    description: "pi-swarm 协调者（测试定义）",
    capabilities: [],
    tools: [],
    tags: [],
    systemPrompt: "You are the pi-swarm Supervisor agent coordinating user-defined sub-agents.",
    sourceFile: "<test>",
    ...overrides
  };
}

/** In-memory ConfigStore recording every save; load() returns the latest snapshot. */
function makeStore(): ConfigStore & { saved: AgentConfigSnapshot[] } {
  const saved: AgentConfigSnapshot[] = [];
  return {
    saved,
    async load() {
      return saved.length > 0 ? { ...saved[saved.length - 1] } : {};
    },
    async save(config: AgentConfigSnapshot) {
      saved.push({ ...config });
    }
  };
}

/** These tests never open a Pi session, so no stream events ever fire and no
 *  event subscription is needed — agents are exercised through their config API. */

/** An agent wired through the unified factory; the Pi session is never created in these tests. */
function makeAgent(store: ConfigStore, extra: Partial<AgentFactoryOptions> = {}): Agent {
  return createAgent({
    definition: makeDefinition(),
    configStore: store,
    cwd: process.cwd(),
    agentDir: "not-created-in-tests",
    ...extra
  });
}

/** 构造 assistant 流式 usage 事件（供 StreamMetrics 管道测试驱动）。 */
function update(output: number | undefined): AgentSessionEvent {
  return {
    type: "message_update",
    message: { role: "assistant", usage: output === undefined ? undefined : { output } }
  } as unknown as AgentSessionEvent;
}

function streamEnd(): AgentSessionEvent {
  return { type: "message_end", message: { role: "assistant" } } as unknown as AgentSessionEvent;
}

test("configureProvider persists the provider without opening a session", async () => {
  const store = makeStore();
  const agent = makeAgent(store);
  const providerConfig = { api: "anthropic-messages", models: [{ id: "claude-sonnet-4" }] };
  const message = await agent.configureProvider("anthropic", providerConfig, "claude-sonnet-4");
  assert.match(message, /provider 已配置/);
  assert.deepEqual(store.saved, [{ providerId: "anthropic", providerConfig, model: "anthropic/claude-sonnet-4" }]);
  assert.match(agent.status(), /配置已就绪（provider anthropic，模型 anthropic\/claude-sonnet-4），会话尚未建立/);
});

test("configureProvider and setModel merge into one snapshot", async () => {
  const store = makeStore();
  const agent = makeAgent(store);
  await agent.configureProvider("anthropic", { api: "anthropic-messages" });
  await agent.setModel("anthropic/claude-haiku-4");
  assert.deepEqual(store.saved[store.saved.length - 1], {
    providerId: "anthropic",
    providerConfig: { api: "anthropic-messages" },
    model: "anthropic/claude-haiku-4"
  });
});

test("setThinkingLevel requires a model and persists nothing without one", async () => {
  const store = makeStore();
  const agent = makeAgent(store);
  assert.deepEqual(agent.thinkingLevels(), []);
  await assert.rejects(agent.setThinkingLevel("high"), /请先使用 \/model/);
  assert.equal(store.saved.length, 0);
});

test("persistence failures propagate to the caller", async () => {
  const agent = createAgent({
    definition: makeDefinition(),
    cwd: process.cwd(),
    agentDir: "not-created-in-tests",
    configStore: {
      async load() {
        return {};
      },
      async save() {
        throw new Error("disk full");
      }
    }
  });
  await assert.rejects(agent.setModel("openai/gpt-4o"), /disk full/);
});

test("setApiKey requires a configured provider", async () => {
  const agent = makeAgent(makeStore());
  await assert.rejects(agent.setApiKey("sk-test"), /请先使用 \/provider/);
});

test("setApiKey persists the key, masks it in status, and survives as a snapshot field", async () => {
  const store = makeStore();
  const agent = makeAgent(store);
  await agent.configureProvider("anthropic", { api: "anthropic-messages", apiKey: "$ANTHROPIC_API_KEY" });
  const message = await agent.setApiKey("sk-ant-1234567890abcd");
  assert.match(message, /API key 已配置并持久化（sk-\.\.\.abcd）/);
  assert.equal(store.saved[store.saved.length - 1].apiKey, "sk-ant-1234567890abcd");
  assert.equal(store.saved[store.saved.length - 1].providerId, "anthropic");
  assert.match(agent.status(), /API key sk-\.\.\.abcd/);
});

test("empty api keys are rejected", async () => {
  const store = makeStore();
  const agent = makeAgent(store);
  await agent.configureProvider("anthropic", { api: "anthropic-messages" });
  await assert.rejects(agent.setApiKey("  "), /API key 不能为空/);
  assert.equal(store.saved[store.saved.length - 1].apiKey, undefined);
});

test("switching providers drops a model selected for the previous one", async () => {
  const store = makeStore();
  const agent = makeAgent(store);
  await agent.configureProvider("anthropic", { api: "anthropic-messages" }, "claude-sonnet-4");
  await agent.configureProvider("openai", { api: "openai-responses" });
  const last = store.saved[store.saved.length - 1];
  assert.equal(last.providerId, "openai");
  assert.equal(last.model, undefined);
  assert.doesNotMatch(agent.status(), /模型/);
});

test("restore ignores a persisted model that belongs to another provider", async () => {
  const store = makeStore();
  await store.save({
    providerId: "openai",
    model: "anthropic/claude-sonnet-4",
    providerConfig: { api: "openai-responses" }
  });
  const agent = makeAgent(store);
  const summary = await agent.restore();
  assert.match(summary, /模型 anthropic\/claude-sonnet-4（与 provider 不匹配，已忽略）/);
  assert.doesNotMatch(agent.status(), /模型/);
});

test("restore applies a persisted snapshot and reports it", async () => {
  const store = makeStore();
  await store.save({
    providerId: "openai",
    model: "openai/gpt-4o",
    thinkingLevel: "medium",
    providerConfig: { api: "openai-responses" }
  });
  const agent = makeAgent(store);
  const summary = await agent.restore();
  assert.match(summary, /已恢复配置：provider openai，模型 openai\/gpt-4o，thinking medium/);
  assert.match(agent.status(), /配置已就绪（provider openai，模型 openai\/gpt-4o，thinking medium），会话尚未建立/);
  // The level stays pending until a session opens and the model can clamp it.
  assert.deepEqual(agent.thinkingLevels(), []);
});

test("restore applies the persisted api key over the provider config", async () => {
  const store = makeStore();
  await store.save({
    providerId: "openai",
    model: "openai/gpt-4o",
    apiKey: "sk-real-key-9999",
    providerConfig: { api: "openai-responses", apiKey: "$OPENAI_API_KEY" }
  });
  const agent = makeAgent(store);
  const summary = await agent.restore();
  assert.match(summary, /已恢复配置：provider openai，API key sk-\.\.\.9999，模型 openai\/gpt-4o/);
  assert.match(agent.status(), /API key sk-\.\.\.9999/);
});

test("restore without saved config reports an empty state", async () => {
  const agent = makeAgent(makeStore());
  assert.equal(await agent.restore(), "无已保存的配置");
  assert.match(agent.status(), /会话尚未建立，未配置模型/);
});

test("rebind refuses to switch while a prompt is streaming", async () => {
  const agent = makeAgent(makeStore());
  assert.equal(agent.isBusy(), false);
  // Enter the busy state directly: only promptModel can set it at runtime.
  (agent as unknown as { prompting: boolean }).prompting = true;
  assert.equal(agent.isBusy(), true);
  await assert.rejects(agent.rebind(PiSessionManager.inMemory()), SessionBusyError);
});

test("statusSnapshot plumbs host session stats and stream metrics into the UI shape", () => {
  let now = 1_000;
  const agent = makeAgent(makeStore(), { now: () => now });
  // 门面内部结构：prompting 守卫、会话宿主、指标观测器。
  const internals = agent as unknown as {
    prompting: boolean;
    host: { current: unknown };
    metrics: StreamMetrics;
  };

  // 草稿态（无会话）：只回显待生效偏好与 busy，无任何指标。
  internals.prompting = true;
  const draft = agent.statusSnapshot;
  assert.equal(draft.model, undefined);
  assert.equal(draft.busy, true);
  assert.equal(draft.ttftMs, undefined);
  assert.equal(draft.avgOutputSpeed, undefined);

  // 快照只读 session 的这几块表面，用最小假体替代真实 Pi 会话。
  internals.host.current = {
    model: { provider: "openai", id: "gpt-4o" },
    thinkingLevel: "high",
    getSessionStats: () => ({
      contextUsage: { tokens: 12_000, contextWindow: 128_000, percent: 9.4 },
      tokens: { input: 10, output: 100, cacheRead: 40, cacheWrite: 0 },
      cost: 0.01
    })
  };
  // 输出中：TTFT = 首字符(1.6s) - 派发(1.0s) = 600ms；
  // 速度窗口 1.6s → 5.6s = 4s，窗口内产出 = 100 + 50 - 30 = 120。
  internals.metrics.markPromptStart();
  now = 1_600;
  internals.metrics.handle(update(0), 30);
  now = 5_600;
  internals.metrics.handle(update(50), 100);
  const busy = agent.statusSnapshot;
  assert.equal(busy.model, "openai/gpt-4o");
  assert.equal(busy.thinkingLevel, "high");
  assert.equal(busy.ttftMs, 600);
  assert.equal(busy.avgOutputSpeed, 120 / 4);
  assert.equal(busy.outputTokens, 150); // 会话累计 100 + running 50
  assert.equal(busy.busy, true);

  // 结束后：窗口定格在结束时刻，running 已并入会话统计；指标保留展示。
  now = 8_600;
  internals.metrics.markPromptEnd();
  internals.metrics.handle(streamEnd(), 100);
  internals.prompting = false;
  const done = agent.statusSnapshot;
  assert.equal(done.ttftMs, 600);
  assert.equal(done.avgOutputSpeed, 10); // (100 - 30) / 7s
  assert.equal(done.outputTokens, 100);
  assert.equal(done.busy, false);
});
