import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { renderSessionHistory } from "../src/core/session-history.ts";

const T0 = Date.parse("2025-01-01T00:00:00.000Z");

let nextId = 0;

/** Message entry with the given Pi message payload; parentId chains the path. */
function messageEntry(message: Record<string, unknown>, parentId: string | null = null): SessionEntry {
  nextId += 1;
  return { type: "message", id: `e${nextId}`, parentId, timestamp: new Date(T0).toISOString(), message } as unknown as SessionEntry;
}

/** Non-message entry (compaction, model_change, ...); parentId chains the path. */
function otherEntry(type: string, extra: Record<string, unknown> = {}, parentId: string | null = null): SessionEntry {
  nextId += 1;
  return { type, id: `e${nextId}`, parentId, timestamp: new Date(T0).toISOString(), ...extra } as unknown as SessionEntry;
}

function userEntry(content: unknown, parentId: string | null = null): SessionEntry {
  return messageEntry({ role: "user", content, timestamp: T0 }, parentId);
}

function assistantEntry(content: unknown, stopReason: string, parentId: string | null = null, extra: Record<string, unknown> = {}): SessionEntry {
  return messageEntry({ role: "assistant", content, stopReason, timestamp: T0, ...extra }, parentId);
}

test("user messages render under the 你 header, images become placeholders", () => {
  // 真实会话中 entry 以 parentId 链接；路径从最后一个 entry 向上回溯
  const first = userEntry("你好");
  const blocks = renderSessionHistory([
    first,
    userEntry(
      [
        { type: "image", data: "Zm9v", mimeType: "image/png" },
        { type: "text", text: "看这张图" }
      ],
      first.id
    )
  ]);
  assert.deepEqual(blocks, ["**▸ 你**\n\n你好", "**▸ 你**\n\n[图片]看这张图"]);
});

test("assistant renders only text parts, skipping thinking and toolCall", () => {
  const blocks = renderSessionHistory([
    assistantEntry(
      [
        { type: "thinking", thinking: "内部思考", thinkingSignature: "sig" },
        { type: "text", text: "这是答案" },
        { type: "toolCall", id: "t1", name: "read", arguments: { path: "a.ts" } }
      ],
      "toolUse"
    )
  ]);
  assert.deepEqual(blocks, ["**▸ 助手**\n\n这是答案"]);
});

test("assistant messages without text and without error are skipped", () => {
  const blocks = renderSessionHistory([
    assistantEntry([{ type: "toolCall", id: "t1", name: "bash", arguments: {} }], "toolUse")
  ]);
  assert.deepEqual(blocks, []);
});

test("aborted assistant messages get an interrupted marker, errors get a warning line", () => {
  const aborted = assistantEntry([{ type: "text", text: "写到一半" }], "aborted");
  const blocks = renderSessionHistory([
    aborted,
    assistantEntry([], "error", aborted.id, { errorMessage: "provider 炸了" })
  ]);
  assert.deepEqual(blocks, ["**▸ 助手**\n\n写到一半_（已中断）_", "**▸ 助手**\n\n⚠️ 助手返回错误：provider 炸了"]);
});

test("tool results fold into one line by isError, bash executions show the command", () => {
  const read = messageEntry({ role: "toolResult", toolCallId: "t1", toolName: "read", content: [], isError: false, timestamp: T0 });
  const bash = messageEntry({ role: "toolResult", toolCallId: "t2", toolName: "bash", content: [], isError: true, timestamp: T0 }, read.id);
  const blocks = renderSessionHistory([
    read,
    bash,
    messageEntry({ role: "bashExecution", command: "ls -la", output: "", exitCode: 0, cancelled: false, truncated: false, timestamp: T0 }, bash.id)
  ]);
  assert.deepEqual(blocks, ["> 🔧 read（成功）", "> 🔧 bash（失败）", "> ❕ 命令：`ls -la`"]);
});

test("custom messages render only when display is true", () => {
  const shown = messageEntry({ role: "custom", customType: "note", content: "提示内容", display: true, timestamp: T0 });
  const blocks = renderSessionHistory([
    shown,
    messageEntry({ role: "custom", customType: "note", content: "隐藏内容", display: false, timestamp: T0 }, shown.id)
  ]);
  assert.deepEqual(blocks, ["提示内容"]);
});

test("compaction and branch summaries render as notice lines, other entry types are skipped", () => {
  const first = userEntry("早期消息");
  const second = assistantEntry([{ type: "text", text: "早期回复" }], "stop", first.id);
  const compaction = otherEntry("compaction", { summary: "摘要", firstKeptEntryId: second.id, tokensBefore: 10 }, second.id);
  const latest = userEntry("新消息", compaction.id);
  // 路径从最后一个 entry 回溯，因此后续非消息类型也要链接在链上才能验证「跳过」
  const modelChange = otherEntry("model_change", { provider: "anthropic", modelId: "claude-sonnet-4-5" }, latest.id);
  const thinkingChange = otherEntry("thinking_level_change", { thinkingLevel: "high" }, modelChange.id);
  const label = otherEntry("label", { targetId: first.id, label: "标记" }, thinkingChange.id);
  const sessionInfo = otherEntry("session_info", { name: "会话名" }, label.id);
  const blocks = renderSessionHistory([
    first,
    second,
    compaction,
    latest,
    modelChange,
    thinkingChange,
    label,
    sessionInfo,
    otherEntry("custom", { customType: "state" }, sessionInfo.id)
  ]);
  assert.deepEqual(blocks, [
    "> 📦 此前历史已压缩为摘要",
    "**▸ 助手**\n\n早期回复",
    "**▸ 你**\n\n新消息"
  ]);
});

test("texts longer than maxMessageChars are truncated with a marker", () => {
  const blocks = renderSessionHistory([userEntry("0123456789")], { maxMessageChars: 4 });
  assert.deepEqual(blocks, ["**▸ 你**\n\n0123……（截断）"]);
});

test("more blocks than maxMessages keeps the latest and prepends an omission notice", () => {
  const first = userEntry("一");
  const second = userEntry("二", first.id);
  const third = userEntry("三", second.id);
  const blocks = renderSessionHistory([first, second, third], { maxMessages: 2 });
  assert.deepEqual(blocks, ["*……（已省略更早的 1 条）*", "**▸ 你**\n\n二", "**▸ 你**\n\n三"]);
});

test("empty input renders no blocks", () => {
  assert.deepEqual(renderSessionHistory([]), []);
});
