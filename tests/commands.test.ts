import assert from "node:assert/strict";
import { test } from "node:test";
import { executeCommand, type AgentController, type CommandServices, type CommandState } from "../src/cli/commands.ts";
import type { TuiRepl } from "../src/cli/tui-repl.ts";
import type { ModelsDevProvider } from "../src/cli/../models-dev/catalog.ts";

/** Levels of a reasoning model without xhigh/max support, as pi-ai would report. */
const SUPPORTED_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high"];

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
    thinkingLevels() {
      return [...SUPPORTED_THINKING_LEVELS];
    },
    async setThinkingLevel(level: string) {
      if (!SUPPORTED_THINKING_LEVELS.includes(level)) {
        throw new Error(`当前模型支持的 thinking level：${SUPPORTED_THINKING_LEVELS.join(", ")}`);
      }
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

test("/provider and /model pickers preselect and mark the current choice", async () => {
  const recording = { providerConfigs: [], models: [], thinkingLevels: [] };
  const services = makeServices(recording, ["openai", "gpt-4o"], true);
  const seen: Array<readonly { value: unknown; current?: boolean }[]> = [];
  const original = services.pick.bind(services);
  services.pick = async (title, options) => {
    seen.push(options as never);
    return await original(title, options);
  };

  const state: CommandState = { selectedProvider: makeProviders()[1], selectedModelId: "gpt-4o" };
  await executeCommand("/provider", services, state);
  const providers = seen[0];
  assert.equal(providers[0].value, "openai", "the current provider sorts first");
  assert.equal(providers[0].current, true, "the current provider is marked");
  assert.equal(providers.at(-1)?.current, false, "others are not marked");

  // seen[1] 是接口类型选择器（bare /provider 的链式弹窗），模型选择器是 seen[2]。
  const models = seen[2];
  assert.equal(models[0].value, "gpt-4o", "the current model sorts first");
  assert.equal(models[0].current, true, "the current model is marked");
});

test("/context sets, reports, and resets the manual context window", async () => {
  const services = makeServices({ providerConfigs: [], models: [], thinkingLevels: [] });
  const calls: Array<number | undefined> = [];
  services.agent = {
    ...makeAgent({ providerConfigs: [], models: [], thinkingLevels: [] }),
    async setContextWindow(tokens?: number) {
      calls.push(tokens);
      return tokens ? `上下文容量已设为 ${tokens} tokens` : "上下文容量已恢复为模型默认";
    },
    get statusSnapshot() {
      return { model: "openai/gpt-4o", contextWindow: 200000, contextTokens: 12000 };
    }
  } as AgentController;

  await executeCommand("/context", services, {});
  assert.match(services.logs.join("\n"), /当前上下文容量：200000 tokens/);

  // k/w/m 后缀都能解析到同一容量。
  await executeCommand("/context 20w", services, {});
  await executeCommand("/context 200k", services, {});
  await executeCommand("/context 0.2m", services, {});
  assert.deepEqual(calls, [200000, 200000, 200000]);

  await executeCommand("/context reset", services, {});
  assert.equal(calls.at(-1), undefined, "reset restores the model default");

  await executeCommand("/context abc", services, {});
  assert.match(services.logs.join("\n"), /用法：\/context/);
  await executeCommand("/context 1", services, {});
  assert.match(services.logs.join("\n"), /最小 1024/);
  assert.equal(calls.length, 4, "invalid input never reaches the agent");
});

test("/compact compacts the session and supports custom instructions", async () => {
  const services = makeServices({ providerConfigs: [], models: [], thinkingLevels: [] });
  const calls: Array<string | undefined> = [];
  services.agent = {
    ...makeAgent({ providerConfigs: [], models: [], thinkingLevels: [] }),
    async compact(instructions?: string) {
      calls.push(instructions);
      return "已压缩上下文：38000 tokens，压缩后约 8700 tokens；摘要 512 字";
    }
  } as AgentController;

  await executeCommand("/compact", services, {});
  assert.deepEqual(calls, [undefined], "bare /compact uses default summary instructions");
  assert.match(services.logs.join("\n"), /已压缩上下文：38000 tokens/);

  await executeCommand("/compact 只保留结论和文件改动", services, {});
  assert.equal(calls[1], "只保留结论和文件改动", "trailing text passes as custom instructions");
});

test("/compact shows a spinner status line and settles it with the outcome", async () => {
  const services = makeServices({ providerConfigs: [], models: [], thinkingLevels: [] });
  const events: string[] = [];
  services.agent = {
    ...makeAgent({ providerConfigs: [], models: [], thinkingLevels: [] }),
    async compact() {
      return "已压缩上下文：38000 tokens";
    }
  } as AgentController;
  services.repl = {
    beginStatus: (label: string) => {
      events.push(`begin:${label}`);
      return 1;
    },
    endStatus: (id: number, isError: boolean) => {
      events.push(`end:${id}:${isError ? "error" : "ok"}`);
    }
  } as unknown as TuiRepl;

  await executeCommand("/compact", services, {});
  assert.deepEqual(events, ["begin:压缩上下文", "end:1:ok"], "spinner line starts and settles");
  assert.match(services.logs.join("\n"), /已压缩上下文/);
});

test("/compact reports unsupported agents and compaction failures", async () => {
  const plain = makeServices({ providerConfigs: [], models: [], thinkingLevels: [] });
  await executeCommand("/compact", plain, {});
  assert.match(plain.logs.join("\n"), /不支持手动压缩/);

  const failing = makeServices({ providerConfigs: [], models: [], thinkingLevels: [] });
  failing.agent = {
    ...makeAgent({ providerConfigs: [], models: [], thinkingLevels: [] }),
    async compact() {
      throw new Error("会话尚未建立（草稿态），没有可压缩的上下文");
    }
  } as AgentController;
  await executeCommand("/compact", failing, {});
  assert.match(failing.logs.join("\n"), /压缩失败：会话尚未建立/);
});

test("transient hints prefer the notify channel; list output stays in the transcript", async () => {
  const notes: Array<{ message: string; level?: "info" | "warning" | "error" }> = [];
  const services = Object.assign(makeServices({ providerConfigs: [], models: [], thinkingLevels: [] }), {
    notify: (message: string, level?: "info" | "warning" | "error") => {
      notes.push({ message, level });
    }
  });
  await executeCommand("/provider nobody", services, {});
  assert.deepEqual(services.logs, [], "failure hints do not write to the transcript");
  assert.equal(notes.length, 1);
  assert.match(notes[0].message, /provider 配置失败/);
  assert.equal(notes[0].level, "error");

  // 枚举类输出保留在 transcript（用户需要回看），不走 toast。
  await executeCommand("/provider", services, {});
  assert.match(services.logs.join("\n"), /providers：anthropic/);
  assert.ok(notes.every((note) => !note.message.includes("providers：")), "listing never becomes a toast");
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

test("/thinking validates against the current model and bare form lists or picks its levels", async () => {
  const recording = { providerConfigs: [] as Recording["providerConfigs"], models: [], thinkingLevels: [] };
  const services = makeServices(recording);
  await executeCommand("/thinking high", services, {});
  await executeCommand("/thinking xhigh", services, {});
  assert.match(services.logs.join("\n"), /thinking 切换失败：当前模型支持的 thinking level：/);
  assert.deepEqual(recording.thinkingLevels, ["high"]);

  await executeCommand("/thinking", services, {});
  assert.match(services.logs.join("\n"), /当前模型支持的 thinking level：off, minimal, low, medium, high/);

  const interactive = makeServices(recording, ["low"], true);
  await executeCommand("/thinking", interactive, {});
  assert.deepEqual(recording.thinkingLevels, ["high", "low"]);
});

test("bare /thinking without a model asks for /model first", async () => {
  const recording = { providerConfigs: [] as Recording["providerConfigs"], models: [], thinkingLevels: [] };
  const services = makeServices(recording);
  services.agent = {
    ...makeAgent(recording),
    thinkingLevels: () => [],
    async setThinkingLevel() {
      throw new Error("请先使用 /model 选择模型；thinking level 由当前模型决定");
    }
  };
  await executeCommand("/thinking", services, {});
  assert.match(services.logs.join("\n"), /请先用 \/model 选择模型/);
  await executeCommand("/thinking high", services, {});
  assert.match(services.logs.join("\n"), /thinking 切换失败：请先使用 \/model 选择模型/);
  assert.deepEqual(recording.thinkingLevels, []);
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

test("dispatchTask does not echo the input; echoing is the TUI bubble's job", async () => {
  const recording = { providerConfigs: [] as Recording["providerConfigs"], models: [], thinkingLevels: [] };
  const services = makeServices(recording);
  services.agents = noAgents;
  const timeline: string[] = [];
  services.log = (line) => timeline.push(line);
  services.agent = {
    ...makeAgent(recording),
    async runTask(goal: string) {
      timeline.push(`[runTask] ${goal}`);
      return "任务完成";
    }
  };
  await executeCommand("实现登录", services, {});
  assert.deepEqual(timeline, ["[runTask] 实现登录"], "no markdown echo — the TUI bubble owns it");
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
  assert.ok(!services.logs.join("\n").includes("实现登录"), "rejected dispatch leaves the goal out of the log entirely");
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
