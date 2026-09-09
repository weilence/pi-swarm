import type {
  AgentSession,
  AgentSessionEvent,
  ModelRuntime,
  SessionManager as PiSessionManager,
  ToolDefinition
} from "@earendil-works/pi-coding-agent";
import { createAgentSession, createBashToolDefinition, DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { forwardAssistantEvent } from "./assistant-stream.ts";
import type { StreamMetrics } from "./stream-metrics.ts";
import { ToolObservationCollector } from "../core/tool-observation.ts";

/** 已绑定 agent 名的流式汇；宿主按流式闸门决定是否转发（缓冲始终累积）。 */
export interface SessionSinks {
  onText: (delta: string) => void;
  onThinking: (delta: string) => void;
  onToolStart: (toolCallId: string, toolName: string, args: unknown) => void;
  onToolEnd: (toolCallId: string, toolName: string, isError: boolean) => void;
}

export interface SessionHostOptions {
  /** Working directory for the agent session. */
  cwd: string;
  /** Pi agent directory（每个 agent 独立，避免互相污染资源加载）。 */
  agentDir: string;
  /** Injected Pi session manager (persistent JSONL); in-memory fallback when omitted. */
  sessionManager?: PiSessionManager;
  /** Role prompt entries appended after the resource loader's base prompt. A function is rebuilt per session open. */
  systemPrompt?: string[] | (() => string[]);
  /** Tool allowlist; omitted means Pi's defaults. */
  tools?: string[];
  /** SDK custom tools（如 delegate 工具）；内置 bash 的 rg 替身由宿主统一注入。 */
  customTools?: () => ToolDefinition[];
  sinks: SessionSinks;
  metrics: StreamMetrics;
}

/**
 * 内置 bash 工具的替身：克隆 Pi 的定义，重写工具描述 —— 明确禁止 grep，
 * 要求一律用 rg（ripgrep）替代，并给出常用等价写法；另在系统提示
 * Guidelines 区追加一条同向的硬性规则强化约束。schema、执行逻辑与
 * 内置一致。同名 custom tool 在 createAgentSession 中按名字覆盖内置定义。
 */
export function createRgBashToolOverride(cwd: string): ToolDefinition {
  const base = createBashToolDefinition(cwd);
  return {
    ...base,
    description: `${base.description}

Search policy (mandatory): NEVER use grep, egrep, or fgrep. Use rg (ripgrep) for all text search:
- Content search: rg -n "pattern" path  (flags: -i ignore case, -g glob, -C context, -uuu include ignored files)
- List files: rg --files (pipe through a second rg to filter) instead of find -name
- Count matches: rg -c or rg --count-matches

grep is slower, ignores .gitignore, and noisier. Commands containing grep waste a turn — rewrite them with rg before submitting.`,
    promptGuidelines: [
      ...(base.promptGuidelines ?? []),
      "Never run grep, egrep, or fgrep in bash commands. Use rg (ripgrep) for every content search; use rg --files instead of find -name."
    ],
    promptSnippet: base.promptSnippet?.replace("grep", "rg")
  } as ToolDefinition;
}

/**
 * 单个 agent 的会话宿主：Pi AgentSession 的生命周期（打开/重绑/解绑/释放）、
 * 资源加载与工具装配、会话事件的扇出（指标观测器 → 观察采集器 → UI 流），
 * 以及流式闸门与回答缓冲。模型/thinking 的重新应用是门面的职责——宿主只管
 * 把会话建好、把事件分发出去。
 */
export class SessionHost {
  private readonly options: SessionHostOptions;
  private current?: AgentSession;
  private unsubscribe?: () => void;
  private piSession?: PiSessionManager;
  private responseBuffer = "";
  private streamToUi = true;
  private collector?: ToolObservationCollector;

  public constructor(options: SessionHostOptions) {
    this.options = options;
    // 注入的持久会话管理器是首个 open() 的默认绑定对象（旧 Agent 行为）。
    this.piSession = options.sessionManager;
  }

  /** 当前打开的会话；草稿态为 undefined。 */
  public get session(): AgentSession | undefined {
    return this.current;
  }

  /** 最近一次绑定的 Pi 会话管理器（持久 JSONL 或 inMemory）。 */
  public get sessionManager(): PiSessionManager | undefined {
    return this.piSession;
  }

  /** 当前任务的事件观察采集器；runStep 每次尝试换新的。 */
  public get observer(): ToolObservationCollector | undefined {
    return this.collector;
  }

  public setObserver(collector: ToolObservationCollector | undefined): void {
    this.collector = collector;
  }

  /** 流式闸门当前状态（sinks 是否转发实时流）。 */
  public get streaming(): boolean {
    return this.streamToUi;
  }

  public setStreaming(enabled: boolean): void {
    this.streamToUi = enabled;
  }

  /** 清空回答缓冲（每个 prompt 开始前调用）。 */
  public resetOutput(): void {
    this.responseBuffer = "";
  }

  /** 取走累计的回答文本（读后即清）。 */
  public takeOutput(): string {
    const text = this.responseBuffer;
    this.responseBuffer = "";
    return text;
  }

  /**
   * Releases the old AgentSession and binds the given Pi session as the
   * current one. Model/thinking re-application after the switch is the
   * facade's job — a failed re-application must not block the switch.
   */
  public async open(sessionManager: PiSessionManager, runtime: ModelRuntime): Promise<AgentSession> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.current?.dispose();
    this.current = undefined;
    const extras =
      typeof this.options.systemPrompt === "function" ? this.options.systemPrompt() : this.options.systemPrompt ?? [];
    const resourceLoader = new DefaultResourceLoader({
      cwd: this.options.cwd,
      agentDir: this.options.agentDir,
      appendSystemPromptOverride: (base) => [...base, ...extras]
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd: this.options.cwd,
      resourceLoader,
      sessionManager,
      modelRuntime: runtime,
      customTools: this.assembleTools(),
      ...(this.options.tools && this.options.tools.length > 0 ? { tools: this.options.tools } : {})
    });
    this.current = session;
    this.piSession = sessionManager;
    this.unsubscribe = session.subscribe((event) => this.dispatchEvent(event));
    return session;
  }

  /**
   * Draft-mode support: releases the bound session without opening a new one
   * (the next open builds a fresh one). Pending model/thinking preferences
   * live in the facade's settings and are untouched here.
   */
  public detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.current?.dispose();
    this.current = undefined;
    this.piSession = undefined;
  }

  /** 释放会话与缓冲；配置状态归 ModelSettings 管，这里只清理运行资源。 */
  public close(): void {
    this.detach();
    this.responseBuffer = "";
  }

  /** 事件扇出：指标观测 → 观察采集 → UI 流（受闸门控制；缓冲始终累积）。 */
  private dispatchEvent(event: AgentSessionEvent): void {
    this.options.metrics.handle(event, this.current?.getSessionStats().tokens.output ?? 0);
    this.collector?.handle(event);
    forwardAssistantEvent(event, {
      appendText: (delta) => {
        this.responseBuffer += delta;
      },
      onText: (delta) => {
        if (this.streamToUi) this.options.sinks.onText(delta);
      },
      onThinking: (delta) => {
        if (this.streamToUi) this.options.sinks.onThinking(delta);
      },
      onToolStart: (toolCallId, toolName, args) => {
        if (this.streamToUi) this.options.sinks.onToolStart(toolCallId, toolName, args);
      },
      onToolEnd: (toolCallId, toolName, isError) => {
        if (this.streamToUi) this.options.sinks.onToolEnd(toolCallId, toolName, isError);
      }
    });
  }

  /**
   * 工具装配：调用方的 custom tools（delegate 等）+ 内置 bash 的 rg 替身。
   * 替身不注入当调用方显式传入了同名 bash 工具（显式配置优先）；同名
   * custom tool 在 createAgentSession 中按名字覆盖内置定义。
   */
  private assembleTools(): ToolDefinition[] {
    const tools = [...(this.options.customTools?.() ?? [])];
    if (!tools.some((tool) => tool.name === "bash")) {
      tools.unshift(createRgBashToolOverride(this.options.cwd));
    }
    return tools;
  }
}
