import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { StreamMetrics } from "../src/pi/stream-metrics.ts";

/** 构造 assistant 流式 usage 事件（message_update 携带累计输出 token）。 */
function update(output: number | undefined): AgentSessionEvent {
  return {
    type: "message_update",
    message: { role: "assistant", usage: output === undefined ? undefined : { output } }
  } as unknown as AgentSessionEvent;
}

function end(): AgentSessionEvent {
  return { type: "message_end", message: { role: "assistant" } } as unknown as AgentSessionEvent;
}

function agentEnd(): AgentSessionEvent {
  return { type: "agent_end" } as unknown as AgentSessionEvent;
}

test("before the first streamed output both metrics are undefined", () => {
  let now = 1_000;
  const metrics = new StreamMetrics(() => now);
  metrics.markPromptStart();
  // 首个 message_update 到达前（含无 usage 的事件——它同样算首字符），指标都是 undefined。
  assert.equal(metrics.ttftMs, undefined);
  assert.equal(metrics.speed(0), undefined);
  assert.equal(metrics.runningOutputTokens, 0);
});

test("ttft is measured from prompt dispatch to the first streamed output", () => {
  let now = 1_000;
  const metrics = new StreamMetrics(() => now);
  metrics.markPromptStart();
  now = 1_600;
  // 首字符到达：TTFT = 600ms；会话累计 30、本消息 running 0 → 基线 = 30。
  metrics.handle(update(0), 30);
  assert.equal(metrics.ttftMs, 600);
  assert.equal(metrics.runningOutputTokens, 0);
});

test("speed during generation counts only output after the window baseline", () => {
  let now = 1_600;
  const metrics = new StreamMetrics(() => now);
  metrics.markPromptStart(); // 派发于 1_600
  now = 1_700;
  metrics.handle(update(0), 30); // 首字符：基线 30
  now = 5_600;
  metrics.handle(update(50), 100); // running=50；会话累计 100
  // 活动窗口 1.7s → 5.6s = 3.9s；窗口内产出 = 100 + 50 - 30 = 120。
  assert.equal(metrics.speed(100), 120 / 3.9);
});

test("speed freezes at generation end and survives a new task's waiting time", () => {
  let now = 1_000;
  const metrics = new StreamMetrics(() => now);
  metrics.markPromptStart();
  now = 1_600;
  metrics.handle(update(0), 30); // TTFT=600，基线 30
  now = 5_600;
  metrics.handle(update(50), 100);
  now = 8_600;
  metrics.markPromptEnd(); // 窗口终点定格 8_600
  // 结束后：running 已并入会话统计（message_end 清零），窗口 = 1.6s → 8.6s = 7s。
  metrics.handle(end(), 100);
  assert.equal(metrics.ttftMs, 600);
  assert.equal(metrics.speed(100), 10); // (100 - 30) / 7s
  assert.equal(metrics.runningOutputTokens, 0);

  // 下一任务已派发（9_000）但首字符未到：沿用上一任务的定格指标，不随等待摊薄。
  now = 9_000;
  metrics.markPromptStart();
  assert.equal(metrics.speed(100), 10);
  assert.equal(metrics.ttftMs, 600);
});

test("a stale window refreshes ttft and reopens the speed window on the new first output", () => {
  let now = 1_000;
  const metrics = new StreamMetrics(() => now);
  metrics.markPromptStart();
  now = 1_600;
  metrics.handle(update(0), 30);
  now = 8_600;
  metrics.markPromptEnd();

  now = 9_000;
  metrics.markPromptStart(); // 新任务派发
  now = 9_500;
  // 新任务首字符：TTFT 刷新为 500ms，速度窗口重开（基线 = 此刻会话累计 100）。
  metrics.handle(update(0), 100);
  assert.equal(metrics.ttftMs, 500);
  now = 10_500;
  metrics.handle(update(20), 100);
  assert.equal(metrics.speed(100), 20); // (100 + 20 - 100) / 1s
});

test("agent_end clears running tokens as a fallback for aborted turns", () => {
  let now = 1_000;
  const metrics = new StreamMetrics(() => now);
  metrics.markPromptStart();
  now = 1_500;
  metrics.handle(update(40), 0);
  assert.equal(metrics.runningOutputTokens, 40);
  metrics.handle(agentEnd(), 0);
  assert.equal(metrics.runningOutputTokens, 0);
});

test("zero-length windows yield undefined speed instead of Infinity", () => {
  const metrics = new StreamMetrics(() => 1_000);
  metrics.markPromptStart();
  metrics.handle(update(0), 0); // 首字符与派发同一时刻
  assert.equal(metrics.speed(0), undefined);
});
