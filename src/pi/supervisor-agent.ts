import { join } from "node:path";
import { THINKING_LEVELS } from "../core/thinking.ts";
import type { AgentDefinition } from "../core/agent-format.ts";
import { createTaskRun, type StepRecord } from "../core/task-run.ts";
import type { StepJob } from "../core/supervisor.ts";
import { getUserDataDir } from "../core/userdata.ts";
import { dim } from "../core/ansi.ts";
import { forwardAssistantEvent } from "./assistant-stream.ts";
import { createDelegateTool, type DelegateState } from "./delegate-tool.ts";
import type { AgentConfigSnapshot, ConfigStore } from "../core/config/config-store.ts";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  SessionManager as PiSessionManager,
  ModelRuntime
} from "@earendil-works/pi-coding-agent";
import { SessionBusyError } from "../core/session/session-types.ts";

/** Masks a key for logs and status lines: keeps a short head and tail. */
function maskKey(key: string): string {
  return key.length <= 8 ? "***" : `${key.slice(0, 3)}...${key.slice(-4)}`;
}

export interface SupervisorAgentOptions {
  /** Working directory the supervisor reasons about; defaults to the repo root. */
  cwd?: string;
  /** Pi agent directory; defaults to a folder under the user data dir to keep the repo clean. */
  agentDir?: string;
  /**
   * Shared ModelRuntime: providers registered via /provider become visible to
   * the supervisor session and every sub-agent session. Created lazily when
   * omitted; main.ts shares one instance across all sessions.
   */
  modelRuntime?: ModelRuntime;
  /** Streams assistant text; defaults to plain stdout. */
  onText?: (delta: string) => void;
  /** Streams reasoning/thinking deltas; defaults to dimmed stdout. */
  onThinking?: (delta: string) => void;
  /** Called when a streaming response finishes (or fails) to flush UI tails. */
  onStreamEnd?: () => void;
  /** When provided, every successful configuration change is persisted. */
  configStore?: ConfigStore;
  /**
   * Injected Pi session (persistent JSONL or inMemory); defaults to inMemory.
   * Switching sessions at runtime goes through rebind() — see the bind
   * contract in docs/session-design.md.
   */
  sessionManager?: PiSessionManager;
  /** Registered sub-agent catalog; drives the roster prompt and the delegate tool. */
  agents?: { list(): AgentDefinition[] };
  /** Executes a delegate step on its agent (Supervisor.run). */
  stepExecutor?: { run(job: StepJob): Promise<StepRecord> };
  /** Progress log for delegate batches and step lifecycles. */
  log?: (line: string) => void;
}

/** Execution guidelines appended when the delegate tool is available. */
const DELEGATE_GUIDELINES = [
  "任务执行准则：",
  "1. 收到用户任务后先判断：能一步自行完成的直接做；需要多个步骤或适合交给子 agent 的，用 delegate 派发。",
  "2. delegate 一次最多 6 个步骤，无依赖的并行执行；步骤目标要具体、可独立验收。",
  "3. 根据 delegate 返回的真实结果继续决策：再派下一批、换 agent 重做失败步骤，或自己补完剩余工作。",
  "4. 全部完成后向用户输出 markdown 总结：完成了什么、关键变更、失败与风险、后续建议。"
].join("\n");

/**
 * The Supervisor's own model-backed agent: its Pi session is the task's whole
 * control flow — the model plans, delegates via the delegate tool, reacts to
 * real step results, and summarizes. Configuration (provider/model/thinking)
 * persists through a ConfigStore so selections survive restarts.
 */
export class SupervisorAgent {
  private session?: AgentSession;
  private unsubscribe?: () => void;
  private responseBuffer = "";
  private streamToUi = true;
  private snapshot: AgentConfigSnapshot = {};
  private modelRuntime?: ModelRuntime;
  private piSession?: PiSessionManager;
  /** Set while a prompt is streaming; rebind() rejects concurrent switches. */
  private prompting = false;
  private providerConfig?: Parameters<ModelRuntime["registerProvider"]>[1];
  private providerId = "models-dev";
  private requestedModel?: string;
  private requestedThinkingLevel?: string;
  private readonly cwd: string;
  private readonly agentDir: string;
  private readonly onText: (delta: string) => void;
  private readonly onThinking: (delta: string) => void;
  private readonly onStreamEnd?: () => void;
  private readonly configStore?: ConfigStore;
  private readonly options: SupervisorAgentOptions;
  /** Holder the delegate tool reads; swapped per task in runTask(). */
  private readonly delegateState: DelegateState = {};

  public constructor(options: SupervisorAgentOptions = {}) {
    this.options = options;
    this.cwd = options.cwd ?? process.cwd();
    this.agentDir = options.agentDir ?? join(getUserDataDir(), "supervisor-agent");
    this.modelRuntime = options.modelRuntime;
    this.onText = options.onText ?? ((delta) => process.stdout.write(delta));
    this.onThinking = options.onThinking ?? ((delta) => process.stdout.write(dim(delta)));
    this.onStreamEnd = options.onStreamEnd;
    this.configStore = options.configStore;
    this.piSession = options.sessionManager;
  }

  /** Current global default model (provider/model) as configured via /model. */
  public get currentModel(): string | undefined {
    return this.requestedModel;
  }

  /** Applies a previously persisted snapshot; returns a human-readable summary. */
  public async restore(): Promise<string> {
    if (!this.configStore) return "未启用配置持久化";
    let saved: AgentConfigSnapshot;
    try {
      saved = await this.configStore.load();
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
        await this.setThinkingLevel(saved.thinkingLevel);
        parts.push(`thinking ${saved.thinkingLevel}`);
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
    const delegateAvailable = this.delegateAvailable();
    const resourceLoader = new DefaultResourceLoader({
      cwd: this.cwd,
      agentDir: this.agentDir,
      appendSystemPromptOverride: (base) => [
        ...base,
        "You are the pi-swarm Supervisor agent coordinating user-defined sub-agents.",
        this.rosterPrompt(),
        ...(delegateAvailable ? [DELEGATE_GUIDELINES] : [])
      ]
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd: this.cwd,
      resourceLoader,
      sessionManager,
      modelRuntime: this.modelRuntime!,
      customTools: delegateAvailable ? [createDelegateTool(this.delegateServices(), this.delegateState)] : []
    });
    this.session = session;
    this.piSession = sessionManager;
    this.unsubscribe = session.subscribe((event) => {
      forwardAssistantEvent(event, {
        appendText: (delta) => {
          this.responseBuffer += delta;
        },
        onText: (delta) => {
          if (this.streamToUi) this.onText(delta);
        },
        onThinking: (delta) => {
          if (this.streamToUi) this.onThinking(delta);
        }
      });
    });
    try {
      if (this.requestedModel) await this.applyModel(this.requestedModel);
    } catch {
      // The model may be unavailable after a provider switch: keep it pending.
    }
    if (this.requestedThinkingLevel) this.applyThinkingLevel(this.requestedThinkingLevel);
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

  /** Whether a prompt is currently streaming (session switches are rejected). */
  public isBusy(): boolean {
    return this.prompting;
  }

  /**
   * Runs one model turn and returns the full assistant text. Intermediate
   * turns (analysis, planning) stay quiet; set stream to show the reply live.
   */
  private async promptModel(prompt: string, options: { stream?: boolean } = {}): Promise<string> {
    const session = await this.ensureSession();
    const previous = this.streamToUi;
    this.streamToUi = options.stream === true;
    this.responseBuffer = "";
    this.prompting = true;
    try {
      await session.prompt(prompt);
      const text = this.responseBuffer.trim();
      this.responseBuffer = "";
      return text;
    } finally {
      this.prompting = false;
      this.streamToUi = previous;
      this.onStreamEnd?.();
    }
  }

  /**
   * Runs one user task through the supervisor session: the model owns the
   * control flow (plan, delegate via the delegate tool, react to real step
   * results, summarize); this method only swaps in a fresh TaskRun for the
   * delegate tool's budget and record-keeping. Returns the final text.
   */
  public async runTask(goal: string): Promise<string> {
    this.delegateState.taskRun = createTaskRun(goal);
    try {
      return await this.promptModel(goal, { stream: true });
    } finally {
      this.delegateState.taskRun = undefined;
    }
  }

  private delegateAvailable(): boolean {
    return (this.options.agents?.list().length ?? 0) > 0 && Boolean(this.options.stepExecutor);
  }

  private delegateServices() {
    return {
      agents: this.options.agents!,
      runStep: (job: StepJob) => this.options.stepExecutor!.run(job),
      log: (line: string) => this.options.log?.(line)
    };
  }

  /** Roster section of the system prompt: who the model can delegate to. */
  private rosterPrompt(): string {
    const agents = this.options.agents?.list() ?? [];
    if (agents.length === 0) return "当前没有注册任何子 agent：请直接自行完成用户的任务。";
    return `可用子 agent（delegate 工具的 agent 字段只能取以下 name）：\n${this.agentBriefing(agents)}`;
  }

  private agentBriefing(agents: AgentDefinition[]): string {
    return agents
      .map((agent) => {
        const capabilities = agent.capabilities.length > 0 ? `；能力：${agent.capabilities.join("、")}` : "";
        return `- ${agent.name}：${agent.description}${capabilities}`;
      })
      .join("\n");
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
    const model = this.session.modelRuntime.getModel(provider, modelId);
    if (!model) throw new Error(`找不到模型：${specifier}`);
    await this.session.setModel(model);
    this.requestedModel = specifier;
    return `当前模型：${specifier}`;
  }

  public async setThinkingLevel(level: string): Promise<string> {
    const message = this.applyThinkingLevel(level);
    await this.persist({ thinkingLevel: this.requestedThinkingLevel });
    return message;
  }

  private applyThinkingLevel(level: string): string {
    const normalized = level.trim().toLowerCase();
    if (!THINKING_LEVELS.includes(normalized)) throw new Error(`thinking level 应为：${THINKING_LEVELS.join(", ")}`);
    if (this.session) this.session.setThinkingLevel(normalized as never);
    this.requestedThinkingLevel = normalized;
    return this.session ? `当前 thinking level：${normalized}` : `thinking level 将在会话建立后切换为 ${normalized}`;
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
    if (!this.configStore) return;
    this.snapshot = { ...this.snapshot, ...update };
    await this.configStore.save(this.snapshot);
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
