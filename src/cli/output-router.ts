import { dim } from "../core/ansi.ts";
import type { EventEnvelope } from "../core/event-bus.ts";
import { summarizeToolArgs } from "../core/tool-summary.ts";
import type { Agent, AgentStatusSnapshot } from "../pi/agent.ts";
import { TOAST_ICONS, type ToastLevel } from "./components.ts";
import type { TuiRepl } from "./tui-repl.ts";

export interface OutputRouterOptions {
  /** 状态栏快照来源（supervisor agent）；流式期间每秒推送到 REPL。 */
  statusSnapshot?: () => AgentStatusSnapshot | undefined;
}

/**
 * 输出路由器：agent 事件流、日志行与瞬态提示的唯一出口。REPL 未就绪时降级
 * 为裸 console（Null Object），就绪后统一切换到 TUI 通道——入口里不再散落
 * 七八处 `if (repl)` 分支。同时托管状态栏快照的 1 秒轮询（仅在流式活动期间
 * 推送；任务级平均输出速度需要时间窗推进，其余统计保持最新）。
 */
export class OutputRouter {
  private repl?: TuiRepl;
  private statusTimer?: ReturnType<typeof setInterval>;
  private readonly statusSnapshot?: () => AgentStatusSnapshot | undefined;

  public constructor(options: OutputRouterOptions = {}) {
    this.statusSnapshot = options.statusSnapshot;
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
          this.streamText(event.delta, event.agent);
          break;
        case "thinking":
          this.streamThinking(event.delta, event.agent);
          break;
        case "streamEnd":
          this.endStream(event.agent);
          break;
        case "toolStart":
          this.toolStart(event.toolCallId, event.toolName, event.args, event.agent);
          break;
        case "toolEnd":
          this.toolEnd(event.toolCallId, event.toolName, event.isError, event.agent);
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

  private streamText(delta: string, agent: string): void {
    if (this.repl) {
      this.repl.streamText(delta, agent);
      this.startStatusPolling();
    } else process.stdout.write(delta);
  }

  private streamThinking(delta: string, agent: string): void {
    if (this.repl) {
      this.repl.streamThinking(delta, agent);
      this.startStatusPolling();
    } else process.stdout.write(dim(delta));
  }

  private endStream(agent: string): void {
    this.repl?.endStream(agent);
    // 每轮流结束都可能更新 token/上下文统计，并定格任务级平均速度。
    this.stopStatusPolling();
  }

  // Tool calls render as live lines in the transcript; without a REPL they log
  // start/end lines to stdout.
  private toolStart(toolCallId: string, toolName: string, args: unknown, agent: string): void {
    if (this.repl) {
      this.repl.toolStart(agent, toolCallId, toolName, args);
      return;
    }
    const summary = summarizeToolArgs(args);
    this.log(`[${agent}] 🔧 ${toolName}${summary ? ` ${summary}` : ""} …`, agent);
  }

  private toolEnd(toolCallId: string, _toolName: string, isError: boolean, agent: string): void {
    if (this.repl) {
      this.repl.toolEnd(agent, toolCallId, isError);
      return;
    }
    this.log(`[${agent}] ${isError ? "✘" : "✔"} 工具调用结束`, agent);
  }

  private startStatusPolling(): void {
    if (this.statusTimer) return;
    this.statusTimer = setInterval(() => this.refreshStatus(), 1000);
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
