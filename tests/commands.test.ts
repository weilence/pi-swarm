import assert from "node:assert/strict";
import { test } from "node:test";
import { executeCommand, type AgentController, type CommandServices, type CommandState } from "../src/cli/commands.ts";
import { THINKING_LEVELS } from "../src/core/thinking.ts";
import type { ModelsDevProvider } from "../src/cli/../models-dev/catalog.ts";

function makeProviders(): ModelsDevProvider[] {
  return [
    {
      id: "anthropic",
      name: "Anthropic",
      npm: "@ai-sdk/anthropic",
      env: ["ANTHROPIC_API_KEY"],
      models: {
        "claude-sonnet-4": { id: "claude-sonnet-4", name: "Claude Sonnet 4", reasoning: true },
        "claude-haiku-4": { id: "claude-haiku-4", name: "Claude Haiku 4" },
        "claude-old": { id: "claude-old", name: "Claude Old", status: "deprecated" },
        "claude-lab": { id: "claude-lab", name: "Claude Lab", experimental: true, tool_call: false, knowledge: "2026-01", description: "实验通道", family: "claude" }
      }
    },
    {
      id: "openai",
      name: "OpenAI",
      npm: "@ai-sdk/openai",
      env: ["OPENAI_API_KEY"],
      models: { "gpt-4o": { id: "gpt-4o", name: "GPT-4o" } }
    }
  ];
}

interface Recording {
  providerConfigs: Array<{ providerId: string; api: string; modelId?: string }>;
  models: string[];
  thinkingLevels: string[];
  apiKeys?: string[];
}

function makeAgent(recording: Recording): AgentController {
  return {
    async configureProvider(providerId: string, config: { api?: string }, modelId?: string) {
      recording.providerConfigs.push({ providerId, api: config.api ?? "?", modelId });
      return `provider 已配置，接口：${config.api ?? "默认"}`;
    },
    async setModel(specifier: string) {
      recording.models.push(specifier);
      return `当前模型：${specifier}`;
    },
    async setThinkingLevel(level: string) {
      if (!THINKING_LEVELS.includes(level)) throw new Error(`thinking level 应为：${THINKING_LEVELS.join(", ")}`);
      recording.thinkingLevels.push(level);
      return `当前 thinking level：${level}`;
    },
    async setApiKey(key: string) {
      (recording.apiKeys ??= []).push(key);
      return `API key 已配置并持久化（***）`;
    },
    status() {
      return "模型：未选择；thinking：off";
    }
  };
}

function makeServices(
  recording: Recording,
  picks: unknown[] = [],
  interactive = false
): CommandServices & { logs: string[] } {
  const logs: string[] = [];
  const pickQueue = [...picks];
  return {
    agent: makeAgent(recording),
    catalog: { load: async () => makeProviders() },
    log: (line: string) => logs.push(line),
    pick: async <T,>(_title: string, options: readonly { value: T }[]) => {
      const next = pickQueue.shift();
      return options.find((option) => option.value === next)?.value;
    },
    interactive,
    get logs() {
      return logs;
    }
  };
}

test("bare /provider in non-interactive mode lists providers", async () => {
  const services = makeServices({ providerConfigs: [], models: [], thinkingLevels: [] });
  const outcome = await executeCommand("/provider", services, {});
  assert.equal(outcome, "continue");
  assert.match(services.logs.join("\n"), /providers：anthropic \(Anthropic\), openai \(OpenAI\)/);
});

test("/provider <id> configures the agent and lists models", async () => {
  const recording = { providerConfigs: [] as Recording["providerConfigs"], models: [], thinkingLevels: [] };
  const services = makeServices(recording);
  await executeCommand("/provider anthropic", services, {});
  assert.equal(recording.providerConfigs.length, 1);
  assert.equal(recording.providerConfigs[0].providerId, "anthropic");
  assert.equal(recording.providerConfigs[0].api, "anthropic-messages");
  assert.match(services.logs.join("\n"), /可用模型：claude-sonnet-4, claude-haiku-4/);
});

test("/provider with an exact api id passes it through", async () => {
  const recording = { providerConfigs: [] as Recording["providerConfigs"], models: [], thinkingLevels: [] };
  const services = makeServices(recording);
  await executeCommand("/provider openai openai-responses", services, {});
  assert.equal(recording.providerConfigs[0].api, "openai-responses");
});

test("/provider rejects api aliases and wrong case", async () => {
  const services = makeServices({ providerConfigs: [], models: [], thinkingLevels: [] });
  await executeCommand("/provider openai responses", services, {});
  await executeCommand("/provider openai OpenAI-Responses", services, {});
  const logs = services.logs.join("\n");
  assert.match(logs, /不支持的 Pi 接口类型：responses（可选：/);
  assert.match(logs, /不支持的 Pi 接口类型：OpenAI-Responses/);
});

test("/provider with an unknown id reports a failure", async () => {
  const services = makeServices({ providerConfigs: [], models: [], thinkingLevels: [] });
  await executeCommand("/provider nobody", services, {});
  assert.match(services.logs.join("\n"), /provider 配置失败：models\.dev 中找不到 provider：nobody/);
});

test("interactive /provider chains provider, api, and model pickers", async () => {
  const recording = { providerConfigs: [] as Recording["providerConfigs"], models: [], thinkingLevels: [] };
  const services = makeServices(recording, ["anthropic", "auto", "claude-sonnet-4"], true);
  await executeCommand("/provider", services, {});
  assert.equal(recording.providerConfigs[0].providerId, "anthropic");
  assert.equal(recording.providerConfigs[0].api, "anthropic-messages");
  assert.deepEqual(recording.models, ["anthropic/claude-sonnet-4"]);
});

test("interactive /provider skipping the model picker still configures the provider", async () => {
  const recording = { providerConfigs: [] as Recording["providerConfigs"], models: [], thinkingLevels: [] };
  const services = makeServices(recording, ["openai", "openai-responses", undefined], true);
  await executeCommand("/provider", services, {});
  assert.equal(recording.providerConfigs[0].api, "openai-responses");
  assert.deepEqual(recording.models, []);
  assert.match(services.logs.join("\n"), /已跳过模型选择/);
});

test("bare /model requires a provider first and interactive /model picks one", async () => {
  const recording = { providerConfigs: [] as Recording["providerConfigs"], models: [], thinkingLevels: [] };
  const plain = makeServices(recording);
  await executeCommand("/model", plain, {});
  assert.match(plain.logs.join("\n"), /请先使用 \/provider/);

  const interactive = makeServices(recording, ["auto", "claude-haiku-4"], true);
  const state: CommandState = {};
  await executeCommand("/provider anthropic", interactive, state);
  await executeCommand("/model", interactive, state);
  assert.deepEqual(recording.models, ["anthropic/claude-haiku-4"]);
});

test("/model rejects unknown models for the selected provider but passes raw specifiers through", async () => {
  const recording = { providerConfigs: [] as Recording["providerConfigs"], models: [], thinkingLevels: [] };
  const services = makeServices(recording);
  const state: CommandState = {};
  await executeCommand("/provider anthropic", services, state);
  await executeCommand("/model nope", services, state);
  assert.match(services.logs.join("\n"), /provider anthropic 没有模型：nope/);
  await executeCommand("/model models-dev/custom-model", services, state);
  assert.deepEqual(recording.models, ["models-dev/custom-model"]);
});

test("/apikey sets the key through the agent and reports usage with env hints", async () => {
  const recording: Recording = { providerConfigs: [], models: [], thinkingLevels: [] };
  const services = makeServices(recording);
  await executeCommand("/apikey sk-secret-1234", services, {});
  assert.deepEqual(recording.apiKeys, ["sk-secret-1234"]);
  assert.match(services.logs.join("\n"), /API key 已配置并持久化/);

  const state: CommandState = {};
  await executeCommand("/provider anthropic", services, state);
  await executeCommand("/apikey", services, state);
  assert.match(services.logs.join("\n"), /环境变量 ANTHROPIC_API_KEY 读取密钥/);
  assert.match(services.logs.join("\n"), /\/apikey <key>/);
});

test("/apikey failures surface the agent error", async () => {
  const recording = { providerConfigs: [] as Recording["providerConfigs"], models: [], thinkingLevels: [] };
  const services = makeServices(recording);
  services.agent = {
    ...makeAgent(recording),
    async setApiKey() {
      throw new Error("请先使用 /provider 选择 provider");
    }
  };
  await executeCommand("/apikey sk-secret", services, {});
  assert.match(services.logs.join("\n"), /API key 配置失败：请先使用 \/provider 选择 provider/);
});

test("/thinking validates levels and bare form lists or picks them", async () => {
  const recording = { providerConfigs: [] as Recording["providerConfigs"], models: [], thinkingLevels: [] };
  const services = makeServices(recording);
  await executeCommand("/thinking high", services, {});
  await executeCommand("/thinking wild", services, {});
  assert.match(services.logs.join("\n"), /thinking 切换失败：thinking level 应为/);
  assert.deepEqual(recording.thinkingLevels, ["high"]);

  await executeCommand("/thinking", services, {});
  assert.match(services.logs.join("\n"), /thinking level 可选：off, minimal, low, medium, high, xhigh, max/);

  const interactive = makeServices(recording, ["xhigh"], true);
  await executeCommand("/thinking", interactive, {});
  assert.deepEqual(recording.thinkingLevels, ["high", "xhigh"]);
});

test("/status reports supervisor state and /exit wins over other commands", async () => {
  const services = makeServices({ providerConfigs: [], models: [], thinkingLevels: [] });
  assert.equal(await executeCommand("/status", services, {}), "continue");
  assert.match(services.logs.join("\n"), /模型：未选择；thinking：off/);
  assert.equal(await executeCommand("/exit", services, {}), "exit");
  assert.equal(await executeCommand("/quit", services, {}), "exit");
});

const noAgents = { list: () => [] };

test("task input runs through the supervisor's runTask", async () => {
  const recording = { providerConfigs: [] as Recording["providerConfigs"], models: [], thinkingLevels: [] };
  const services = makeServices(recording);
  services.agents = noAgents;
  const ran: string[] = [];
  services.agent = {
    ...makeAgent(recording),
    async runTask(goal: string) {
      ran.push(goal);
      return "任务完成";
    }
  };
  await executeCommand("实现登录", services, {});
  assert.deepEqual(ran, ["实现登录"]);
});

test("task input is echoed into the transcript before the task runs", async () => {
  const recording = { providerConfigs: [] as Recording["providerConfigs"], models: [], thinkingLevels: [] };
  const services = makeServices(recording);
  services.agents = noAgents;
  const timeline: string[] = [];
  // logMarkdown 未提供时回落 log：回显与日志同通道，顺序可断言
  services.log = (line) => timeline.push(line);
  services.agent = {
    ...makeAgent(recording),
    async runTask(goal: string) {
      timeline.push(`[runTask] ${goal}`);
      return "任务完成";
    }
  };
  await executeCommand("实现登录", services, {});
  assert.deepEqual(timeline, ["**▸ 你**\n\n实现登录", "[runTask] 实现登录"]);
});

test("rejected dispatch (busy) leaves the input out of the transcript", async () => {
  const recording = { providerConfigs: [] as Recording["providerConfigs"], models: [], thinkingLevels: [] };
  const services = makeServices(recording);
  services.agent = {
    ...makeAgent(recording),
    isBusy: () => true,
    async runTask() {
      throw new Error("should not run");
    }
  };
  await executeCommand("实现登录", services, {});
  assert.match(services.logs.join("\n"), /已有任务正在执行/);
  assert.ok(!services.logs.includes("**▸ 你**\n\n实现登录"), "busy dispatch must not echo");
});

test("task input is rejected while the supervisor is busy", async () => {
  const recording = { providerConfigs: [] as Recording["providerConfigs"], models: [], thinkingLevels: [] };
  const services = makeServices(recording);
  services.agent = {
    ...makeAgent(recording),
    isBusy: () => true,
    async runTask() {
      throw new Error("should not run");
    }
  };
  await executeCommand("实现登录", services, {});
  assert.match(services.logs.join("\n"), /已有任务正在执行/);
});

test("runTask failures surface as a task error log", async () => {
  const recording = { providerConfigs: [] as Recording["providerConfigs"], models: [], thinkingLevels: [] };
  const services = makeServices(recording);
  services.agent = {
    ...makeAgent(recording),
    async runTask() {
      throw new Error("no model configured");
    }
  };
  await executeCommand("实现登录", services, {});
  assert.match(services.logs.join("\n"), /任务执行失败：no model configured/);
});

test("/status lists the loaded agents", async () => {
  const recording = { providerConfigs: [] as Recording["providerConfigs"], models: [], thinkingLevels: [] };
  const services = makeServices(recording);
  services.agents = {
    list: () => [
      { name: "code-reviewer", description: "d", capabilities: [], tools: [], tags: [], systemPrompt: "s", sourceFile: "a.md" }
    ]
  };
  await executeCommand("/status", services, {});
  assert.match(services.logs.join("\n"), /已加载 agents：code-reviewer/);

  const empty = makeServices(recording);
  empty.agents = noAgents;
  await executeCommand("/status", empty, {});
  assert.match(empty.logs.join("\n"), /未加载任何子 agent，所有任务由 supervisor 自执行/);
});

test("deprecated models are hidden and badges annotate the model listings", async () => {
  const recording = { providerConfigs: [] as Recording["providerConfigs"], models: [], thinkingLevels: [] };
  const services = makeServices(recording);
  const state: CommandState = {};
  await executeCommand("/provider anthropic", services, state);
  const listed = services.logs.join("\n");
  assert.doesNotMatch(listed, /claude-old/);
  assert.match(listed, /claude-lab（experimental，无工具调用，知识截止 2026-01）/);

  await executeCommand("/model", services, state);
  const models = services.logs.join("\n");
  assert.doesNotMatch(models, /claude-old/);
  assert.match(models, /claude-lab \(Claude Lab；experimental，无工具调用，知识截止 2026-01\)/);
});
