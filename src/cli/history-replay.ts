import { buildContextEntries, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { summarizeToolArgs } from "../core/tool-summary.ts";
import type { TuiRepl } from "./tui-repl.ts";

/** 历史回放的体积限制：防止长会话或超长消息刷屏。 */
export interface ReplayOptions {
  /** 最多回放的条数（保留最近的部分）；默认 100。 */
  maxMessages?: number;
  /** 单条消息文本的最大字符数，超出截断并追加省略标记；默认 2000。 */
  maxMessageChars?: number;
}

const DEFAULT_MAX_MESSAGES = 100;
const DEFAULT_MAX_MESSAGE_CHARS = 2000;

/**
 * 解析中间产物（模块私有）：一条待回放的展示单元。只在本文件内存在——
 * 解析循环边解析边把它渲染成与实时输出相同的 TUI 组件，不对外暴露。
 */
type ReplayItem =
  | { kind: "user"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "assistant"; text: string; aborted: boolean }
  | { kind: "assistantError"; message: string }
  | { kind: "tool"; toolName: string; summary: string; isError: boolean }
  | { kind: "note"; markdown: string };

/** 把一条消息的 content 归一为纯文本：string 原样；数组时拼接 text 块，图片以 [图片] 占位。 */
function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const block of content) {
    if (block?.type === "text") text += block.text;
    else if (block?.type === "image") text += "[图片]";
  }
  return text;
}

/** 超过上限的文本截断并追加省略标记。 */
function clampText(text: string, maxMessageChars: number): string {
  return text.length > maxMessageChars ? text.slice(0, maxMessageChars) + "……（截断）" : text;
}

/** 单个会话条目 → 回放单元；返回 undefined 表示该条目不回显。 */
function collectEntry(
  entry: SessionEntry,
  maxMessageChars: number,
  toolArgs: Map<string, unknown>
): ReplayItem | ReplayItem[] | undefined {
  if (entry.type === "compaction") return { kind: "note", markdown: "> 📦 此前历史已压缩为摘要" };
  if (entry.type === "branch_summary") return { kind: "note", markdown: "> 🌿 分支摘要" };
  if (entry.type !== "message") return undefined;
  const message = entry.message;
  // Pi 的会话解析不校验结构：旧版本/fork/手改文件可能出现缺 message 的畸形条目，
  // 跳过而不是让整次回放失败。
  if (!message) return undefined;
  switch (message.role) {
    case "user": {
      const text = clampText(messageText(message.content), maxMessageChars);
      return text ? { kind: "user", text } : undefined;
    }
    case "assistant": {
      if (message.stopReason === "error") {
        return { kind: "assistantError", message: message.errorMessage ?? "未知错误" };
      }
      if (!Array.isArray(message.content)) {
        const text = clampText(messageText(message.content), maxMessageChars);
        return text ? { kind: "assistant", text, aborted: message.stopReason === "aborted" } : undefined;
      }
      // Pi 的类型未覆盖全部存储变体（如 image）；按存储顺序拆分：连续 thinking 块
      // 合并为一条折叠思考，text 块作为正文，toolCall 块登记参数供 toolResult 回显摘要。
      const items: ReplayItem[] = [];
      let thinkingRun = "";
      const flushThinking = (): void => {
        const text = clampText(thinkingRun.trim(), maxMessageChars);
        if (text) items.push({ kind: "thinking", text });
        thinkingRun = "";
      };
      for (const raw of message.content as unknown[]) {
        const block = raw as { type?: string; thinking?: unknown; id?: unknown; arguments?: unknown } | undefined;
        if (block?.type === "thinking") {
          thinkingRun += typeof block.thinking === "string" ? block.thinking : "";
          continue;
        }
        if (block?.type === "toolCall") {
          toolArgs.set(String(block.id), block.arguments);
          continue;
        }
        if (block?.type === "text" || block?.type === "image") flushThinking();
      }
      const text = clampText(messageText(message.content), maxMessageChars);
      if (text) items.push({ kind: "assistant", text, aborted: message.stopReason === "aborted" });
      flushThinking();
      return items;
    }
    case "toolResult":
      return {
        kind: "tool",
        toolName: message.toolName,
        summary: summarizeToolArgs(toolArgs.get(message.toolCallId)),
        isError: message.isError === true
      };
    case "bashExecution":
      return { kind: "note", markdown: `> ❕ 命令：\`${message.command}\`` };
    case "custom":
      // 扩展注入的消息仅在 display === true 时按纯文本回显（同 user 的文本规则）
      return message.display === true
        ? { kind: "note", markdown: clampText(messageText(message.content), maxMessageChars) || "" }
        : undefined;
    default:
      return undefined;
  }
}

/**
 * 把会话历史回放进 TUI：直接驱动与实时输出相同的组件——用户消息为右对齐
 * 气泡、思考为可折叠条目、助手正文为无标题 markdown、工具调用为已完结的
 * ✔/✘ 行。返回渲染的条数（0 表示无可回显内容）。
 *
 * 先经 Pi 的 buildContextEntries 取 compaction-aware 的当前路径，再逐条目
 * 解析渲染；超过 maxMessages 只保留最近部分，并在最前插入省略提示。
 * 解析失败由调用方兜底（不抛错，不影响 /switch 的切换结果）。
 */
export function replayHistory(repl: TuiRepl, entries: SessionEntry[], options: ReplayOptions = {}): number {
  const maxMessages = options.maxMessages ?? DEFAULT_MAX_MESSAGES;
  const maxMessageChars = options.maxMessageChars ?? DEFAULT_MAX_MESSAGE_CHARS;
  const toolArgs = new Map<string, unknown>();
  const items: ReplayItem[] = [];
  for (const entry of buildContextEntries(entries)) {
    const collected = collectEntry(entry, maxMessageChars, toolArgs);
    if (collected === undefined) continue;
    for (const item of Array.isArray(collected) ? collected : [collected]) {
      if (!(item.kind === "note" && !item.markdown.trim())) items.push(item);
    }
  }
  if (items.length === 0) return 0;
  repl.appendLine(`[主 agent] 已回放 ${items.length} 条历史记录：`);
  if (items.length > maxMessages) {
    const omitted = items.length - maxMessages;
    repl.appendMarkdown(`*……（已省略更早的 ${omitted} 条）*`);
    items.splice(0, omitted);
  }
  for (const item of items) {
    switch (item.kind) {
      case "user":
        repl.appendUserMessage(item.text);
        break;
      case "thinking":
        repl.appendThinking(item.text);
        break;
      case "assistant":
        repl.appendMarkdown(item.aborted ? `${item.text}（已中断）` : item.text);
        break;
      case "assistantError":
        repl.appendMarkdown(`⚠️ 助手返回错误：${item.message}`);
        break;
      case "tool":
        repl.appendToolCall(item.toolName, item.summary, item.isError);
        break;
      case "note":
        repl.appendMarkdown(item.markdown);
        break;
    }
  }
  return items.length;
}
