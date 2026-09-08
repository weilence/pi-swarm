import assert from "node:assert/strict";
import { test } from "node:test";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { createRgBashToolOverride } from "../src/pi/agent.ts";

test("bash tool override rewrites the description to forbid grep and mandate rg", () => {
  const cwd = process.cwd();
  const builtin = createBashToolDefinition(cwd);
  const tool = createRgBashToolOverride(cwd);

  assert.equal(tool.name, "bash", "same-name custom tool overrides the builtin in createAgentSession");
  // 描述保留内置基础内容，追加强制搜索策略。
  assert.ok(tool.description.startsWith(builtin.description), "builtin description is kept as the prefix");
  assert.match(tool.description, /NEVER use grep, egrep, or fgrep/);
  assert.match(tool.description, /Use rg \(ripgrep\) for all text search/);
  assert.match(tool.description, /rg -n "pattern" path/);
  assert.match(tool.description, /rg --files/);
  // 系统提示 Guidelines 区追加同向硬性规则（保留内置 guideline）。
  assert.deepEqual(tool.promptGuidelines, [
    ...(builtin.promptGuidelines ?? []),
    "Never run grep, egrep, or fgrep in bash commands. Use rg (ripgrep) for every content search; use rg --files instead of find -name."
  ]);
  // 片段仍是 grep→rg 替换版。
  assert.equal(tool.promptSnippet, "Execute bash commands (ls, rg, find, etc.)");
  // schema 与执行逻辑不变。
  assert.equal(tool.parameters, builtin.parameters, "schema is the same object");
  assert.equal(String(tool.execute), String(builtin.execute), "builtin execute is preserved");
});
