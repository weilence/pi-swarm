import type { SessionManager as PiSessionManager } from "@earendil-works/pi-coding-agent";
import type { SessionRegistry } from "./session-registry.ts";
import { SessionBusyError, SessionClosedError, SessionNotFoundError } from "./session-types.ts";

/** 用例的用户提示级别（与 CLI 的 ToastLevel 结构兼容的子集）。 */
export type FlowHintLevel = "info" | "warning" | "error";

/**
 * 会话用例的展示端口：宿主（CLI / 未来的 headless 入口）注入实现。用例只
 * 表达"何时清屏、何时提示"，不关心展示介质。
 */
export interface SessionFlowView {
  /** 切换/新建/删除成功后整体替换转录内容。 */
  clearTranscript?(): void;
  /** 向转录追加 markdown 行（草稿占位说明等）。 */
  appendMarkdown?(markdown: string): void;
  /** 用户提示（toast 或日志，宿主决定）。 */
  hint(message: string, level?: FlowHintLevel): void;
  /** 切换成功后的历史回放（TUI 直驱，与实时显示同源）；缺省跳过。 */
  replay?(pi: PiSessionManager): void;
}

/** 会话用例端口：会话管理 + agent 的会话绑定面 + 展示。 */
export interface SessionFlowPorts {
  /** 会话管理；缺省时用例提示未配置并返回。 */
  sessions?: SessionRegistry;
  /** agent 的会话面：busy 守卫、草稿解绑、会话重绑、任务执行。 */
  agent?: {
    isBusy?(): boolean;
    detach?(): void;
    rebind?(sessionManager: PiSessionManager): Promise<string>;
    runTask?(goal: string): Promise<string>;
  };
  view: SessionFlowView;
}

export function sessionCommandError(error: unknown): string {
  if (error instanceof SessionBusyError) return error.message;
  if (error instanceof SessionClosedError) return error.message;
  if (error instanceof SessionNotFoundError) return error.message;
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
 * 清空 transcript、解绑 agent 会话；模型/thinking 等待生效配置保留在 agent
 * 上，首次发送任务时由 materialize 真正落盘。重复点击幂等。
 */
export async function openDraftSession(ports: SessionFlowPorts, name?: string): Promise<void> {
  const sessions = ports.sessions;
  if (!sessions) {
    ports.view.hint("会话管理未配置。", "warning");
    return;
  }
  if (ports.agent?.isBusy?.()) {
    ports.view.hint("会话正在输出，无法切换；请等待当前任务完成。", "warning");
    return;
  }
  try {
    ports.agent?.detach?.();
  } catch (error) {
    // detach 失败（理论上仅在 busy 并发时发生）：保持原状，不进入草稿。
    ports.view.hint(`无法进入草稿：${sessionCommandError(error)}`, "error");
    return;
  }
  sessions.startDraft(name);
  ports.view.clearTranscript?.();
  ports.view.appendMarkdown?.("*✎ 草稿：新会话将在首次发送时创建；可先 /model /thinking 配置*");
  ports.view.hint(`已打开草稿${name ? `（名称：${name}）` : ""}；首次发送时创建，重复点击「新建」只是重新打开它。`);
}

/**
 * 切换会话核心（/switch 与会话栏点击共用）：busy 时拒绝；点击当前会话短路为
 * 提示（避免无谓的 dispose/rebind 与历史重放）；否则先 bind（校验存在/未关闭
 * 并取得 Pi 实例），再移动指针，最后重绑 agent 并回放历史；失败时尽力把指针
 * 回滚到原会话，避免指针与实际会话脱节。
 */
export async function switchToSessionId(ports: SessionFlowPorts, id: string): Promise<void> {
  const sessions = ports.sessions;
  if (!sessions) {
    ports.view.hint("会话管理未配置。", "warning");
    return;
  }
  if (ports.agent?.isBusy?.()) {
    ports.view.hint("会话正在输出，无法切换；请等待当前任务完成。", "warning");
    return;
  }
  const target = sessions.get(id);
  if (!target) {
    ports.view.hint(`找不到会话：${id.trim() || "(空)"}（可用 /sessions 查看）`, "warning");
    return;
  }
  if (sessions.current()?.id === target.id) {
    ports.view.hint(`已是当前会话：${target.name ?? target.id}`);
    return;
  }
  const previous = sessions.current();
  try {
    const pi = await sessions.bind(target.id);
    await sessions.switch(target.id);
    const message =
      (await ports.agent?.rebind?.(pi)) ?? `已切换会话（agent 不支持运行时切换，仅更新指针）：${target.name ?? target.id}`;
    // transcript 属于会话内容，切换成功后必须整体替换而不是追加：否则旧会话
    // 的消息残留（切到空会话时回放 0 条，屏幕看起来纹丝不动，尤其明显）。
    // 放在 rebind 成功之后：rebind 失败会走 catch 回滚指针留在原会话，
    // 此时屏幕内容仍然有效，不应被清掉。
    ports.view.clearTranscript?.();
    ports.view.hint(message);
    ports.view.replay?.(pi);
  } catch (error) {
    const now = sessions.current();
    if (previous && now && now.id !== previous.id) await sessions.switch(previous.id).catch(() => undefined);
    ports.view.hint(`切换失败：${sessionCommandError(error)}`, "error");
  }
}

/**
 * 删除会话核心（/delete 与会话栏右键菜单共用）：删除当前会话时先解绑 agent
 * （释放 JSONL 文件句柄，Windows 上打开中的文件无法删除）再删；随后打开侧栏
 * 同位的会话（updatedAt 倒序：后一位顶替，被删的是末位则取前一位），没有其他
 * 活跃会话时才转入草稿态并清空 transcript；删除非当前会话不动指针。
 */
export async function deleteSessionById(ports: SessionFlowPorts, id: string): Promise<void> {
  const sessions = ports.sessions;
  if (!sessions) {
    ports.view.hint("会话管理未配置。", "warning");
    return;
  }
  if (ports.agent?.isBusy?.()) {
    ports.view.hint("会话正在输出，无法删除；请等待当前任务完成。", "warning");
    return;
  }
  const target = sessions.get(id);
  if (!target) {
    ports.view.hint(`找不到会话：${id.trim() || "(空)"}（可用 /sessions 查看）`, "warning");
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
    if (wasCurrent) ports.agent?.detach?.();
    const removed = await sessions.delete(target.id);
    ports.view.hint(`已删除会话：${removed.name ?? removed.id}`);
    if (wasCurrent) {
      // 同位会话顶替（列表后一位优先；被删的是末位则取前一位），走 /switch
      // 同一核心流程；没有其他活跃会话才转入草稿态，后续输入不丢。
      const successor = activeBefore[position + 1] ?? activeBefore[position - 1];
      if (successor) await switchToSessionId(ports, successor.id);
      if (!sessions.current()) {
        sessions.startDraft();
        ports.view.clearTranscript?.();
        ports.view.appendMarkdown?.("*✎ 草稿：新会话将在首次发送时创建*");
      }
    }
  } catch (error) {
    ports.view.hint(`删除失败：${sessionCommandError(error)}`, "error");
  }
}

/**
 * 任务派发核心（命令层与未来 headless 入口共用）：busy 守卫、草稿物化
 * （首条消息摘要命名）、agent 重绑、runTask 执行与 touch 记账。
 */
export async function dispatchTask(ports: SessionFlowPorts, goal: string): Promise<void> {
  const sessions = ports.sessions;
  const agent = ports.agent;
  if (!agent?.runTask) {
    ports.view.hint("任务执行未配置。", "warning");
    return;
  }
  if (agent.isBusy?.()) {
    ports.view.hint("已有任务正在执行，请等待完成后再输入。", "warning");
    return;
  }
  // 用户输入的回显由 TUI 气泡承担（TuiRepl.handleSubmit），此处不再回显；
  // 斜杠命令是 UI 操作且可能含密钥（/apikey），两种渠道都不回显。
  // 当前会话不存在（草稿、已关闭或从未创建）时物化承接：草稿名优先，无则
  // 用首条消息摘要命名，保证无缝体验。
  let sessionId = sessions?.current()?.id;
  if (!sessionId && sessions) {
    try {
      const record = await sessions.materialize(goalSessionName(goal));
      try {
        const pi = await sessions.bind(record.id);
        ports.view.hint((await agent.rebind?.(pi)) ?? `已创建会话：${record.name ?? record.id}`);
        sessionId = record.id;
      } catch (error) {
        // 刚物化的会话未被 agent 使用：关闭它，避免指针与实际会话脱节、touch 错误记账
        await sessions.close(record.id).catch(() => undefined);
        ports.view.hint(`自动创建会话失败：${sessionCommandError(error)}`, "error");
      }
    } catch (error) {
      ports.view.hint(`自动创建会话失败，任务将在无会话状态下执行：${sessionCommandError(error)}`, "error");
    }
  }
  try {
    await agent.runTask(goal);
  } catch (error) {
    ports.view.hint(`任务执行失败：${sessionCommandError(error)}`, "error");
  } finally {
    // 一轮任务 ≈ 一条用户消息 + 一条回复；touch 失败不影响任务结果
    if (sessionId && sessions) {
      await sessions.touch(sessionId, { messages: 2 }).catch(() => undefined);
    }
  }
}
