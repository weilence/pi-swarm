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
import { forwardAssistantEvent } from "./assistant-stream.ts";
import { clampThinkingLevel, getSupportedThinkingLevels, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager as PiSessionManager,
  type ToolDefinition
} from "@earendil-works/pi-coding-agent";

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
  /** True while a prompt is streaming. */
  busy?: boolean;
}

/** Stream sinks every agent forwards its session events to, labeled with the agent name. */
export interface AgentStreamSinks {
  /** Streams assistant text (the model's answer), labeled with the agent name. */
  onText: (delta: string, agent: string) => void;
  /** Streams reasoning/thinking deltas, labeled with the agent name. */
  onThinking: (delta: string, agent: string) => void;
  /** Called when a streaming response finishes (or fails) to flush UI tails. */
  onStreamEnd: (agent: string) => void;
  /** A tool call started in this agent's session (args as delivered). */
  onToolStart: (toolCallId: string, toolName: string, args: unknown, agent: string) => void;
  /** A tool call finished; isError marks failed calls. */
  onToolEnd: (toolCallId: string, toolName: string, isError: boolean, agent: string) => void;
}

/**
 * Everything that distinguishes one agent from another is configuration: the
 * role lives in `systemPrompt`, capabilities arrive as optional groups
 * (delegate wiring, config persistence, tool allowlist, pulled model/thinking
 * defaults). There is no supervisor/sub-agent subclass split.
 */
export interface AgentOptions extends AgentStreamSinks {
  /** UI 标签，也是流式回调收到的 agent 标注。 */
  name: string;
  /** Shared Pi runtime; created lazily when omitted. */
  modelRuntime?: ModelRuntime;
  /** Working directory for the agent session; defaults to the project root. */
  cwd?: string;
  /** Pi agent directory; defaults to a per-agent folder under the user data dir. */
  agentDir?: string;
  /** Role prompt: entries appended after the resource loader's base prompt. A function is rebuilt per session open. */
  systemPrompt?: string[] | (() => string[]);
  /** Tool allowlist (a sub-agent's frontmatter tools); omitted means Pi's defaults. */
  tools?: string[];
  /** SDK custom tools beyond the delegate tool. */
  customTools?: ToolDefinition[];
  /** Injected Pi session manager (persistent, rebindable); defaults to in-memory. */
  sessionManager?: PiSessionManager;
  /** Config persistence capability; without it the config API keeps in-memory state only. */
  configStore?: ConfigStore;
  /** Pulled once per session creation when no explicit model was set (sub-agents follow the global default). */
  resolveModel?: () => string | undefined;
  /** Pulled once per session creation when no explicit thinking level was set (sub-agents follow the supervisor). */
  resolveThinkingLevel?: () => ModelThinkingLevel | undefined;
  /** Delegate capability: attaches the delegate tool and gives runTask its task budget. */
  delegate?: {
    agents: { list(): AgentDefinition[] };
    stepExecutor: { run(job: StepJob): Promise<StepRecord> };
    log?: (line: string) => void;
  };
  /** Per-attempt wall-clock limit for runStep; the session is aborted when it fires. */
  timeoutMs?: number;
}

/**
 * The one model-backed agent: a lazily created Pi session, streaming event
 * forwarding, model/thinking management, delegate-step execution, and optional
 * config persistence — one class, roles differ by prompt and capabilities.
 */
export class Agent {
  private session?: AgentSession;
  private unsubscribe?: () => void;
  private responseBuffer = "";
  private streamToUi = true;
  private snapshot: AgentConfigSnapshot = {};
  private modelRuntime?: ModelRuntime;
  private piSession?: PiSessionManager;
  /** Set while a prompt is streaming; rebind() rejects concurrent switches. */
  private prompting = false;
  /** 流式中当前 assistant 消息的 running 输出 token（message_update 持续更新；
   *  消息落盘后清零——那时会话统计已包含它，避免重复计数）。 */
  private runningOutputTokens = 0;
  private providerConfig?: Parameters<ModelRuntime["registerProvider"]>[1];
  private providerId = "models-dev";
  private requestedModel?: string;
  private requestedThinkingLevel?: ModelThinkingLevel;
  /** 手动上下文容量（token）：覆盖模型自带 contextWindow；undefined = 模型默认。 */
  private contextWindowOverride?: number;
  /** 用户主动请求停止（双击 Esc）：把中止当正常结束而非错误。 */
  private abortRequested = false;
  private collector?: ToolObservationCollector;
  /** Holder the delegate tool reads; swapped per task in runTask(). */
  private readonly delegateState: DelegateState = {};
  private readonly cwd: string;
  private readonly agentDir: string;

  public constructor(private readonly options: AgentOptions) {
    this.cwd = options.cwd ?? process.cwd();
    this.agentDir = options.agentDir ?? join(getUserDataDir(), "agents", options.name);
    this.modelRuntime = options.modelRuntime;
    this.piSession = options.sessionManager;
  }

  /** Current global default model (provider/model) as configured via /model. */
  public get currentModel(): string | undefined {
    return this.requestedModel;
  }

  /** Effective thinking level: the session's live value, else the pending preference. */
  public get currentThinkingLevel(): ModelThinkingLevel | undefined {
    return this.session?.thinkingLevel ?? this.requestedThinkingLevel;
  }

  /**
   * Structured snapshot for the editor status bar: live session stats
   * (context usage, cumulative token accounting, cost) plus the pending
   * model preference when no session exists yet. Best-effort by design.
   */
  public get statusSnapshot(): AgentStatusSnapshot {
    const session = this.session;
    const model = session?.model;
    if (!session || !model) return { model: this.requestedModel, busy: this.prompting };
    const stats = session.getSessionStats();
    const usage = stats.contextUsage;
    return {
      model: `${model.provider}/${model.id}`,
      thinkingLevel: session.thinkingLevel,
      contextTokens: usage?.tokens ?? undefined,
      contextWindow: usage?.contextWindow,
      contextPercent: usage?.percent ?? undefined,
      inputTokens: stats.tokens.input,
      outputTokens: stats.tokens.output + this.runningOutputTokens,
      cacheRead: stats.tokens.cacheRead,
      cacheWrite: stats.tokens.cacheWrite,
      cost: stats.cost,
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
    this.snapshot = { ...saved };
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
        this.requestedThinkingLevel = saved.thinkingLevel as ModelThinkingLevel;
        parts.push(`thinking ${saved.thinkingLevel}`);
      }
      if (saved.contextWindow && saved.contextWindow > 0) {
        this.contextWindowOverride = saved.contextWindow;
        parts.push(`上下文容量 ${saved.contextWindow}`);
      }
    } catch (error) {
      parts.push(`部分配置恢复失败：${error instanceof Error ? error.message : String(error)}`);
    }
    return parts.length > 0 ? `已恢复配置：${parts.join("，")}` : "无已保存的配置";
  }

  private async ensureSession(): Promise<AgentSession> {
    if (this.session) return this.session;

    this.modelRuntime ??= await ModelRuntime.create({ refreshOnCreate: false });
    if (this.providerConfig) this.modelRuntime.registerProvider(this.providerId, this.providerConfig);
    return await this.openSession(this.piSession ?? PiSessionManager.inMemory(this.cwd));
  }

  /**
   * Releases the old AgentSession and binds the given Pi session as the
   * current one; re-applies model/thinking afterwards (a failed model
   * re-application does not block the switch — it stays pending).
   */
  private async openSession(sessionManager: PiSessionManager): Promise<AgentSession> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.session?.dispose();
    this.session = undefined;
    const extras =
      typeof this.options.systemPrompt === "function" ? this.options.systemPrompt() : this.options.systemPrompt ?? [];
    const resourceLoader = new DefaultResourceLoader({
      cwd: this.cwd,
      agentDir: this.agentDir,
      appendSystemPromptOverride: (base) => [...base, ...extras]
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd: this.cwd,
      resourceLoader,
      sessionManager,
      modelRuntime: this.modelRuntime!,
      customTools: this.customTools(),
      ...(this.options.tools && this.options.tools.length > 0 ? { tools: this.options.tools } : {})
    });
    this.session = session;
    this.piSession = sessionManager;
    this.unsubscribe = session.subscribe((event) => {
      this.collector?.handle(event);
      // 流式 usage：message_update 携带进行中消息的累计输出 token（Anthropic
      // 每个 message_delta 更新一次，思考/正文都包含在 output_tokens 里），
      // 供状态栏实时速度采样；会话统计只在消息落盘时更新，单靠它速度表
      // 在整个生成期间都是 Δ=0。message_end 时统计已包含该消息，清零防重复。
      if (event.type === "message_update" && event.message.role === "assistant") {
        this.runningOutputTokens = event.message.usage?.output ?? this.runningOutputTokens;
      } else if (event.type === "message_end" && event.message.role === "assistant") {
        this.runningOutputTokens = 0;
      } else if (event.type === "agent_end") {
        this.runningOutputTokens = 0; // 中断等未走 message_end 的兑底
      }
      forwardAssistantEvent(event, {
        appendText: (delta) => {
          this.responseBuffer += delta;
        },
        onText: (delta) => {
          if (this.streamToUi) this.options.onText(delta, this.options.name);
        },
        onThinking: (delta) => {
          if (this.streamToUi) this.options.onThinking(delta, this.options.name);
        },
        onToolStart: (toolCallId, toolName, args) => {
          if (this.streamToUi) this.options.onToolStart(toolCallId, toolName, args, this.options.name);
        },
        onToolEnd: (toolCallId, toolName, isError) => {
          if (this.streamToUi) this.options.onToolEnd(toolCallId, toolName, isError, this.options.name);
        }
      });
    });
    try {
      const model = this.requestedModel ?? this.options.resolveModel?.();
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
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.session?.dispose();
    this.session = undefined;
    this.piSession = undefined;
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
    if (!this.prompting || !this.session) return;
    this.abortRequested = true;
    await this.session.abort().catch(() => undefined);
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
    const previous = this.streamToUi;
    this.streamToUi = options.stream === true;
    this.responseBuffer = "";
    this.prompting = true;
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
      const text = this.responseBuffer.trim();
      this.responseBuffer = "";
      return text;
    } catch (error) {
      if (this.abortRequested) {
        // 用户主动停止：不算错误，返回已生成的部分文本。
        this.abortRequested = false;
        return this.responseBuffer.trim();
      }
      if (error instanceof StepTimeoutError) {
        await session.abort().catch(() => undefined);
        await run.catch(() => undefined);
      }
      throw error;
    } finally {
      clearTimeout(timer);
      this.prompting = false;
      this.abortRequested = false;
      this.streamToUi = previous;
      this.options.onStreamEnd(this.options.name);
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
        this.collector = new ToolObservationCollector();
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
      this.collector?.observation ?? { toolCalls: 0, errors: [], changedFiles: [] };
    return {
      id: step.id,
      agent: this.options.name,
      goal: step.goal,
      status: "completed",
      summary: this.session?.getLastAssistantText() ?? "",
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

  /** The delegate tool when the delegate capability is wired and agents exist. */
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
    this.providerId = providerId;
    this.providerConfig = config as Parameters<ModelRuntime["registerProvider"]>[1];
    // Switching providers invalidates a model selected for the previous one.
    if (this.requestedModel && !this.requestedModel.startsWith(`${providerId}/`)) {
      this.requestedModel = undefined;
    }
    const specifier = modelId ? `${providerId}/${modelId}` : undefined;
    if (specifier) this.requestedModel = specifier;
    if (this.modelRuntime) {
      this.modelRuntime.registerProvider(providerId, this.providerConfig);
      if (specifier && this.session) await this.applyModel(specifier);
    }
    const update: Partial<AgentConfigSnapshot> = { providerId, providerConfig: config };
    if (specifier) update.model = specifier;
    else if (this.snapshot.model && !this.snapshot.model.startsWith(`${providerId}/`)) update.model = undefined;
    await this.persist(update);
    return `provider 已配置，接口：${this.providerConfig.api ?? "默认"}${modelId ? `；模型：${modelId}` : ""}`;
  }

  /**
   * Configures a literal API key for the registered provider, overriding the
   * "$ENV_VAR" reference that toPiProviderConfig derives from models.dev.
   */
  public async setApiKey(key: string): Promise<string> {
    const trimmed = key.trim();
    if (!trimmed) throw new Error("API key 不能为空；如需改用环境变量，请重新执行 /provider");
    if (!this.providerConfig) throw new Error("请先使用 /provider 选择 provider");
    this.providerConfig = { ...this.providerConfig, apiKey: trimmed };
    if (this.modelRuntime) {
      this.modelRuntime.registerProvider(this.providerId, this.providerConfig);
      if (this.session && this.requestedModel) await this.applyModel(this.requestedModel);
    }
    await this.persist({ apiKey: trimmed });
    return `API key 已配置并持久化（${maskKey(trimmed)}）`;
  }

  public async setModel(specifier: string): Promise<string> {
    const message = await this.applyModel(specifier.trim());
    await this.persist({ model: specifier.trim() });
    return message;
  }

  private async applyModel(specifier: string): Promise<string> {
    if (!this.session) {
      this.requestedModel = specifier;
      return `模型将在会话建立后切换为 ${specifier}`;
    }
    const separator = specifier.indexOf("/");
    if (separator <= 0 || separator === specifier.length - 1) {
      throw new Error("模型格式应为 provider/model，例如 openai/gpt-4o");
    }
    const provider = specifier.slice(0, separator);
    const modelId = specifier.slice(separator + 1);
    const model = this.modelRuntime!.getModel(provider, modelId);
    if (!model) throw new Error(`找不到模型：${specifier}`);
    await this.session.setModel(this.patchContextWindow(model));
    this.requestedModel = specifier;
    return `当前模型：${specifier}`;
  }

  /**
   * 手动设置上下文容量（token）：克隆模型定义改写 contextWindow，Pi 的自动
   * 压缩阈值与用量百分比都按新容量计算（如给 1M 模型设 200k）。undefined
   * 恢复模型默认。
   */
  public async setContextWindow(tokens?: number): Promise<string> {
    this.contextWindowOverride = tokens && tokens > 0 ? tokens : undefined;
    await this.persist({ contextWindow: this.contextWindowOverride });
    const model = this.session?.model;
    if (model) {
      try {
        await this.applyModel(`${model.provider}/${model.id}`);
      } catch {
        // 模型重应用失败：覆盖保持待生效，下次会话打开时生效。
      }
    }
    return this.contextWindowOverride
      ? `上下文容量已设为 ${this.contextWindowOverride} tokens${model ? `（模型上限 ${model.contextWindow}）` : ""}；自动压缩按新容量触发`
      : "上下文容量已恢复为模型默认";
  }

  /**
   * 手动压缩上下文（/compact）：调用 Pi 会话的手动压缩入口（与自动压缩
   * 阈值相互独立），用当前模型生成会话摘要并重载上下文。草稿态（无会话）
   * 没有可压缩的内容。
   */
  public async compact(customInstructions?: string): Promise<string> {
    if (!this.session) throw new Error("会话尚未建立（草稿态），没有可压缩的上下文");
    const result = await this.session.compact(customInstructions);
    const after = result.estimatedTokensAfter !== undefined ? `，压缩后约 ${result.estimatedTokensAfter} tokens` : "";
    return `已压缩上下文：${result.tokensBefore} tokens${after}；摘要 ${[...result.summary].length} 字`;
  }

  /** 手动容量覆盖模型的 contextWindow（仅数据克隆，不修改共享模型表）。 */
  private patchContextWindow<M extends { contextWindow: number }>(model: M): M {
    return this.contextWindowOverride ? { ...model, contextWindow: this.contextWindowOverride } : model;
  }

  /** Thinking levels the current model supports (ascending); before a session exists, resolved from the pending model preference. */
  public thinkingLevels(): string[] {
    const model = this.session?.model ?? this.requestedModelInstance();
    return model ? [...getSupportedThinkingLevels(model)] : [];
  }

  /** Resolves the pending model preference against the runtime; undefined when unset or unknown. */
  private requestedModelInstance(): ReturnType<ModelRuntime["getModel"]> | undefined {
    const specifier = this.requestedModel;
    if (!specifier || !this.modelRuntime) return undefined;
    const separator = specifier.indexOf("/");
    if (separator <= 0 || separator === specifier.length - 1) return undefined;
    return this.modelRuntime.getModel(specifier.slice(0, separator), specifier.slice(separator + 1));
  }

  public async setThinkingLevel(level: string): Promise<string> {
    const message = this.applyThinkingLevel(level);
    await this.persist({ thinkingLevel: this.requestedThinkingLevel });
    return message;
  }

  private applyThinkingLevel(level: string): string {
    // 草稿态（无会话）也允许设置：按待生效的模型校验，会话建立后自动应用。
    const model = this.session?.model ?? this.requestedModelInstance();
    if (!model) throw new Error("请先使用 /model 选择模型；thinking level 由当前模型决定");
    const normalized = level.trim().toLowerCase() as ModelThinkingLevel;
    const supported = getSupportedThinkingLevels(model);
    if (!supported.includes(normalized)) {
      throw new Error(`当前模型支持的 thinking level：${supported.join(", ")}`);
    }
    this.session?.setThinkingLevel(normalized);
    this.requestedThinkingLevel = normalized;
    return this.session
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
    const session = this.session;
    const model = session?.model;
    if (!session || !model) return;
    const requested = this.requestedThinkingLevel ?? this.options.resolveThinkingLevel?.();
    const supported = getSupportedThinkingLevels(model);
    const level = requested ? clampThinkingLevel(model, requested) : supported[supported.length - 1];
    session.setThinkingLevel(level);
    this.requestedThinkingLevel = level;
  }

  public status(): string {
    const session = this.session;
    const model = session?.model;
    if (session && model) {
      return `模型：${model.provider}/${model.id}；thinking：${session.thinkingLevel}`;
    }
    const pending = [
      this.snapshot.providerId && `provider ${this.snapshot.providerId}`,
      this.requestedModel && `模型 ${this.requestedModel}`,
      this.snapshot.apiKey && `API key ${maskKey(this.snapshot.apiKey)}`,
      this.requestedThinkingLevel && `thinking ${this.requestedThinkingLevel}`
    ].filter(Boolean);
    return pending.length > 0
      ? `配置已就绪（${pending.join("，")}），会话尚未建立`
      : "会话尚未建立，未配置模型";
  }

  private async persist(update: Partial<AgentConfigSnapshot>): Promise<void> {
    if (!this.options.configStore) return;
    this.snapshot = { ...this.snapshot, ...update };
    await this.options.configStore.save(this.snapshot);
  }

  public async close(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.session?.dispose();
    this.session = undefined;
    this.piSession = undefined;
    this.responseBuffer = "";
    this.modelRuntime = undefined;
    this.providerConfig = undefined;
    this.providerId = "models-dev";
    this.requestedModel = undefined;
    this.requestedThinkingLevel = undefined;
  }
}

/** Masks a key for logs and status lines: keeps a short head and tail. */
function maskKey(key: string): string {
  return key.length <= 8 ? "***" : `${key.slice(0, 3)}...${key.slice(-4)}`;
}
