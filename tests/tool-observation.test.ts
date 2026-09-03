import assert from "node:assert/strict";
import { test } from "node:test";
import { ToolObservationCollector } from "../src/core/tool-observation.ts";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

function toolEnd(overrides: Partial<{ toolName: string; args: Record<string, unknown>; isError: boolean }> = {}): AgentSessionEvent {
  return {
    type: "tool_execution_end",
    toolCallId: "c1",
    toolName: overrides.toolName ?? "read",
    args: overrides.args ?? {},
    result: {},
    isError: overrides.isError ?? false
  } as unknown as AgentSessionEvent;
}

test("counts completed tool calls and ignores non-tool events", () => {
  const collector = new ToolObservationCollector();
  collector.handle({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hi" } } as unknown as AgentSessionEvent);
  collector.handle(toolEnd());
  collector.handle(toolEnd());
  assert.deepEqual(collector.observation, { toolCalls: 2, errors: [], changedFiles: [] });
});

test("edit and write calls contribute their path to changedFiles", () => {
  const collector = new ToolObservationCollector();
  collector.handle(toolEnd({ toolName: "edit", args: { path: "src/a.ts", edits: [] } }));
  collector.handle(toolEnd({ toolName: "write", args: { path: "src/b.ts", content: "x" } }));
  collector.handle(toolEnd({ toolName: "write", args: { path: "src/a.ts", content: "y" } }));
  collector.handle(toolEnd({ toolName: "bash", args: { command: "npm test" } }));
  const { changedFiles } = collector.observation;
  assert.equal(changedFiles.length, 2, "duplicates collapse and bash is ignored");
  assert.ok(changedFiles.includes("src/a.ts"));
  assert.ok(changedFiles.includes("src/b.ts"));
});

test("errored tool calls are recorded as problems", () => {
  const collector = new ToolObservationCollector();
  collector.handle(toolEnd({ toolName: "bash", isError: true }));
  collector.handle(toolEnd());
  const { errors, toolCalls } = collector.observation;
  assert.equal(toolCalls, 2);
  assert.deepEqual(errors, ["bash 执行失败"]);
});
