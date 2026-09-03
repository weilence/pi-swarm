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

test("dim wraps text in faint escapes", () => {
  assert.equal(dim("x"), "\x1b[2mx\x1b[22m");
});
