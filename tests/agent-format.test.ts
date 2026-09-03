import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAgentMarkdown, suggestAgentName } from "../src/core/agent-format.ts";

const VALID = `---
name: code-reviewer
description: 审查代码变更，输出分级评审意见
capabilities:
  - 识别逻辑缺陷
  - 输出结构化意见
tools: [read, bash]
model: anthropic/claude-sonnet-4-5
tags:
  - review
---

你是资深代码评审员。按严重程度分级输出意见。`;

test("parses a valid definition with block and inline lists", () => {
  const result = parseAgentMarkdown(VALID, "agents/code-reviewer.md");
  assert.deepEqual(result.errors, []);
  assert.equal(result.agent?.name, "code-reviewer");
  assert.equal(result.agent?.description, "审查代码变更，输出分级评审意见");
  assert.deepEqual(result.agent?.capabilities, ["识别逻辑缺陷", "输出结构化意见"]);
  assert.deepEqual(result.agent?.tools, ["read", "bash"]);
  assert.equal(result.agent?.model, "anthropic/claude-sonnet-4-5");
  assert.deepEqual(result.agent?.tags, ["review"]);
  assert.ok(result.agent?.systemPrompt.startsWith("你是资深代码评审员"));
});

test("missing frontmatter is an error, never a throw", () => {
  const result = parseAgentMarkdown("# 只是一个普通文档\n没有元信息。");
  assert.ok(result.errors.length > 0);
  assert.match(result.errors[0], /frontmatter/);
  assert.equal(result.agent, undefined);
});

test("missing required fields are reported as errors", () => {
  const result = parseAgentMarkdown("---\ndescription: 缺少 name 的定义\n---\n正文");
  assert.ok(result.errors.some((error) => error.includes("name")));
  assert.equal(result.agent, undefined);
});

test("invalid name slug is an error", () => {
  const result = parseAgentMarkdown("---\nname: Bad Name!\ndescription: 非法名称样例\n---\n正文");
  assert.ok(result.errors.some((error) => error.includes("name")));
});

test("unknown fields and empty body produce warnings but parse", () => {
  const result = parseAgentMarkdown("---\nname: helper\ndescription: 提供通用辅助能力\ncolor: red\n---\n");
  assert.equal(result.agent?.name, "helper");
  assert.ok(result.warnings.some((warning) => warning.includes("color")));
  assert.ok(result.warnings.some((warning) => warning.includes("system prompt")));
});

test("missing capabilities is a tolerated warning", () => {
  const result = parseAgentMarkdown("---\nname: helper\ndescription: 提供通用辅助能力\n---\n正文指令");
  assert.equal(result.agent?.name, "helper");
  assert.deepEqual(result.agent?.capabilities, []);
  assert.ok(result.warnings.some((warning) => warning.includes("capabilities")));
});

test("suggestAgentName derives a slug from the file name", () => {
  assert.equal(suggestAgentName("Code_Reviewer.md"), "code-reviewer");
  assert.equal(suggestAgentName("test writer.MD"), "test-writer");
});
