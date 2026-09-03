import assert from "node:assert/strict";
import { test } from "node:test";
import { forwardAssistantEvent } from "../src/pi/assistant-stream.ts";
import { dim } from "../src/core/ansi.ts";

test("text deltas feed the answer buffer and the UI sink", () => {
  const buffered: string[] = [];
  const shown: string[] = [];
  forwardAssistantEvent(
    { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "你好" } } as never,
    { appendText: (delta) => buffered.push(delta), onText: (delta) => shown.push(delta) }
  );
  assert.deepEqual(buffered, ["你好"]);
  assert.deepEqual(shown, ["你好"]);
});

test("thinking deltas reach only the thinking sink and other events are ignored", () => {
  const buffered: string[] = [];
  const text: string[] = [];
  const thinking: string[] = [];
  const sinks = {
    appendText: (delta: string) => buffered.push(delta),
    onText: (delta: string) => text.push(delta),
    onThinking: (delta: string) => thinking.push(delta)
  };
  forwardAssistantEvent({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "推理…" } } as never, sinks);
  forwardAssistantEvent({ type: "agent_start" } as never, sinks);
  forwardAssistantEvent({ type: "message_update", assistantMessageEvent: { type: "thinking_end" } } as never, sinks);
  assert.deepEqual(thinking, ["推理…"]);
  assert.deepEqual(buffered, []);
  assert.deepEqual(text, []);
});

test("tool lifecycle events reach the tool sinks with ids, names, and args", () => {
  const starts: Array<[string, string, unknown]> = [];
  const ends: Array<[string, string, boolean]> = [];
  const sinks = {
    appendText: () => undefined,
    onToolStart: (id: string, name: string, args: unknown) => starts.push([id, name, args]),
    onToolEnd: (id: string, name: string, isError: boolean) => ends.push([id, name, isError])
  };
  forwardAssistantEvent(
    { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "npm test" } } as never,
    sinks
  );
  forwardAssistantEvent(
    { type: "tool_execution_update", toolCallId: "t1", toolName: "bash", args: {}, partialResult: "..." } as never,
    sinks
  );
  forwardAssistantEvent(
    { type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: "ok", isError: true } as never,
    sinks
  );
  assert.deepEqual(starts, [["t1", "bash", { command: "npm test" }]]);
  assert.deepEqual(ends, [["t1", "bash", true]]);
});

test("missing tool sinks are simply skipped", () => {
  forwardAssistantEvent(
    { type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: { path: "a.ts" } } as never,
    { appendText: () => undefined }
  );
  forwardAssistantEvent(
    { type: "tool_execution_end", toolCallId: "t1", toolName: "read", result: "", isError: false } as never,
    { appendText: () => undefined }
  );
});

test("dim wraps text in faint escapes", () => {
  assert.equal(dim("x"), "\x1b[2mx\x1b[22m");
});
