import assert from "node:assert/strict";
import { test } from "node:test";
import { MockPiWorker } from "../src/workers/mock-pi-worker.ts";

test("mock worker supports runtime provider/model/thinking configuration", async () => {
  const worker = new MockPiWorker();
  assert.match(
    await worker.configureProvider("anthropic", { api: "anthropic-messages" }),
    /provider 已配置（mock），接口：anthropic-messages/
  );
  assert.equal(await worker.setModel("anthropic/claude-sonnet-4"), "当前模型（mock）：anthropic/claude-sonnet-4");
  assert.equal(await worker.setThinkingLevel("xhigh"), "当前 thinking level（mock）：xhigh");
  assert.equal(worker.status(), "模型：anthropic/claude-sonnet-4；thinking：xhigh（mock worker）");
});

test("mock worker validates thinking levels like the Pi worker", async () => {
  const worker = new MockPiWorker();
  await assert.rejects(worker.setThinkingLevel("wild"), /thinking level 应为：/);
});

test("configureProvider with a model id preselects it", async () => {
  const worker = new MockPiWorker();
  await worker.configureProvider("openai", { api: "openai-completions" }, "gpt-4o");
  assert.match(worker.status(), /模型：openai\/gpt-4o/);
});
