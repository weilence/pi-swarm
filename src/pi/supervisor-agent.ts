import { join } from "node:path";
import { THINKING_LEVELS } from "../core/worker.ts";
import type { ModuleDefinition } from "../protocol/contracts.ts";
import type { AgentConfigSnapshot, ConfigStore } from "../core/config/config-store.ts";
import { getUserDataDir } from "../core/userdata.ts";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  ModelRuntime
} from "@earendil-works/pi-coding-agent";

/** Masks a key for logs and status lines: keeps a short head and tail. */
function maskKey(key: string): string {
  return key.length <= 8 ? "***" : `${key.slice(0, 3)}...${key.slice(-4)}`;
}

export interface SupervisorAgentOptions {
  /** Working directory the supervisor reasons about; defaults to the repo root. */
  cwd?: string;
  /** Pi agent directory; defaults to a folder under the user data dir to keep the repo clean. */
  agentDir?: string;
  onText?: (delta: string) => void;
  /** When provided, every successful configuration change is persisted. */
  configStore?: ConfigStore;
}

/**
 * The Supervisor's own model-backed agent: it owns a Pi AgentSession used for
 * task planning, and persists its provider/model/thinking configuration through
 * a ConfigStore so selections survive restarts.
 */
export class SupervisorAgent {
  private session?: AgentSession;
  private unsubscribe?: () => void;
  private responseBuffer = "";
  private snapshot: AgentConfigSnapshot = {};
  private modelRuntime?: ModelRuntime;
  private providerConfig?: Parameters<ModelRuntime["registerProvider"]>[1];
  private providerId = "models-dev";
  private requestedModel?: string;
  private requestedThinkingLevel?: string;
  private readonly cwd: string;
  private readonly agentDir: string;
  private readonly onText?: (delta: string) => void;
  private readonly configStore?: ConfigStore;

  public constructor(options: SupervisorAgentOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.agentDir = options.agentDir ?? join(getUserDataDir(), "supervisor-agent");
    this.onText = options.onText;
    this.configStore = options.configStore;
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

    this.modelRuntime = await ModelRuntime.create({ refreshOnCreate: false });
    if (this.providerConfig) this.modelRuntime.registerProvider(this.providerId, this.providerConfig);
    const resourceLoader = new DefaultResourceLoader({
      cwd: this.cwd,
      agentDir: this.agentDir,
      appendSystemPromptOverride: (base) => [
        ...base,
        "You are the pi-swarm Supervisor agent coordinating module workers.",
        "You plan and delegate; you do not edit module files yourself. Keep plans concise and actionable."
      ]
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd: this.cwd,
      resourceLoader,
      sessionManager: SessionManager.inMemory(),
      modelRuntime: this.modelRuntime
    });
    this.session = session;
    this.unsubscribe = session.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        this.responseBuffer += event.assistantMessageEvent.delta;
        this.onText?.(event.assistantMessageEvent.delta);
      }
    });
    if (this.requestedModel) await this.applyModel(this.requestedModel);
    if (this.requestedThinkingLevel) this.applyThinkingLevel(this.requestedThinkingLevel);
    return session;
  }

  /**
   * Real model call: turns a user goal into an execution plan for the module
   * worker. Streams deltas through onText and returns the accumulated text.
   */
  public async plan(goal: string, module: ModuleDefinition): Promise<string> {
    const session = await this.ensureSession();
    this.responseBuffer = "";
    await session.prompt(
      [
        "为以下任务制定执行计划，交给模块 worker 执行。",
        `用户目标：${goal}`,
        `目标模块：${module.id}（工作目录 ${module.path}）`,
        `模块上下文文件：${module.contextFiles.join(", ") || "无"}`,
        `允许修改的路径：${module.allowedPaths.join(", ") || "无"}`,
        `必须通过的测试：${[module.testCommand, module.contractCommand].filter(Boolean).join(", ") || "无"}`,
        "输出：1) 步骤拆解 2) 每步涉及的文件 3) 风险与跨模块注意点。保持简洁。"
      ].join("\n")
    );
    const plan = this.responseBuffer.trim();
    this.responseBuffer = "";
    return plan;
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
    if (this.session) {
      this.modelRuntime!.registerProvider(providerId, this.providerConfig);
      if (specifier) await this.applyModel(specifier);
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
    this.responseBuffer = "";
    this.modelRuntime = undefined;
    this.providerConfig = undefined;
    this.providerId = "models-dev";
    this.requestedModel = undefined;
    this.requestedThinkingLevel = undefined;
  }
}
