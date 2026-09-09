import { join } from "node:path";
import type { AgentDefinition } from "../core/agent-format.ts";
import type { AgentConfigSnapshot, ConfigStore } from "../core/config/config-store.ts";
import { SessionBusyError } from "../core/session/session-types.ts";
import { ToolObservationCollector, type ToolObservation } from "../core/tool-observation.ts";
import { getUserDataDir } from "../core/userdata.ts";
import {
  BUDGET_LIMITS,
  createTaskRun,
  describeError,
  isRetryableError,
  StepTimeoutError,
  type StepRecord
} from "../core/task-run.ts";
import type { StepJob } from "../core/supervisor.ts";
import { createDelegateTool, type DelegateState } from "./delegate-tool.ts";
import { getSupportedThinkingLevels, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  ModelRuntime,
  SessionManager as PiSessionManager,
  type ToolDefinition
} from "@earendil-works/pi-coding-agent";
import { SessionHost } from "./session-host.ts";
import { AgentEventEmitter, type AgentListener } from "./agent-events.ts";
import { StreamMetrics } from "./stream-metrics.ts";
import { maskKey, ModelSettings, type ProviderConfig } from "./model-settings.ts";

/**
 * Structured status snapshot for the editor status bar (see StatusBar):
 * best-effort — fields are absent when unknown, and the session may not
 * exist yet (draft mode), in which case only pending preferences show.
 */
export interface AgentStatusSnapshot {
  /** provider/model of the live (or requested) model. */
  model?: string;
  thinkingLevel?: string;
  /** Current context estimate and the model's context window (tokens). */
  contextTokens?: number;
  contextWindow?: number;
  contextPercent?: number;
  /** Cumulative session token accounting (input excludes cached reads/writes). */
  inputTokens?: number;
  outputTokens?: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** Cumulative session cost in USD. */
  cost?: number;
  /** 首字符响应时间（毫秒）：prompt 派发 → 首个流式输出；定格保留到下一任务首字符到达。 */
  ttftMs?: number;
  /** 任务级平均输出速度（tok/s）：首字符 → 结束（输出中为当前时刻）；结束后定格保留。 */
  avgOutputSpeed?: number;
  /** True while a prompt is streaming. */
  busy?: boolean;
}

/**
 * Stream sinks 每个 agent 的会话事件都通过 {@link Agent.on} 以 AgentEvent
 * 形式发出（文本/思考流、工具生命周期、流结束）——消费者订阅事件而不是
 * 穿透构造选项传回调。
 */

/**
 * Everything that distinguishes one agent from another is configuration: the
 * role lives in `systemPrompt`, capabilities arrive as optional groups
 * (delegate wiring, config persistence, tool allowlist, pulled model/thinking
 * defaults). There is no supervisor/sub-agent subclass split — see
 * agent-factory.ts for the single createAgent entry.
 */
export interface AgentOptions {
  /** UI 标签，也是事件流里携带的 agent 标注。 */
  name: string;
  /** Shared Pi runtime; created lazily when omitted. */
  modelRuntime?: ModelRuntime;
  /** Working directory for the agent session; defaults to the project root. */
  cwd?: string;
  /** Pi agent directory; defaults to a per-agent folder under the user data dir. */
  agentDir?: string;
  /** Role prompt: entries appended after the resource loader's base prompt. A function is rebuilt per session open. */
  systemPrompt?: string[] | (() => string[]);
  /** Tool allowlist (an agent's frontmatter tools); omitted means Pi's defaults. */
  tools?: string[];
  /** SDK custom tools beyond the delegate tool. */
  customTools?: ToolDefinition[];
  /** Injected Pi session manager (persistent, rebindable); defaults to in-memory. */
  sessionManager?: PiSessionManager;
  /** Config persistence capability; without it the config API keeps in-memory state only. */
  configStore?: ConfigStore;
  /** Pulled once per session creation when no explicit model was set (agents follow the global default). */
  resolveModel?: () => string | undefined;
  /** Pulled once per session creation when no explicit thinking level was set (agents follow the supervisor). */
  resolveThinkingLevel?: () => ModelThinkingLevel | undefined;
  /** Delegate capability: attaches the delegate tool and gives runTask its task budget. */
  delegate?: {
    agents: { list(): AgentDefinition[] };
    stepExecutor: { run(job: StepJob): Promise<StepRecord> };
    log?: (line: string) => void;
  };
  /** Per-attempt wall-clock limit for runStep; the session is aborted when it fires. */
  timeoutMs?: number;
  /** Wall clock for status metrics (TTFT, average output speed); defaults to Date.now. */
  now?: () => number;
}

/**
 * The one model-backed agent — a thin facade over three cohesive parts:
 * - SessionHost：会话生命周期、工具装配、事件扇出、流式闸门与回答缓冲；
 * - ModelSettings：provider/model/thinking/容量偏好与持久化；
 * - StreamMetrics：TTFT 与任务级平均速度观测。
 * The facade itself owns the execution semantics（prompt 循环、runStep 重试、
 * runTask 预算换装、abort/busy 并发守卫）和面向 UI 的状态快照组装。
 */
export class Agent {
  private readonly events = new AgentEventEmitter();
  private readonly host: SessionHost;
  private readonly metrics: StreamMetrics;
  private readonly settings: ModelSettings;
  private modelRuntime?: ModelRuntime;
  /** Set while a prompt is streaming; rebind() rejects concurrent switches. */
  private prompting = false;
  /** 用户主动请求停止（双击 Esc）：把中止当正常结束而非错误。 */
  private abortRequested = false;
  /** Holder the delegate tool reads; swapped per task in runTask(). */
  private readonly delegateState: DelegateState = {};
  private readonly cwd: string;

  public constructor(private readonly options: AgentOptions) {
    this.cwd = options.cwd ?? process.cwd();
    const agentDir = options.agentDir ?? join(getUserDataDir(), "agents", options.name);
    this.metrics = new StreamMetrics(options.now ?? Date.now);
    this.settings = new ModelSettings(options.configStore);
    this.host = new SessionHost({
      cwd: this.cwd,
      agentDir,
      systemPrompt: options.systemPrompt,
      tools: options.tools,
      customTools: () => this.customTools(),
      sinks: {
        onText: (delta) => this.events.emit({ type: "text", agent: options.name, delta }),
        onThinking: (delta) => this.events.emit({ type: "thinking", agent: options.name, delta }),
        onToolStart: (toolCallId, toolName, args) =>
          this.events.emit({ type: "toolStart", agent: options.name, toolCallId, toolName, args }),
        onToolEnd: (toolCallId, toolName, isError) =>
          this.events.emit({ type: "toolEnd", agent: options.name, toolCallId, toolName, isError })
      },
      metrics: this.metrics
    });
  }

  /** 订阅该 agent 的会话事件流（文本/思考、工具生命周期、流结束）；返回退订函数。 */
  public on(listener: AgentListener): () => void {
    return this.events.on(listener);
  }

  /** Current global default model (provider/model) as configured via /model. */
  public get currentModel(): string | undefined {
    return this.settings.model;
  }

  /** Effective thinking level: the session's live value, else the pending preference. */
  public get currentThinkingLevel(): ModelThinkingLevel | undefined {
    return this.host.session?.thinkingLevel ?? this.settings.thinkingLevel;
  }

  /**
   * Structured snapshot for the editor status bar: live session stats
   * (context usage, cumulative token accounting, cost) plus the pending
   * model preference when no session exists yet. Best-effort by design.
   */
  public get statusSnapshot(): AgentStatusSnapshot {
    const session = this.host.session;
    const model = session?.model;
    if (!session || !model) return { model: this.settings.model, busy: this.prompting };
    const stats = session.getSessionStats();
    const usage = stats.contextUsage;
    return {
      model: `${model.provider}/${model.id}`,
      thinkingLevel: session.thinkingLevel,
      contextTokens: usage?.tokens ?? undefined,
      contextWindow: usage?.contextWindow,
      contextPercent: usage?.percent ?? undefined,
      inputTokens: stats.tokens.input,
      outputTokens: stats.tokens.output + this.metrics.runningOutputTokens,
      cacheRead: stats.tokens.cacheRead,
      cacheWrite: stats.tokens.cacheWrite,
      cost: stats.cost,
      ttftMs: this.metrics.ttftMs,
      avgOutputSpeed: this.metrics.speed(stats.tokens.output),
      busy: this.prompting
    };
  }

  /** Applies a previously persisted snapshot; returns a human-readable summary. */
  public async restore(): Promise<string> {
    if (!this.options.configStore) return "未启用配置持久化";
    let saved: AgentConfigSnapshot;
    try {
      saved = await this.options.configStore.load();
    } catch (error) {
      return `配置读取失败，使用默认配置：${error instanceof Error ? error.message : String(error)}`;
    }
    this.settings.adopt(saved);
    const parts: string[] = [];
    try {
      if (saved.providerId && saved.providerConfig) {
        const config = saved.apiKey ? { ...saved.providerConfig, apiKey: saved.apiKey } : saved.providerConfig;
        await this.configureProvider(saved.providerId, config);
        parts.push(`provider ${saved.providerId}`);
        if (saved.apiKey) parts.push(`API key ${maskKey(saved.apiKey)}`);
      }
      if (saved.model) {
        if (saved.model.startsWith(`${saved.providerId}/`)) {
          await this.setModel(saved.model);
          parts.push(`模型 ${saved.model}`);
        } else {
          parts.push(`模型 ${saved.model}（与 provider 不匹配，已忽略）`);
        }
      }
      if (saved.thinkingLevel) {
        // Pending preference: validated and clamped against the model once the session opens.
        this.settings.setThinkingLevel(saved.thinkingLevel as ModelThinkingLevel);
        parts.push(`thinking ${saved.thinkingLevel}`);
      }
      if (saved.contextWindow && saved.contextWindow > 0) {
        this.settings.setContextWindow(saved.contextWindow);
        parts.push(`上下文容量 ${saved.contextWindow}`);
      }
    } catch (error) {
      parts.push(`部分配置恢复失败：${error instanceof Error ? error.message : String(error)}`);
    }
    return parts.length > 0 ? `已恢复配置：${parts.join("，")}` : "无已保存的配置";
  }

  private async ensureSession(): Promise<AgentSession> {
    const existing = this.host.session;
    if (existing) return existing;
    this.modelRuntime ??= await ModelRuntime.create({ refreshOnCreate: false });
    const config = this.settings.providerConfig;
    if (config) this.modelRuntime.registerProvider(this.settings.providerId, config);
    return await this.openSession(this.host.sessionManager ?? PiSessionManager.inMemory(this.cwd));
  }

  /**
   * Opens a session on the host, then re-applies model/thinking afterwards
   * (a failed model re-application does not block the switch — it stays
   * pending, or Pi falls back to its default selection).
   */
  private async openSession(sessionManager: PiSessionManager): Promise<AgentSession> {
    const session = await this.host.open(sessionManager, this.modelRuntime!);
    try {
      const model = this.settings.model ?? this.options.resolveModel?.();
      if (model) await this.applyModel(model);
    } catch {
      // The model may be unavailable after a provider switch: keep it pending
      // (configured model) or fall back to Pi's default selection (pulled model).
    }
    this.applyThinkingDefaults();
    return session;
  }

  /**
   * Switches sessions: rebinds the AgentSession to the given Pi session.
   * Throws SessionBusyError while a prompt is streaming (concurrency guard);
   * returns a human-readable confirmation on success.
   */
  public async rebind(sessionManager: PiSessionManager): Promise<string> {
    if (this.prompting) throw new SessionBusyError("会话正在输出，无法切换；请等待当前任务完成");
    await this.openSession(sessionManager);
    const name = sessionManager.getSessionName();
    return `已切换会话：${name ?? sessionManager.getSessionId()}`;
  }

  /**
   * Draft-mode support: releases the bound session without opening a new one
   * (the next ensureSession/rebind builds a fresh one). Pending model/thinking
   * preferences survive — they are exactly the draft's configurable settings.
   */
  public detach(): void {
    if (this.prompting) throw new SessionBusyError("会话正在输出，无法切换；请等待当前任务完成");
    this.host.detach();
  }

  /** Whether a prompt is currently streaming (session switches are rejected). */
  public isBusy(): boolean {
    return this.prompting;
  }

  /**
   * 用户主动中止当前输出（双击 Esc）：中止当次 prompt，已流式输出的部分文本
   * 保留在会话与 UI 中；结束后 runTask 正常返回（不报错）。
   */
  public async abort(): Promise<void> {
    if (!this.prompting || !this.host.session) return;
    this.abortRequested = true;
    await this.host.session.abort().catch(() => undefined);
  }

  /**
   * Runs one model turn and returns the full assistant text. Intermediate
   * turns (analysis, planning) stay quiet; set stream to show the reply live.
   * With a timeoutMs the turn races the wall clock: a timeout aborts the
   * session and waits for the aborted turn to settle (the session stays
   * usable afterwards) before the error propagates.
   */
  private async promptModel(prompt: string, options: { stream?: boolean; timeoutMs?: number } = {}): Promise<string> {
    const session = await this.ensureSession();
    const previous = this.host.streaming;
    this.host.setStreaming(options.stream === true);
    this.host.resetOutput();
    this.prompting = true;
    // 新任务只刷新派发时刻；上一任务的指标保持定格展示，等本轮首字符到
    // 达才刷新（StreamMetrics 以 firstOutputAt < promptStartedAt 识别旧窗口）。
    this.metrics.markPromptStart();
    const run = session.prompt(prompt);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = options.timeoutMs
      ? new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new StepTimeoutError(`步骤超时（${Math.round(options.timeoutMs! / 60000)} 分钟），已中断`)),
            options.timeoutMs
          );
        })
      : undefined;
    try {
      await (timeout ? Promise.race([run, timeout]) : run);
      return this.host.takeOutput().trim();
    } catch (error) {
      if (this.abortRequested) {
        // 用户主动停止：不算错误，返回已生成的部分文本。
        this.abortRequested = false;
        return this.host.takeOutput().trim();
      }
      if (error instanceof StepTimeoutError) {
        await session.abort().catch(() => undefined);
        await run.catch(() => undefined);
      }
      throw error;
    } finally {
      clearTimeout(timer);
      this.prompting = false;
      // 定格窗口终点：最终平均速度随流结束后的最后一次快照推送展示。
      this.metrics.markPromptEnd();
      this.abortRequested = false;
      this.host.setStreaming(previous);
      this.events.emit({ type: "streamEnd", agent: this.options.name });
    }
  }

  /**
   * Runs one delegate step through this agent's session: transient failures
   * (network, timeout) are retried once in the same session with failure
   * feedback; semantic failures come back as a failed record. The record is
   * built from real observation — tool events for files/errors, the session's
   * final assistant text as the narrative summary.
   */
  public async runStep(step: { id: string; goal: string }): Promise<StepRecord> {
    const timeoutMs = this.options.timeoutMs ?? BUDGET_LIMITS.stepTimeoutMs;
    let lastError: unknown;
    for (let attempt = 0; ; attempt += 1) {
      try {
        const prompt = attempt === 0
          ? `Step ${step.id}: ${step.goal}\nWhen done, summarize what you changed, tests, and risks.`
          : `Step ${step.id}（重试）：${step.goal}\n\n上一次尝试未完成：${describeError(lastError)}\n请修正问题并完成该步骤，完成后总结改动、测试与风险。`;
        this.host.setObserver(new ToolObservationCollector());
        await this.promptModel(prompt, { stream: true, timeoutMs });
        return this.completeRecord(step);
      } catch (error) {
        lastError = error;
        if (attempt >= BUDGET_LIMITS.maxRetries || !isRetryableError(error)) break;
      }
    }
    const timedOut = lastError instanceof StepTimeoutError;
    return {
      ...this.completeRecord(step),
      status: timedOut ? "timeout" : "failed",
      error: describeError(lastError)
    };
  }

  /** Builds a record from the session's current observation and final text. */
  private completeRecord(step: { id: string; goal: string }): StepRecord {
    const observation: ToolObservation =
      this.host.observer?.observation ?? { toolCalls: 0, errors: [], changedFiles: [] };
    return {
      id: step.id,
      agent: this.options.name,
      goal: step.goal,
      status: "completed",
      summary: this.host.session?.getLastAssistantText() ?? "",
      changedFiles: observation.changedFiles,
      toolCalls: observation.toolCalls,
      error: observation.errors.length > 0 ? observation.errors.join("；") : undefined
    };
  }

  /**
   * Runs one user task through the session: the model owns the control flow
   * (plan, delegate via the delegate tool, react to real step results,
   * summarize); this method only swaps in a fresh TaskRun for the delegate
   * tool's budget and record-keeping. Returns the final text.
   */
  public async runTask(goal: string): Promise<string> {
    this.delegateState.taskRun = createTaskRun(goal);
    try {
      return await this.promptModel(goal, { stream: true });
    } finally {
      this.delegateState.taskRun = undefined;
    }
  }

  /** SDK custom tools: the delegate tool when the delegate capability is wired and agents exist. */
  private customTools(): ToolDefinition[] {
    const tools = [...(this.options.customTools ?? [])];
    if (this.delegateAvailable()) tools.push(createDelegateTool(this.delegateServices(), this.delegateState));
    return tools;
  }

  private delegateAvailable(): boolean {
    return (this.options.delegate?.agents.list().length ?? 0) > 0 && Boolean(this.options.delegate?.stepExecutor);
  }

  private delegateServices() {
    const delegate = this.options.delegate!;
    return {
      agents: delegate.agents,
      runStep: (job: StepJob) => delegate.stepExecutor.run(job),
      log: (line: string) => delegate.log?.(line)
    };
  }

  public async configureProvider(providerId: string, config: unknown, modelId?: string): Promise<string> {
    const typed = config as ProviderConfig;
    this.settings.setProvider(providerId, typed);
    // Switching providers invalidates a model selected for the previous one.
    this.settings.invalidateForeignModel(providerId);
    const specifier = modelId ? `${providerId}/${modelId}` : undefined;
    if (specifier) this.settings.setModel(specifier);
    if (this.modelRuntime) {
      this.modelRuntime.registerProvider(providerId, typed);
      if (specifier && this.host.session) await this.applyModel(specifier);
    }
    const update: Partial<AgentConfigSnapshot> = { providerId, providerConfig: config };
    if (specifier) update.model = specifier;
    else if (this.settings.saved.model && !this.settings.saved.model.startsWith(`${providerId}/`)) {
      update.model = undefined;
    }
    await this.settings.persist(update);
    return `provider 已配置，接口：${typed.api ?? "默认"}${modelId ? `；模型：${modelId}` : ""}`;
  }

  /**
   * Configures a literal API key for the registered provider, overriding the
   * "$ENV_VAR" reference that toPiProviderConfig derives from models.dev.
   */
  public async setApiKey(key: string): Promise<string> {
    const trimmed = key.trim();
    if (!trimmed) throw new Error("API key 不能为空；如需改用环境变量，请重新执行 /provider");
    if (!this.settings.providerConfig) throw new Error("请先使用 /provider 选择 provider");
    this.settings.setProvider(this.settings.providerId, { ...this.settings.providerConfig, apiKey: trimmed });
    if (this.modelRuntime) {
      this.modelRuntime.registerProvider(this.settings.providerId, this.settings.providerConfig);
      if (this.host.session && this.settings.model) await this.applyModel(this.settings.model);
    }
    await this.settings.persist({ apiKey: trimmed });
    return `API key 已配置并持久化（${maskKey(trimmed)}）`;
  }

  public async setModel(specifier: string): Promise<string> {
    const message = await this.applyModel(specifier.trim());
    await this.settings.persist({ model: specifier.trim() });
    return message;
  }

  private async applyModel(specifier: string): Promise<string> {
    if (!this.host.session) {
      this.settings.setModel(specifier);
      return `模型将在会话建立后切换为 ${specifier}`;
    }
    const split = ModelSettings.splitSpecifier(specifier);
    if (!split) throw new Error("模型格式应为 provider/model，例如 openai/gpt-4o");
    const model = this.modelRuntime!.getModel(split.provider, split.modelId);
    if (!model) throw new Error(`找不到模型：${specifier}`);
    await this.host.session.setModel(this.settings.patchModel(model));
    this.settings.setModel(specifier);
    return `当前模型：${specifier}`;
  }

  /**
   * 手动设置上下文容量（token）：覆盖模型自带 contextWindow，Pi 的自动压缩
   * 阈值与用量百分比都按新容量计算（如给 1M 模型设 200k）。undefined 恢复
   * 模型默认。
   */
  public async setContextWindow(tokens?: number): Promise<string> {
    this.settings.setContextWindow(tokens);
    await this.settings.persist({ contextWindow: this.settings.contextWindow });
    const model = this.host.session?.model;
    if (model) {
      try {
        await this.applyModel(`${model.provider}/${model.id}`);
      } catch {
        // 模型重应用失败：覆盖保持待生效，下次会话打开时生效。
      }
    }
    return this.settings.contextWindow
      ? `上下文容量已设为 ${this.settings.contextWindow} tokens${model ? `（模型上限 ${model.contextWindow}）` : ""}；自动压缩按新容量触发`
      : "上下文容量已恢复为模型默认";
  }

  /**
   * 手动压缩上下文（/compact）：调用 Pi 会话的手动压缩入口（与自动压缩
   * 阈值相互独立），用当前模型生成会话摘要并重载上下文。草稿态（无会话）
   * 没有可压缩的内容。
   */
  public async compact(customInstructions?: string): Promise<string> {
    const session = this.host.session;
    if (!session) throw new Error("会话尚未建立（草稿态），没有可压缩的上下文");
    const result = await session.compact(customInstructions);
    const after = result.estimatedTokensAfter !== undefined ? `，压缩后约 ${result.estimatedTokensAfter} tokens` : "";
    return `已压缩上下文：${result.tokensBefore} tokens${after}；摘要 ${[...result.summary].length} 字`;
  }

  /** Thinking levels the current model supports (ascending); before a session exists, resolved from the pending model preference. */
  public thinkingLevels(): string[] {
    const model = this.host.session?.model
      ?? this.settings.requestedModelInstance((provider, modelId) => this.modelRuntime?.getModel(provider, modelId));
    return model ? [...getSupportedThinkingLevels(model)] : [];
  }

  public async setThinkingLevel(level: string): Promise<string> {
    const message = this.applyThinkingLevel(level);
    await this.settings.persist({ thinkingLevel: this.settings.thinkingLevel });
    return message;
  }

  private applyThinkingLevel(level: string): string {
    // 草稿态（无会话）也允许设置：按待生效的模型校验，会话建立后自动应用。
    const model = this.host.session?.model
      ?? this.settings.requestedModelInstance((provider, modelId) => this.modelRuntime?.getModel(provider, modelId));
    if (!model) throw new Error("请先使用 /model 选择模型；thinking level 由当前模型决定");
    const normalized = this.settings.validateThinkingLevel(level, model);
    this.host.session?.setThinkingLevel(normalized);
    this.settings.setThinkingLevel(normalized);
    return this.host.session
      ? `当前 thinking level：${normalized}`
      : `thinking level 将在会话建立后应用：${normalized}`;
  }

  /**
   * Applies the thinking level after the session opens: the configured
   * preference, else the pulled global default (resolveThinkingLevel), clamped
   * to the model's supported levels; with neither, the model's highest
   * supported level. A no-op until the model resolves.
   */
  private applyThinkingDefaults(): void {
    const session = this.host.session;
    const model = session?.model;
    if (!session || !model) return;
    const level = this.settings.resolveThinkingDefault(model, this.options.resolveThinkingLevel?.());
    session.setThinkingLevel(level);
    this.settings.setThinkingLevel(level);
  }

  public status(): string {
    const session = this.host.session;
    const model = session?.model;
    if (session && model) {
      return `模型：${model.provider}/${model.id}；thinking：${session.thinkingLevel}`;
    }
    const saved = this.settings.saved;
    const pending = [
      saved.providerId && `provider ${saved.providerId}`,
      this.settings.model && `模型 ${this.settings.model}`,
      saved.apiKey && `API key ${maskKey(saved.apiKey)}`,
      this.settings.thinkingLevel && `thinking ${this.settings.thinkingLevel}`
    ].filter(Boolean);
    return pending.length > 0
      ? `配置已就绪（${pending.join("，")}），会话尚未建立`
      : "会话尚未建立，未配置模型";
  }

  public async close(): Promise<void> {
    this.host.close();
    this.modelRuntime = undefined;
    this.settings.reset();
  }
}
