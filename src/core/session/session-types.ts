/** pi-swarm 视角的会话元数据（sessions 索引中的一条记录）。 */
export interface SessionRecord {
  /** 会话 id，与 Pi JSONL 会话文件的 sessionId 一致。 */
  id: string;
  /** 用户可读名（/new <name> 提供）；未命名时取首条消息摘要。 */
  name?: string;
  /** JSONL 会话文件绝对路径；in-memory 会话无文件。 */
  sessionFile?: string;
  /** ISO 8601。 */
  createdAt: string;
  /** 每次 prompt 触发 touch 更新。 */
  updatedAt: string;
  /** 存在即视为 closed（状态由此推导，避免双状态不一致）。 */
  closedAt?: string;
  messageCount: number;
  /** 建立会话时的模型 specifier（provider/model），仅展示用。 */
  model?: string;
  /** 创建时归属的作用域名；undefined = 主工作区。终身不变。 */
  worktree?: string;
}

export type SessionStatus = "active" | "closed";

export interface SessionSummary {
  id: string;
  name: string;
  status: SessionStatus;
  /** 是否为当前会话。 */
  current: boolean;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  model?: string;
  /** 归属作用域名；undefined = 主工作区。 */
  worktree?: string;
}

/** 会话错误基类：便于上层与测试区分。 */
export class SessionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** get/switch/close 的目标会话不存在（含 id 为空或纯空白）。 */
export class SessionNotFoundError extends SessionError {}

/** switch 到已关闭的会话。 */
export class SessionClosedError extends SessionError {}

/** 会话所属 worktree 目录丢失（被手动删除等）：bind 拒绝，不静默回退主工作区。 */
export class WorktreeScopeMissingError extends SessionError {}

/** prompt 流式输出进行中拒绝并发 prompt。 */
export class SessionBusyError extends SessionError {}

/** 状态由 closedAt 推导：closedAt 存在即 closed。 */
export function sessionStatus(record: SessionRecord): SessionStatus {
  return record.closedAt ? "closed" : "active";
}

/** 去除首尾空白；纯空白返回 undefined，用于把 name/id 归一化。 */
export function normalizeOptionalText(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  return trimmed ? trimmed : undefined;
}
