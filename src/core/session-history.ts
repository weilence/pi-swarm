import { buildContextEntries, type SessionEntry } from "@earendil-works/pi-coding-agent";

/** 历史回显的体积限制：防止长会话或超长消息刷屏。 */
export interface SessionHistoryOptions {
  /** 最多保留的渲染块数（保留最近的部分）；默认 100。 */
  maxMessages?: number;
  /** 单条消息文本的最大字符数，超出截断并追加省略标记；默认 2000。 */
  maxMessageChars?: number;
}

const DEFAULT_MAX_MESSAGES = 100;
const DEFAULT_MAX_MESSAGE_CHARS = 2000;

/**
 * 把一条消息的 content 归一为纯文本：string 原样；数组时拼接 text 块，
 * 图片以 [图片] 占位；其余内容（thinking/toolCall 等）不参与。
 */
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

/** 单条用户消息 → markdown 块；实时回显与历史回放共用，保证两处格式一致。 */
export function renderUserMessage(text: string): string {
  return `**▸ 你**\n\n${text}`;
}

/** 单个会话条目 → markdown 块；返回 undefined 表示该条目不回显。 */
function renderEntry(entry: SessionEntry, maxMessageChars: number): string | undefined {
  if (entry.type === "compaction") return "> 📦 此前历史已压缩为摘要";
  if (entry.type === "branch_summary") return "> 🌿 分支摘要";
  if (entry.type !== "message") return undefined;
  const message = entry.message;
  // Pi 的会话解析不校验结构：旧版本/fork/手改文件可能出现缺 message 的畸形条目，
  // 跳过而不是让整次回放失败。
  if (!message) return undefined;
  switch (message.role) {
    case "user": {
      const text = clampText(messageText(message.content), maxMessageChars);
      return text ? renderUserMessage(text) : undefined;
    }
    case "assistant": {
      if (message.stopReason === "error") {
        return `**▸ 助手**\n\n⚠️ 助手返回错误：${message.errorMessage ?? "未知错误"}`;
      }
      const text = clampText(messageText(message.content), maxMessageChars);
      if (!text) return undefined;
      return `**▸ 助手**\n\n${message.stopReason === "aborted" ? `${text}_（已中断）_` : text}`;
    }
    case "toolResult":
      return `> 🔧 ${message.toolName}（${message.isError ? "失败" : "成功"}）`;
    case "bashExecution":
      return `> ❕ 命令：\`${message.command}\``;
    case "custom":
      // 扩展注入的消息仅在 display === true 时按纯文本回显（同 user 的文本规则）
      return message.display === true ? clampText(messageText(message.content), maxMessageChars) || undefined : undefined;
    default:
      return undefined;
  }
}

/**
 * 把会话条目渲染为 markdown 块数组（切换会话后的 TUI 历史回显用）。
 *
 * 先经 Pi 的 buildContextEntries 取 compaction-aware 的当前路径（被压缩的
 * 早期条目只保留压缩摘要行），再逐条目转为 markdown；渲染块数超过
 * maxMessages 时只保留最近部分，并在最前插入省略提示。无可回显内容时
 * 返回空数组。
 */
export function renderSessionHistory(entries: SessionEntry[], options: SessionHistoryOptions = {}): string[] {
  const maxMessages = options.maxMessages ?? DEFAULT_MAX_MESSAGES;
  const maxMessageChars = options.maxMessageChars ?? DEFAULT_MAX_MESSAGE_CHARS;
  const blocks: string[] = [];
  for (const entry of buildContextEntries(entries)) {
    const block = renderEntry(entry, maxMessageChars);
    if (block !== undefined) blocks.push(block);
  }
  if (blocks.length <= maxMessages) return blocks;
  return [`*……（已省略更早的 ${blocks.length - maxMessages} 条）*`, ...blocks.slice(-maxMessages)];
}
