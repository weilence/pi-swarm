import { join } from "node:path";
import { THINKING_LEVELS } from "../core/worker.ts";
import type { ModuleDefinition } from "../protocol/contracts.ts";
import type { AgentConfigSnapshot, ConfigStore } from "../core/config/config-store.ts";
import { getUserDataDir } from "../core/userdata.ts";
import { dim } from "../core/ansi.ts";
import { forwardAssistantEvent } from "./assistant-stream.ts";
import { extractJson, parseIntentAnalysis, parsePlannedSteps, type IntentAnalysis, type PlannedStep, type StepOutcome } from "../core/orchestrator.ts";
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
  /** Streams assistant text; defaults to plain stdout. */
  onText?: (delta: string) => void;
  /** Streams reasoning/thinking deltas; defaults to dimmed stdout. */
  onThinking?: (delta: string) => void;
  /** Called when a streaming response finishes (or fails) to flush UI tails. */
  onStreamEnd?: () => void;
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
  private streamToUi = true;
  private snapshot: AgentConfigSnapshot = {};
  private modelRuntime?: ModelRuntime;
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

  public constructor(options: SupervisorAgentOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.agentDir = options.agentDir ?? join(getUserDataDir(), "supervisor-agent");
    this.onText = options.onText ?? ((delta) => process.stdout.write(delta));
    this.onThinking = options.onThinking ?? ((delta) => process.stdout.write(dim(delta)));
    this.onStreamEnd = options.onStreamEnd;
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
    if (this.requestedModel) await this.applyModel(this.requestedModel);
    if (this.requestedThinkingLevel) this.applyThinkingLevel(this.requestedThinkingLevel);
    return session;
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
    try {
      await session.prompt(prompt);
      const text = this.responseBuffer.trim();
      this.responseBuffer = "";
      return text;
    } finally {
      this.streamToUi = previous;
      this.onStreamEnd?.();
    }
  }

  private moduleBriefing(modules: ModuleDefinition[]): string {
    return modules
      .map((module) => {
        const tests = [module.testCommand, module.contractCommand].filter(Boolean).join(", ") || "无";
        return `- ${module.id}（目录 ${module.path}；上下文：${module.contextFiles.join(", ") || "无"}；可改：${module.allowedPaths.join(", ") || "无"}；测试：${tests}）`;
      })
      .join("\n");
  }

  /** Classifies the user input: simple, complex, or unclear with questions. */
  public async analyzeIntent(input: string, modules: ModuleDefinition[], clarifications?: string): Promise<IntentAnalysis> {
    const reply = await this.promptModel(
      [
        "你是 pi-swarm Supervisor 的意图分析器。分析用户输入并判定任务类型。",
        `可用模块：\n${this.moduleBriefing(modules)}`,
        `用户输入：「${input}」`,
        ...(clarifications ? [`用户已补充的信息：「${clarifications}」`] : []),
        "判定标准：simple=一步即可完成且无歧义；complex=需要多个步骤或多个模块协作；unclear=缺少关键决策或信息，无法安全开始。",
        '仅输出 JSON，不要输出其他内容：{"clarity":"simple|complex|unclear","task":"提炼后的任务描述（吸收补充信息）","questions":["仅 unclear 时：需要用户确认的问题"]}'
      ].join("\n")
    );
    const analysis = parseIntentAnalysis(extractJson(reply));
    if (!analysis) throw new Error(`意图分析结果无法解析：${reply.slice(0, 120)}`);
    return analysis;
  }

  /** Splits a clear task into dependency-ordered steps for module workers. */
  public async planSteps(goal: string, modules: ModuleDefinition[], clarifications?: string): Promise<PlannedStep[]> {
    const reply = await this.promptModel(
      [
        "你是 pi-swarm Supervisor 的规划器。把任务拆成模块 worker 可执行的步骤。",
        `任务：${goal}`,
        ...(clarifications ? [`用户补充信息：${clarifications}`] : []),
        `可用模块（module 只能取以下 id）：\n${this.moduleBriefing(modules)}`,
        "要求：步骤不超过 6 个；每个步骤目标具体、可独立验收；无依赖关系的步骤不要设置 dependsOn，它们会并行执行。",
        '仅输出 JSON：{"steps":[{"id":"s1","module":"<模块id>","goal":"步骤目标","dependsOn":["前置步骤id"]}]}'
      ].join("\n")
    );
    const steps = parsePlannedSteps(extractJson(reply));
    if (!steps) throw new Error(`规划结果无法解析：${reply.slice(0, 120)}`);
    return steps;
  }

  /** Streams a markdown summary of the finished steps to the user. */
  public async summarize(goal: string, outcomes: StepOutcome[]): Promise<void> {
    await this.promptModel(
      [
        "你是 pi-swarm Supervisor。所有步骤已执行完毕，请用 markdown 向用户输出简洁总结。",
        `原始目标：${goal}`,
        "步骤结果（JSON）：",
        JSON.stringify(
          outcomes.map(({ step, result, error }) => ({
            step: step.id,
            module: step.module,
            goal: step.goal,
            status: error ? "failed" : (result?.status ?? "unknown"),
            changedFiles: result?.changedFiles ?? [],
            risks: result?.risks ?? []
          })),
          null,
          2
        ),
        "内容：完成了什么、关键变更、失败或风险、后续建议。保持简洁。"
      ].join("\n"),
      { stream: true }
    );
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
