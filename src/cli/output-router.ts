import { dim } from "../core/ansi.ts";
import type { EventEnvelope } from "../core/event-bus.ts";
import { summarizeToolArgs } from "../core/tool-summary.ts";
import type { Agent, AgentStatusSnapshot } from "../pi/agent.ts";
import { TOAST_ICONS, type ToastLevel } from "./components.ts";
import type { TuiRepl } from "./tui-repl.ts";

export interface OutputRouterOptions {
  /** 状态栏快照来源（聚焦会话的 context，草稿态降级到草稿 agent）；流式期间每秒推送。 */
  statusSnapshot?: () => AgentStatusSnapshot | undefined;
  /** 每次状态轮询的附加动作（刷新侧栏 busy/unread 标记）。 */
  onTick?: () => void;
}

/**
 * 输出路由器：agent 事件流、日志行与瞬态提示的唯一出口。REPL 未就绪时降级
 * 为裸 console（Null Object），就绪后统一切换到 TUI 通道。事件携带的
 * sessionId 原样透传给 TUI——ChatPanel 按会话归位缓冲：聚焦会话实时展示，
 * 后台会话写自己的缓冲并标未读（切回即补放）。本路由器不关心谁是焦点。
 * 同时托管状态栏快照的 1 秒轮询（仅在流式活动期间推送）。
 */
export class OutputRouter {
  private repl?: TuiRepl;
  private statusTimer?: ReturnType<typeof setInterval>;
  private readonly statusSnapshot?: () => AgentStatusSnapshot | undefined;
  private readonly onTick?: () => void;

  public constructor(options: OutputRouterOptions = {}) {
    this.statusSnapshot = options.statusSnapshot;
    this.onTick = options.onTick;
  }

  /** REPL 就绪后接入；此前的输出自动走 console 降级路径。 */
  public attachRepl(repl: TuiRepl): void {
    this.repl = repl;
  }

  /** 订阅一个 agent 的事件流并路由到当前输出通道（supervisor 与子 agent 同构）。 */
  public attachAgent(agent: Agent): void {
    agent.on((event) => {
      switch (event.type) {
        case "text":
          this.streamText(event.delta, event.agent, event.sessionId);
          break;
        case "thinking":
          this.streamThinking(event.delta, event.agent, event.sessionId);
          break;
        case "streamEnd":
          this.endStream(event.agent, event.sessionId);
          break;
        case "toolStart":
          this.toolStart(event.toolCallId, event.toolName, event.args, event.agent, event.sessionId);
          break;
        case "toolEnd":
          this.toolEnd(event.toolCallId, event.isError, event.agent, event.sessionId);
          break;
      }
    });
  }

  /** 日志行：进转录（REPL）或 stdout（降级）。 */
  public log(line: string, agent = "supervisor"): void {
    if (this.repl) this.repl.appendLine(line, agent);
    else console.log(line);
  }

  /** 瞬态提示（命令反馈、后台告警）：REPL 走 toast 栈；降级为带级别图标的 console 行。 */
  public notify(message: string, level: ToastLevel = "info"): void {
    if (this.repl) this.repl.notify(message, level);
    else console.log(level === "info" ? message : `${TOAST_ICONS[level]} ${message}`);
  }

  /** 任务生命周期事件（Supervisor 编排缝）→ transcript 行。 */
  public taskEvent(event: EventEnvelope): void {
    this.log(`[event] ${event.type} ${event.source}: ${event.summary}`);
  }

  /** 推送一次状态栏快照（/new /switch 等状态变更后由入口调用）。 */
  public refreshStatus(): void {
    const snapshot = this.statusSnapshot?.();
    if (snapshot) this.repl?.setStatus(snapshot);
  }

  /** 退出前切断轮询定时器。 */
  public dispose(): void {
    this.stopStatusPolling();
  }

  private streamText(delta: string, agent: string, sessionId?: string): void {
    if (this.repl) {
      this.repl.streamText(delta, agent, sessionId);
      this.startStatusPolling();
    } else process.stdout.write(delta);
  }

  private streamThinking(delta: string, agent: string, sessionId?: string): void {
    if (this.repl) {
      this.repl.streamThinking(delta, agent, sessionId);
      this.startStatusPolling();
    } else process.stdout.write(dim(delta));
  }

  private endStream(agent: string, sessionId?: string): void {
    this.repl?.endStream(agent, sessionId);
    // 每轮流结束都可能更新 token/上下文统计，并定格任务级平均速度。
    this.stopStatusPolling();
  }

  // Tool calls render as live lines in the transcript; without a REPL they log
  // start/end lines to stdout.
  private toolStart(toolCallId: string, toolName: string, args: unknown, agent: string, sessionId?: string): void {
    if (this.repl) {
      this.repl.toolStart(agent, toolCallId, toolName, args, sessionId);
      return;
    }
    const summary = summarizeToolArgs(args);
    this.log(`[${agent}] 🔧 ${toolName}${summary ? ` ${summary}` : ""} …`, agent);
  }

  private toolEnd(toolCallId: string, isError: boolean, agent: string, sessionId?: string): void {
    if (this.repl) {
      this.repl.toolEnd(agent, toolCallId, isError, sessionId);
      return;
    }
    this.log(`[${agent}] ${isError ? "✘" : "✔"} 工具调用结束`, agent);
  }

  private startStatusPolling(): void {
    if (this.statusTimer) return;
    // tick 里附带侧栏 busy/未读刷新；不放进 refreshStatus（入口的 refreshBars
    // 也调它，会形成 refreshBars → refreshStatus → onTick → refreshBars 死循环，
    // 微任务链把事件循环饿死：进程活着但不渲染不收键）。
    this.statusTimer = setInterval(() => {
      this.refreshStatus();
      this.onTick?.();
    }, 1000);
    this.statusTimer.unref?.();
  }

  private stopStatusPolling(): void {
    if (this.statusTimer) {
      clearInterval(this.statusTimer);
      this.statusTimer = undefined;
    }
    this.refreshStatus();
  }
}
