import assert from "node:assert/strict";
import { test } from "node:test";
import { filterOptions, windowRange } from "../src/cli/picker-logic.ts";

const options = [
  { value: "anthropic", label: "anthropic", hint: "Claude (Anthropic)", keywords: "@anthropic-ai/sdk" },
  { value: "openai", label: "openai", hint: "OpenAI", keywords: "gpt" },
  { value: "openrouter", label: "openrouter", hint: "OpenRouter" }
];

test("filterOptions matches case-insensitively across label, hint, keywords, and value", () => {
  assert.deepEqual(filterOptions(options, "open").map((option) => option.value), ["openai", "openrouter"]);
  assert.deepEqual(filterOptions(options, "OPENAI"), [{ ...options[1] }]);
  assert.deepEqual(filterOptions(options, "claude").map((option) => option.value), ["anthropic"]);
  assert.deepEqual(filterOptions(options, "sdk").map((option) => option.value), ["anthropic"]);
});

test("filterOptions requires every whitespace-separated term to match", () => {
  assert.deepEqual(filterOptions(options, "open router").map((option) => option.value), ["openrouter"]);
  assert.deepEqual(filterOptions(options, "open nothing"), []);
});

test("filterOptions passes everything through on empty query", () => {
  assert.deepEqual(filterOptions(options, "   "), options);
});

test("windowRange keeps the selection visible and clamps to the list", () => {
  assert.deepEqual(windowRange(0, 20, 9), { start: 0, end: 9 });
  assert.deepEqual(windowRange(10, 20, 9), { start: 6, end: 15 });
  assert.deepEqual(windowRange(19, 20, 9), { start: 11, end: 20 });
  assert.deepEqual(windowRange(0, 3, 9), { start: 0, end: 3 });
  assert.deepEqual(windowRange(0, 0, 9), { start: 0, end: 0 });
});
