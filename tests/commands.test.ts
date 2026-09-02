import assert from "node:assert/strict";
import { test } from "node:test";
import { executeCommand, type CommandServices, type CommandState } from "../src/cli/commands.ts";
import type { ConfigurableModuleWorker } from "../src/core/worker.ts";
import { THINKING_LEVELS } from "../src/core/worker.ts";
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
        "claude-haiku-4": { id: "claude-haiku-4", name: "Claude Haiku 4" }
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
}

function makeWorker(recording: Recording): ConfigurableModuleWorker {
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
    status() {
      return "模型：未选择；thinking：off";
    },
    async run() {
      throw new Error("not used in these tests");
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
    worker: makeWorker(recording),
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
