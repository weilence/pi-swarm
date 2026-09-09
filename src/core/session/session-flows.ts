import type { SessionManager as PiSessionManager } from "@earendil-works/pi-coding-agent";
import type { SessionRegistry } from "./session-registry.ts";
import type { WorktreeRegistry } from "../worktree/worktree-registry.ts";
import { SessionBusyError, SessionClosedError, SessionNotFoundError, WorktreeScopeMissingError } from "./session-types.ts";

/** 用例的用户提示级别（与 CLI 的 ToastLevel 结构兼容的子集）。 */
export type FlowHintLevel = "info" | "warning" | "error";

/**
 * 会话用例的展示端口：宿主（CLI / 未来的 headless 入口）注入实现。用例只
 * 表达"何时切换视口、何时提示"，不关心展示介质。
 */
export interface SessionFlowView {
  /** 切换成功后把转录视口挂到目标会话命名空间；返回该会话是否已有缓冲内容。 */
  showSession?(session: string): boolean;
  /** 进入草稿视图（挂载草稿命名空间并清空）。 */
  showDraft?(): void;
  /** 向指定会话命名空间追加 markdown 行（草稿占位说明等）。 */
  appendMarkdown?(markdown: string, session?: string): void;
  /** 向指定会话命名空间回显一条用户消息气泡（草稿物化承接首条消息时用）。 */
  appendUserMessage?(message: string, session?: string): void;
  /** 用户提示（toast 或日志，宿主决定）。 */
  hint(message: string, level?: FlowHintLevel): void;
  /** 缓冲为空（进程重启后首次切入）时的 JSONL 历史回放；缺省跳过。 */
  replay?(pi: PiSessionManager, session: string): void;
}

/** 会话用例端口：会话/作用域管理 + 执行池门面 + 展示。 */
export interface SessionFlowPorts {
  /** 会话管理；缺省时用例提示未配置并返回。 */
  sessions?: SessionRegistry;
  /** worktree 作用域注册表；缺省时 /worktree 不可用。 */
  worktrees?: WorktreeRegistry;
  /** 执行池门面：按会话粒度的 busy 查询 / context 创建 / 释放。 */
  agent?: {
    isBusy?(id: string): boolean;
    /** 取（首次则创建）会话的执行上下文；上下文带 runTask。 */
    ensure(id: string): Promise<{ runTask(goal: string): Promise<string> }>;
    dispose?(id: string): Promise<void>;
  };
  view: SessionFlowView;
}

export function sessionCommandError(error: unknown): string {
  if (error instanceof SessionBusyError) return error.message;
  if (error instanceof SessionClosedError) return error.message;
  if (error instanceof SessionNotFoundError) return error.message;
  if (error instanceof WorktreeScopeMissingError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

/** 无显式草稿名时，用首条消息摘要作为会话名（压平空白，截到 24 字）。 */
function goalSessionName(goal: string): string | undefined {
  const text = goal.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  const chars = Array.from(text);
  const clipped = chars.slice(0, 24).join("");
  return chars.length > 24 ? `${clipped}…` : clipped;
}

/**
 * 新建会话统一入口（/new 与会话栏「＋」共用）：只开草稿，不创建任何记录。
 * 草稿属于当前作用域（物化时盖章），重复点击幂等。并行语义下不再受任何
 * busy 限制——切到草稿只是换视图，后台会话照常跑。
 */
export async function openDraftSession(ports: SessionFlowPorts, name?: string): Promise<void> {
  const sessions = ports.sessions;
  if (!sessions) {
    ports.view.hint("会话管理未配置。", "warning");
    return;
  }
  sessions.startDraft(name);
  ports.view.showDraft?.();
  ports.view.hint(`已打开草稿${name ? `（名称：${name}）` : ""}；首次发送时在当前作用域创建，重复点击「新建」只是重新打开它。`);
}

/**
 * 切换会话核心（/switch 与会话栏点击共用）：纯视图操作，永不因 busy 失败。
 * 跨作用域点击 = 切作用域 + 切会话同一动作。切换后若目标会话的缓冲为空
 * （进程重启后首次切入），才回放 JSONL 历史——进程内切换靠缓冲补放。
 */
export async function switchToSessionId(ports: SessionFlowPorts, id: string): Promise<void> {
  const sessions = ports.sessions;
  if (!sessions) {
    ports.view.hint("会话管理未配置。", "warning");
    return;
  }
  const target = sessions.get(id);
  if (!target) {
    ports.view.hint(`找不到会话：${id.trim() || "(空)"}（可用 /sessions 查看）`, "warning");
    return;
  }
  const scopeChanged = (target.worktree ?? undefined) !== sessions.currentScope();
  if (!scopeChanged && sessions.current()?.id === target.id) {
    ports.view.hint(`已是当前会话：${target.name ?? target.id}`);
    return;
  }
  try {
    if (scopeChanged) sessions.switchWorktree(target.worktree);
    await sessions.switch(target.id);
    // transcript 属于会话内容：挂载目标会话的缓冲（后台期间的增量已在其中，
    // 切回即补放）；缓冲为空才回放 JSONL（进程重启后的首次切入）。
    const populated = ports.view.showSession?.(target.id) ?? true;
    ports.view.hint(
      `已切换会话：${target.name ?? target.id}${target.worktree ? `（⎇ ${target.worktree}）` : ""}`
    );
    if (!populated) {
      const pi = await sessions.bind(target.id);
      ports.view.replay?.(pi, target.id);
    }
  } catch (error) {
    ports.view.hint(`切换失败：${sessionCommandError(error)}`, "error");
  }
}

/**
 * 切换 worktree 作用域（/worktree 唯一入口）：解析/创建作用域 → 移动指针 →
 * 恢复现场（该作用域最近的活跃会话；没有则草稿）。与会话执行完全解耦：
 * 不 dispose context、不改会话记录、没有 busy 拒绝。
 * `.` 是主工作区保留引用；名称省略 = 随机新建。
 */
export async function switchWorktreeScope(ports: SessionFlowPorts, ref: string | undefined): Promise<void> {
  const sessions = ports.sessions;
  if (!sessions || !ports.worktrees) {
    ports.view.hint("worktree 未配置。", "warning");
    return;
  }
  const arg = ref?.trim();
  let scope: string | undefined;
  try {
    if (arg === ".") {
      scope = undefined;
      ports.view.hint("已切回主工作区。");
    } else {
      const info = await ports.worktrees.createOrResolve(arg || undefined);
      scope = info.name;
      ports.view.hint(info.created ? `已创建 worktree：⎇ ${info.name}（${info.path}）` : `切入已有 worktree：⎇ ${info.name}`);
    }
  } catch (error) {
    ports.view.hint(`worktree 切换失败：${sessionCommandError(error)}`, "error");
    return;
  }
  sessions.switchWorktree(scope);
  // 恢复现场：作用域内最近活跃的会话（list 已按 updatedAt 倒序）；没有则草稿。
  const candidates = (await sessions.list()).filter((session) => session.status === "active" && session.worktree === scope);
  if (candidates[0]) {
    await switchToSessionId(ports, candidates[0].id);
  } else {
    sessions.startDraft();
    ports.view.showDraft?.();
    // 第二参数是 session 而非 agent：缺省即当前（刚打开的）草稿命名空间；
    // 传 "supervisor" 会把占位说明写进幽灵标签页，聊天区域看不到。
    ports.view.appendMarkdown?.("*✎ 草稿：新会话将在此作用域创建*");
    ports.view.hint("当前作用域还没有会话：输入任务将在此创建。");
  }
}

/** /worktrees：列出已注册的 worktree 作用域与当前标记。 */
export async function listWorktrees(ports: SessionFlowPorts): Promise<void> {
  if (!ports.worktrees) {
    ports.view.hint("worktree 未配置。", "warning");
    return;
  }
  try {
    const infos = await ports.worktrees.list();
    const current = ports.sessions?.currentScope();
    if (infos.length === 0) {
      ports.view.hint("暂无 worktree；/worktree <名称> 创建并切入，/worktree 随机新建，/worktree . 回主工作区。");
      return;
    }
    ports.view.hint(`主工作区${current === undefined ? "（当前）" : ""}；共 ${infos.length} 个 worktree：`);
    for (const info of infos) {
      ports.view.hint(`  ⎇ ${info.name}${info.name === current ? "（当前）" : ""} — ${info.path}`);
    }
  } catch (error) {
    ports.view.hint(`worktree 列表失败：${sessionCommandError(error)}`, "error");
  }
}

/**
 * 删除会话核心（/delete 与会话栏右键菜单共用）：busy 的会话拒绝删除（先
 * 中止或等完成）；删除当前会话先释放其执行上下文（释放 JSONL 文件句柄，
 * Windows 上打开中的文件无法删除）再删；随后打开侧栏同位的会话，没有其他
 * 活跃会话时才转入草稿态。
 */
export async function deleteSessionById(ports: SessionFlowPorts, id: string): Promise<void> {
  const sessions = ports.sessions;
  if (!sessions) {
    ports.view.hint("会话管理未配置。", "warning");
    return;
  }
  const target = sessions.get(id);
  if (!target) {
    ports.view.hint(`找不到会话：${id.trim() || "(空)"}（可用 /sessions 查看）`, "warning");
    return;
  }
  if (ports.agent?.isBusy?.(target.id)) {
    ports.view.hint("会话正在输出，无法删除；可切过去双击 Esc 停止后再试。", "warning");
    return;
  }
  const wasCurrent = sessions.current()?.id === target.id;
  // 删除前先定位：按侧栏顺序（updatedAt 倒序，仅活跃会话）记下被删会话的位置，
  // 删除后由同位会话顶替打开，而不是落回草稿。
  const activeBefore = wasCurrent
    ? (await sessions.list()).filter((session) => session.status === "active")
    : [];
  const position = activeBefore.findIndex((session) => session.id === target.id);
  try {
    if (wasCurrent) await ports.agent?.dispose?.(target.id);
    const removed = await sessions.delete(target.id);
    ports.view.hint(`已删除会话：${removed.name ?? removed.id}`);
    if (wasCurrent) {
      // 同位会话顶替（列表后一位优先；被删的是末位则取前一位），走 /switch
      // 同一核心流程；没有其他活跃会话才转入草稿态，后续输入不丢。
      const successor = activeBefore[position + 1] ?? activeBefore[position - 1];
      if (successor) await switchToSessionId(ports, successor.id);
      if (!sessions.current()) {
        sessions.startDraft();
        ports.view.showDraft?.();
        ports.view.appendMarkdown?.("*✎ 草稿：新会话将在首次发送时创建*");
      }
    }
  } catch (error) {
    ports.view.hint(`删除失败：${sessionCommandError(error)}`, "error");
  }
}

/**
 * 关闭会话核心（/close）：busy 拒绝；关闭当前会话时释放其执行上下文
 * （JSONL 保留可复活，重新 /switch 时再建 context）。
 */
export async function closeSessionById(ports: SessionFlowPorts, id?: string): Promise<void> {
  const sessions = ports.sessions;
  if (!sessions) {
    ports.view.hint("会话管理未配置。", "warning");
    return;
  }
  const target = id ? sessions.get(id) : sessions.current();
  if (!target) {
    ports.view.hint(id ? `找不到会话：${id}（可用 /sessions 查看）` : "没有当前会话可关闭。", "warning");
    return;
  }
  if (ports.agent?.isBusy?.(target.id)) {
    ports.view.hint("会话正在输出，无法关闭；可切过去双击 Esc 停止后再试。", "warning");
    return;
  }
  const wasCurrent = sessions.current()?.id === target.id;
  try {
    const closed = await sessions.close(target.id);
    if (wasCurrent) await ports.agent?.dispose?.(target.id);
    ports.view.hint(
      `已关闭会话：${closed.name ?? closed.id}${wasCurrent ? "（原当前会话；输入任务将开启新草稿，或 /switch 切换）" : ""}`
    );
  } catch (error) {
    ports.view.hint(`关闭失败：${sessionCommandError(error)}`, "error");
  }
}

/**
 * 草稿物化后的视口跟随：会话指针已指向新 id，而转录视口还停在草稿命名空间
 * ——用户气泡回显进了草稿缓冲，流式输出则带新 id 写进不可见的后台缓冲，
 * 聊天区域会一直空白（切走再切回才补放）。这里把视口挂到新会话，并把首条
 * 消息气泡补进新命名空间；斜杠文本与 ChatPanel 的提交回显规则一致，不回显。
 */
function followMaterializedView(ports: SessionFlowPorts, sessionId: string, goal: string): void {
  ports.view.showSession?.(sessionId);
  if (!goal.startsWith("/")) ports.view.appendUserMessage?.(goal, sessionId);
}

/**
 * 任务派发核心（命令层与未来 headless 入口共用）：聚焦会话的 busy 守卫
 * （后台会话不受影响）、草稿物化（盖章当前作用域）、ensure 执行上下文、
 * runTask 执行与 touch 记账。
 */
export async function dispatchTask(ports: SessionFlowPorts, goal: string): Promise<void> {
  const sessions = ports.sessions;
  if (!ports.agent?.ensure) {
    ports.view.hint("任务执行未配置。", "warning");
    return;
  }
  if (!sessions) {
    ports.view.hint("会话管理未配置。", "warning");
    return;
  }
  // 只挡聚焦会话的并发输入：后台会话跑它的，这里照常受理新任务。
  const focused = sessions.current();
  if (focused && ports.agent.isBusy?.(focused.id)) {
    ports.view.hint("当前会话已有任务正在执行，请等待完成或双击 Esc 停止。", "warning");
    return;
  }
  // 当前会话不存在（草稿、已关闭或从未创建）时物化承接：草稿名优先，无则
  // 用首条消息摘要命名；物化即盖当前作用域章。
  let sessionId = focused?.id;
  let justMaterialized = false;
  if (!sessionId) {
    try {
      const record = await sessions.materialize(goalSessionName(goal));
      sessionId = record.id;
      justMaterialized = true;
    } catch (error) {
      ports.view.hint(`自动创建会话失败，任务将在无会话状态下执行：${sessionCommandError(error)}`, "error");
    }
  }
  if (!sessionId) return;
  try {
    const context = await ports.agent.ensure(sessionId);
    if (justMaterialized) followMaterializedView(ports, sessionId, goal);
    await context.runTask(goal);
  } catch (error) {
    if (justMaterialized) {
      // 刚物化的会话建 context 失败：关闭它，避免指针与实际会话脱节、touch 错误记账。
      await sessions.close(sessionId).catch(() => undefined);
    }
    ports.view.hint(`任务执行失败：${sessionCommandError(error)}`, "error");
  } finally {
    // 一轮任务 ≈ 一条用户消息 + 一条回复；touch 失败不影响任务结果
    await sessions.touch(sessionId, { messages: 2 }).catch(() => undefined);
  }
}
