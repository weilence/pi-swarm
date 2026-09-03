import assert from "node:assert/strict";
import { test } from "node:test";
import { render } from "ink-testing-library";
import { createElement } from "react";
import { InkApp } from "../src/cli/ink-app.tsx";
import { LogStore } from "../src/cli/log-store.ts";
import type { AgentController } from "../src/cli/commands.ts";
import type { ModelsDevProvider } from "../src/models-dev/catalog.ts";
import type { TaskEnvelope, WorkerResult } from "../src/protocol/contracts.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const providers: ModelsDevProvider[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    npm: "@ai-sdk/anthropic",
    env: ["ANTHROPIC_API_KEY"],
    models: { "claude-sonnet-4": { id: "claude-sonnet-4", name: "Claude Sonnet 4", reasoning: true } }
  },
  { id: "openai", name: "OpenAI", npm: "@ai-sdk/openai", env: ["OPENAI_API_KEY"], models: { "gpt-4o": { id: "gpt-4o", name: "GPT-4o" } } }
];

interface Recording {
  providerConfigs: Array<{ providerId: string; api?: string }>;
  models: string[];
  thinkingLevels: string[];
}

function makeHarness() {
  const recording: Recording = { providerConfigs: [], models: [], thinkingLevels: [] };
  const agent: AgentController = {
    async configureProvider(providerId: string, config: { api?: string }) {
      recording.providerConfigs.push({ providerId, api: config.api });
      return `provider 已配置，接口：${config.api ?? "默认"}`;
    },
    async setModel(specifier: string) {
      recording.models.push(specifier);
      return `当前模型：${specifier}`;
    },
    async setThinkingLevel(level: string) {
      recording.thinkingLevels.push(level);
      return `当前 thinking level：${level}`;
    },
    status: () => "模型：未选择；thinking：off"
  };
  const harness = render(
    createElement(InkApp, {
      store: new LogStore(),
      agent,
      catalog: { load: async () => providers },
      supervisor: {
        async dispatch(tasks: TaskEnvelope[]): Promise<WorkerResult[]> {
          return tasks.map((task) => ({ taskId: task.taskId, module: task.module, status: "completed", changedFiles: [], tests: [], risks: [], messages: [] }));
        }
      },
      module: { id: "app", path: ".", contextFiles: [], allowedPaths: [], testCommand: "", contractCommand: "" } as never,
      onExit: () => harness?.unmount()
    })
  );
  return { harness, recording };
}

test("/thinking opens a popup, arrow keys move, Enter applies the level", async () => {
  const { harness, recording } = makeHarness();
  harness.stdin.write("/thinking");
  await sleep(60);
  harness.stdin.write("\r");
  await sleep(80);
  assert.ok(harness.lastFrame()?.includes("选择 thinking level"), "picker should render");
  assert.ok(harness.lastFrame()?.includes("❯ off"));

  harness.stdin.write("\u001B[B"); // down
  await sleep(60);
  assert.ok(harness.lastFrame()?.includes("❯ minimal"));

  harness.stdin.write("\r");
  await sleep(80);
  assert.deepEqual(recording.thinkingLevels, ["minimal"]);
  assert.ok(harness.lastFrame()?.includes("当前 thinking level：minimal"));
  harness.unmount();
});

test("picker filters as you type and cancels with Esc", async () => {
  const { harness, recording } = makeHarness();
  harness.stdin.write("/thinking");
  await sleep(60);
  harness.stdin.write("\r");
  await sleep(80);

  harness.stdin.write("xh");
  await sleep(60);
  const frame = harness.lastFrame() ?? "";
  assert.ok(frame.includes("xhigh"), "filter narrows to xhigh");
  assert.ok(!frame.includes("❯ off"), "filtered-out rows disappear");

  harness.stdin.write("\u001B"); // Esc
  await sleep(80);
  assert.deepEqual(recording.thinkingLevels, []);
  assert.ok(harness.lastFrame()?.includes("已取消 thinking 切换"));
  harness.unmount();
});

test("/provider chains provider → api → model pickers", async () => {
  const { harness, recording } = makeHarness();
  harness.stdin.write("/provider");
  await sleep(60);
  harness.stdin.write("\r");
  await sleep(100);
  assert.ok(harness.lastFrame()?.includes("选择 provider"));

  harness.stdin.write("openai");
  await sleep(60);
  assert.ok(harness.lastFrame()?.includes("❯ openai"));

  harness.stdin.write("\r");
  await sleep(100);
  assert.ok(harness.lastFrame()?.includes("选择接口类型"));

  harness.stdin.write("\r"); // 自动（根据 provider 推断）
  await sleep(100);
  assert.ok(harness.lastFrame()?.includes("选择模型"));

  harness.stdin.write("\r"); // gpt-4o
  await sleep(100);
  assert.equal(recording.providerConfigs.length, 1);
  assert.equal(recording.providerConfigs[0].providerId, "openai");
  assert.equal(recording.providerConfigs[0].api, "openai-responses");
  assert.deepEqual(recording.models, ["openai/gpt-4o"]);
  assert.ok(harness.lastFrame()?.includes("当前模型：openai/gpt-4o"));
  harness.unmount();
});

test("/status logs into the static history", async () => {
  const { harness } = makeHarness();
  harness.stdin.write("/status");
  await sleep(60);
  harness.stdin.write("\r");
  await sleep(80);
  assert.ok(harness.lastFrame()?.includes("[主 agent] supervisor：模型：未选择；thinking：off"));
  harness.unmount();
});
