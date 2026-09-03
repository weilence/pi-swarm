import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager as PiSessionManager } from "@earendil-works/pi-coding-agent";
import { SupervisorAgent } from "../src/pi/supervisor-agent.ts";
import { SessionBusyError } from "../src/core/session/session-types.ts";
import type { AgentConfigSnapshot, ConfigStore } from "../src/core/config/config-store.ts";

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

/** No-op stream sinks: these tests never open a Pi session, nothing streams. */
const silentSinks = {
  onText: () => undefined,
  onThinking: () => undefined,
  onStreamEnd: () => undefined,
  onToolStart: () => undefined,
  onToolEnd: () => undefined
};

/** A SupervisorAgent wired to the fake store; the Pi session is never created in these tests. */
function makeAgent(store: ConfigStore): SupervisorAgent {
  return new SupervisorAgent({ ...silentSinks, configStore: store, cwd: process.cwd(), agentDir: "not-created-in-tests" });
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

test("setModel and setThinkingLevel merge into one snapshot", async () => {
  const store = makeStore();
  const agent = makeAgent(store);
  await agent.configureProvider("anthropic", { api: "anthropic-messages" });
  await agent.setModel("anthropic/claude-haiku-4");
  await agent.setThinkingLevel("high");
  assert.deepEqual(store.saved[store.saved.length - 1], {
    providerId: "anthropic",
    providerConfig: { api: "anthropic-messages" },
    model: "anthropic/claude-haiku-4",
    thinkingLevel: "high"
  });
});

test("invalid thinking levels throw and persist nothing", async () => {
  const store = makeStore();
  const agent = makeAgent(store);
  await assert.rejects(agent.setThinkingLevel("wild"), /thinking level 应为/);
  assert.equal(store.saved.length, 0);
});

test("persistence failures propagate to the caller", async () => {
  const agent = new SupervisorAgent({
    ...silentSinks,
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
