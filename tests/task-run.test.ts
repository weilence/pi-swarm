import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BUDGET_LIMITS,
  createTaskRun,
  dependencyLayers,
  formatPriorSteps,
  isRetryableError,
  remainingSteps,
  StepTimeoutError,
  truncate,
  type StepRecord
} from "../src/core/task-run.ts";

test("dependencyLayers groups diamond dependencies into parallel batches", () => {
  const steps = [
    { id: "s1", agent: "a", goal: "a", dependsOn: [] },
    { id: "s2", agent: "b", goal: "b", dependsOn: ["s1"] },
    { id: "s3", agent: "c", goal: "c", dependsOn: ["s1"] },
    { id: "s4", agent: "d", goal: "d", dependsOn: ["s2", "s3"] }
  ];
  assert.deepEqual(
    dependencyLayers(steps).map((layer) => layer.map((step) => step.id)),
    [["s1"], ["s2", "s3"], ["s4"]]
  );
});

test("dependencyLayers degrades cycles and ignores unknown dependencies", () => {
  const cyclic = [
    { id: "s1", agent: "a", goal: "a", dependsOn: ["s2"] },
    { id: "s2", agent: "b", goal: "b", dependsOn: ["s1"] }
  ];
  assert.equal(dependencyLayers(cyclic).length, 1, "cycles run together in one batch");
  const unknown = [{ id: "s1", agent: "a", goal: "a", dependsOn: ["nope"] }];
  assert.deepEqual(
    dependencyLayers(unknown).map((layer) => layer.map((step) => step.id)),
    [["s1"]]
  );
});

test("createTaskRun starts with a fresh running budget", () => {
  const taskRun = createTaskRun("实现登录");
  assert.equal(taskRun.goal, "实现登录");
  assert.equal(taskRun.status, "running");
  assert.deepEqual(taskRun.steps, []);
  assert.deepEqual(taskRun.budget, { delegateCalls: 0, stepsUsed: 0 });
  assert.equal(remainingSteps(taskRun), BUDGET_LIMITS.maxSteps);
});

test("isRetryableError separates transient failures from semantic ones", () => {
  assert.equal(isRetryableError(new StepTimeoutError("timeout")), true);
  assert.equal(isRetryableError(new Error("fetch failed")), true);
  assert.equal(isRetryableError(new Error("ECONNRESET while streaming")), true);
  assert.equal(isRetryableError(new Error("HTTP 429 rate limit")), true);
  assert.equal(isRetryableError(new Error("步骤无法完成：缺少数据库凭据")), false);
  assert.equal(isRetryableError("plain string failure"), false);
});

test("truncate caps long text with an ellipsis marker", () => {
  assert.equal(truncate("short", 10), "short");
  assert.equal(truncate("x".repeat(31), 30), `${"x".repeat(30)}…（已截断）`);
});

test("formatPriorSteps renders status lines plus a truncated summary", () => {
  const records: StepRecord[] = [
    {
      id: "s1",
      agent: "code-writer",
      goal: "定义接口",
      status: "completed",
      summary: "新增了 login 接口",
      changedFiles: ["src/login.ts"],
      toolCalls: 4
    },
    {
      id: "s0",
      agent: "code-writer",
      goal: "失败步骤",
      status: "failed",
      summary: "",
      changedFiles: [],
      toolCalls: 1,
      error: "缺少数据库"
    }
  ];
  const rendered = formatPriorSteps(records);
  assert.match(rendered, /- s1（code-writer）completed：1 个文件变更/);
  assert.match(rendered, /摘要：新增了 login 接口/);
  assert.match(rendered, /- s0（code-writer）failed：0 个文件变更；错误：缺少数据库/);
  assert.doesNotMatch(rendered, /摘要：$/, "empty summaries omit the summary line");
});
