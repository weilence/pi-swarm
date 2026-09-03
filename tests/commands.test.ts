import assert from "node:assert/strict";
import { test } from "node:test";
import { executeCommand, type AgentController, type CommandServices, type CommandState } from "../src/cli/commands.ts";
import { THINKING_LEVELS } from "../src/core/worker.ts";
import type { ModelsDevProvider } from "../src/cli/../models-dev/catalog.ts";
import type { ModuleDefinition, TaskEnvelope, WorkerResult } from "../src/protocol/contracts.ts";

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
  const outcome = await executeCommand("/provider", services, { taskNumber: 0 });
  assert.equal(outcome, "continue");
  assert.match(services.logs.join("\n"), /providers：anthropic \(Anthropic\), openai \(OpenAI\)/);
});

test("/provider <id> configures the worker and lists models", async () => {
  const recording = { providerConfigs: [] as Recording["providerConfigs"], models: [], thinkingLevels: [] };
  const services = makeServices(recording);
  await executeCommand("/provider anthropic", services, { taskNumber: 0 });
  assert.equal(recording.providerConfigs.length, 1);
  assert.equal(recording.providerConfigs[0].providerId, "anthropic");
  assert.equal(recording.providerConfigs[0].api, "anthropic-messages");
  assert.match(services.logs.join("\n"), /可用模型：claude-sonnet-4, claude-haiku-4/);
});

test("/provider with an exact api id passes it through", async () => {
  const recording = { providerConfigs: [] as Recording["providerConfigs"], models: [], thinkingLevels: [] };
  const services = makeServices(recording);
  await executeCommand("/provider openai openai-responses", services, { taskNumber: 0 });
  assert.equal(recording.providerConfigs[0].api, "openai-responses");
});

test("/provider rejects api aliases and wrong case", async () => {
  const services = makeServices({ providerConfigs: [], models: [], thinkingLevels: [] });
  await executeCommand("/provider openai responses", services, { taskNumber: 0 });
  await executeCommand("/provider openai OpenAI-Responses", services, { taskNumber: 0 });
  const logs = services.logs.join("\n");
  assert.match(logs, /不支持的 Pi 接口类型：responses（可选：/);
  assert.match(logs, /不支持的 Pi 接口类型：OpenAI-Responses/);
});

test("/provider with an unknown id reports a failure", async () => {
  const services = makeServices({ providerConfigs: [], models: [], thinkingLevels: [] });
  await executeCommand("/provider nobody", services, { taskNumber: 0 });
  assert.match(services.logs.join("\n"), /provider 配置失败：models\.dev 中找不到 provider：nobody/);
});

test("interactive /provider chains provider, api, and model pickers", async () => {
  const recording = { providerConfigs: [] as Recording["providerConfigs"], models: [], thinkingLevels: [] };
  const services = makeServices(recording, ["anthropic", "auto", "claude-sonnet-4"], true);
  await executeCommand("/provider", services, { taskNumber: 0 });
  assert.equal(recording.providerConfigs[0].providerId, "anthropic");
  assert.equal(recording.providerConfigs[0].api, "anthropic-messages");
  assert.deepEqual(recording.models, ["anthropic/claude-sonnet-4"]);
});

test("interactive /provider skipping the model picker still configures the provider", async () => {
  const recording = { providerConfigs: [] as Recording["providerConfigs"], models: [], thinkingLevels: [] };
  const services = makeServices(recording, ["openai", "openai-responses", undefined], true);
  await executeCommand("/provider", services, { taskNumber: 0 });
  assert.equal(recording.providerConfigs[0].api, "openai-responses");
  assert.deepEqual(recording.models, []);
  assert.match(services.logs.join("\n"), /已跳过模型选择/);
});

test("bare /model requires a provider first and interactive /model picks one", async () => {
  const recording = { providerConfigs: [] as Recording["providerConfigs"], models: [], thinkingLevels: [] };
  const plain = makeServices(recording);
  await executeCommand("/model", plain, { taskNumber: 0 });
  assert.match(plain.logs.join("\n"), /请先使用 \/provider/);

  const interactive = makeServices(recording, ["auto", "claude-haiku-4"], true);
  const state: CommandState = { taskNumber: 0 };
  await executeCommand("/provider anthropic", interactive, state);
  await executeCommand("/model", interactive, state);
  assert.deepEqual(recording.models, ["anthropic/claude-haiku-4"]);
});

test("/model rejects unknown models for the selected provider but passes raw specifiers through", async () => {
  const recording = { providerConfigs: [] as Recording["providerConfigs"], models: [], thinkingLevels: [] };
  const services = makeServices(recording);
  const state: CommandState = { taskNumber: 0 };
  await executeCommand("/provider anthropic", services, state);
  await executeCommand("/model nope", services, state);
  assert.match(services.logs.join("\n"), /provider anthropic 没有模型：nope/);
  await executeCommand("/model models-dev/custom-model", services, state);
  assert.deepEqual(recording.models, ["models-dev/custom-model"]);
});

test("/apikey sets the key through the agent and reports usage with env hints", async () => {
  const recording: Recording = { providerConfigs: [], models: [], thinkingLevels: [] };
  const services = makeServices(recording);
  await executeCommand("/apikey sk-secret-1234", services, { taskNumber: 0 });
  assert.deepEqual(recording.apiKeys, ["sk-secret-1234"]);
  assert.match(services.logs.join("\n"), /API key 已配置并持久化/);

  const state: CommandState = { taskNumber: 0 };
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
  await executeCommand("/apikey sk-secret", services, { taskNumber: 0 });
  assert.match(services.logs.join("\n"), /API key 配置失败：请先使用 \/provider 选择 provider/);
});

test("/thinking validates levels and bare form lists or picks them", async () => {
  const recording = { providerConfigs: [] as Recording["providerConfigs"], models: [], thinkingLevels: [] };
  const services = makeServices(recording);
  await executeCommand("/thinking high", services, { taskNumber: 0 });
  await executeCommand("/thinking wild", services, { taskNumber: 0 });
  assert.match(services.logs.join("\n"), /thinking 切换失败：thinking level 应为/);
  assert.deepEqual(recording.thinkingLevels, ["high"]);

  await executeCommand("/thinking", services, { taskNumber: 0 });
  assert.match(services.logs.join("\n"), /thinking level 可选：off, minimal, low, medium, high, xhigh, max/);

  const interactive = makeServices(recording, ["xhigh"], true);
  await executeCommand("/thinking", interactive, { taskNumber: 0 });
  assert.deepEqual(recording.thinkingLevels, ["high", "xhigh"]);
});

test("/status reports worker state and /exit wins over other commands", async () => {
  const services = makeServices({ providerConfigs: [], models: [], thinkingLevels: [] });
  assert.equal(await executeCommand("/status", services, { taskNumber: 0 }), "continue");
  assert.match(services.logs.join("\n"), /模型：未选择；thinking：off/);
  assert.equal(await executeCommand("/exit", services, { taskNumber: 0 }), "exit");
  assert.equal(await executeCommand("/quit", services, { taskNumber: 0 }), "exit");
});

const testModule: ModuleDefinition = {
  id: "user-service",
  path: ".temp/modules/user-service",
  contextFiles: ["AGENT.md"],
  allowedPaths: ["src/**"],
  testCommand: "npm test",
  contractCommand: "npm run contract-test"
};

function makeDispatchRecording(): { dispatched: TaskEnvelope[]; supervisor: { dispatch(tasks: TaskEnvelope[]): Promise<WorkerResult[]> } } {
  const dispatched: TaskEnvelope[] = [];
  return {
    dispatched,
    supervisor: {
      async dispatch(tasks) {
        dispatched.push(...tasks);
        return tasks.map((task) => ({
          taskId: task.taskId,
          module: task.module,
          status: "completed",
          changedFiles: [],
          tests: [],
          risks: [],
          messages: []
        }));
      }
    }
  };
}

test("task dispatch plans through the supervisor agent before delegating", async () => {
  const recording = { providerConfigs: [], models: [], thinkingLevels: [] };
  const services = makeServices(recording);
  const { dispatched, supervisor } = makeDispatchRecording();
  services.supervisor = supervisor;
  services.module = testModule;
  services.agent = {
    ...makeAgent(recording),
    async plan(goal: string) {
      return `1. 拆解 ${goal}`;
    }
  };
  await executeCommand("实现登录", services, { taskNumber: 0 });
  assert.equal(dispatched.length, 1);
  assert.match(dispatched[0].goal, /^实现登录/);
  assert.match(dispatched[0].goal, /Supervisor 规划要点：\n1\. 拆解 实现登录$/);
  assert.match(services.logs.join("\n"), /supervisor 规划完成，任务已交给 worker/);
});

test("dispatch falls back to direct delegation when the supervisor model is unavailable", async () => {
  const recording = { providerConfigs: [], models: [], thinkingLevels: [] };
  const services = makeServices(recording);
  const { dispatched, supervisor } = makeDispatchRecording();
  services.supervisor = supervisor;
  services.module = testModule;
  services.agent = {
    ...makeAgent(recording),
    async plan() {
      throw new Error("no model configured");
    }
  };
  await executeCommand("实现登录", services, { taskNumber: 0 });
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].goal, "实现登录");
  assert.match(services.logs.join("\n"), /supervisor 模型不可用，跳过规划直接派发：no model configured/);
});

test("dispatch without a planning agent delegates the goal as-is", async () => {
  const recording = { providerConfigs: [] as Recording["providerConfigs"], models: [], thinkingLevels: [] };
  const services = makeServices(recording);
  const { dispatched, supervisor } = makeDispatchRecording();
  services.supervisor = supervisor;
  services.module = testModule;
  await executeCommand("实现登录", services, { taskNumber: 0 });
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].goal, "实现登录");
});

test("deprecated models are hidden and badges annotate the model listings", async () => {
  const recording = { providerConfigs: [] as Recording["providerConfigs"], models: [], thinkingLevels: [] };
  const services = makeServices(recording);
  const state: CommandState = { taskNumber: 0 };
  await executeCommand("/provider anthropic", services, state);
  const listed = services.logs.join("\n");
  assert.doesNotMatch(listed, /claude-old/);
  assert.match(listed, /claude-lab（experimental，无工具调用，知识截止 2026-01）/);

  await executeCommand("/model", services, state);
  const models = services.logs.join("\n");
  assert.doesNotMatch(models, /claude-old/);
  assert.match(models, /claude-lab \(Claude Lab；experimental，无工具调用，知识截止 2026-01\)/);
});

test("planning receives the selected model's knowledge cutoff", async () => {
  const recording = { providerConfigs: [] as Recording["providerConfigs"], models: [], thinkingLevels: [] };
  const services = makeServices(recording);
  const { supervisor } = makeDispatchRecording();
  services.supervisor = supervisor;
  services.module = testModule;
  const contexts: (undefined | { knowledgeCutoff?: string })[] = [];
  services.agent = {
    ...makeAgent(recording),
    async plan(_goal: string, _module: unknown, context?: { knowledgeCutoff?: string }) {
      contexts.push(context);
      return "1. 拆解";
    }
  };
  const state: CommandState = { taskNumber: 0 };
  await executeCommand("/provider anthropic", services, state);
  await executeCommand("/model claude-lab", services, state);
  await executeCommand("实现登录", services, state);
  assert.deepEqual(contexts, [{ knowledgeCutoff: "2026-01" }]);
});
