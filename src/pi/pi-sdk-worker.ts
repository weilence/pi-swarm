import type { ConfigurableModuleWorker } from "../core/worker.ts";
import { THINKING_LEVELS } from "../core/worker.ts";
import type { TaskEnvelope, WorkerResult } from "../protocol/contracts.ts";
import { join } from "node:path";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";

/** A Pi-backed worker that keeps one AgentSession alive for multiple tasks. */
export class PiSdkWorker implements ConfigurableModuleWorker {
  private session?: AgentSession;
  private unsubscribe?: () => void;
  private workingDirectory?: string;
  private requestedModel?: string;
  private requestedThinkingLevel?: string;
  private modelRuntime?: ModelRuntime;
  private providerConfig?: Parameters<ModelRuntime["registerProvider"]>[1];
  private providerId = "models-dev";
  private selectedModelId?: string;

  public constructor(
    private readonly workerName: string,
    private readonly onText: (text: string) => void = (text) => process.stdout.write(text)
  ) {}

  public async start(): Promise<void> {
    // Session creation is lazy because the task supplies the module cwd.
  }

  private async ensureSession(task: TaskEnvelope): Promise<AgentSession> {
    if (this.session) {
      if (this.workingDirectory !== task.workingDirectory) {
        throw new Error(`Worker ${this.workerName} is already bound to ${this.workingDirectory}`);
      }
      return this.session;
    }

    this.modelRuntime = await ModelRuntime.create({ refreshOnCreate: false });
    if (this.providerConfig) this.modelRuntime.registerProvider(this.providerId, this.providerConfig);
    const resourceLoader = new DefaultResourceLoader({
      cwd: task.workingDirectory,
      agentDir: join(task.workingDirectory, ".pi-agent"),
      appendSystemPromptOverride: (base) => [
        ...base,
        `You are the ${this.workerName} module worker. Read these files before acting: ${task.contextFiles.join(", ")}.`,
        `Only modify paths allowed by the task: ${task.allowedPaths.join(", ")}.`,
        "At the end, summarize changed files, tests, risks, and cross-module messages."
      ]
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd: task.workingDirectory,
      resourceLoader,
      sessionManager: SessionManager.inMemory(),
      modelRuntime: this.modelRuntime
    });
    this.session = session;
    this.workingDirectory = task.workingDirectory;
    this.unsubscribe = session.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        this.onText(event.assistantMessageEvent.delta);
      }
    });
    if (this.requestedModel) await this.applyModel(this.requestedModel);
    if (this.requestedThinkingLevel) this.applyThinkingLevel(this.requestedThinkingLevel);
    if (this.selectedModelId) await this.applyModel(`${this.providerId}/${this.selectedModelId}`);
    return session;
  }

  private async applyModel(specifier: string): Promise<string> {
    if (!this.session) {
      this.requestedModel = specifier;
      return `模型将在首次任务建立会话后切换为 ${specifier}`;
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

  public async setModel(specifier: string): Promise<string> {
    return this.applyModel(specifier.trim());
  }

  public async configureProvider(providerId: string, config: unknown, modelId?: string): Promise<string> {
    this.providerId = providerId;
    this.providerConfig = config as Parameters<ModelRuntime["registerProvider"]>[1];
    this.selectedModelId = modelId;
    if (this.modelRuntime) {
      this.modelRuntime.registerProvider(providerId, this.providerConfig);
      if (modelId) await this.applyModel(`${providerId}/${modelId}`);
    }
    return `provider 已配置，接口：${this.providerConfig.api ?? "默认"}${modelId ? `；模型：${modelId}` : ""}`;
  }

  public listModels(): string[] {
    return this.providerConfig?.models?.map((model) => model.id) ?? [];
  }

  private applyThinkingLevel(level: string): string {
    const normalized = level.trim().toLowerCase();
    if (!THINKING_LEVELS.includes(normalized)) throw new Error(`thinking level 应为：${THINKING_LEVELS.join(", ")}`);
    if (!this.session) {
      this.requestedThinkingLevel = normalized;
      return `thinking level 将在首次任务建立会话后切换为 ${normalized}`;
    }
    this.session.setThinkingLevel(normalized as never);
    this.requestedThinkingLevel = normalized;
    return `当前 thinking level：${normalized}`;
  }

  public async setThinkingLevel(level: string): Promise<string> {
    return this.applyThinkingLevel(level);
  }

  public status(): string {
    if (!this.session) return "Pi 会话尚未建立（将在第一个任务时建立）";
    const model = this.session.model;
    const modelName = model ? `${model.provider}/${model.id}` : "未选择";
    return `模型：${modelName}；thinking：${this.session.thinkingLevel}`;
  }

  public async run(task: TaskEnvelope): Promise<WorkerResult> {
    const session = await this.ensureSession(task);
    await session.prompt([
      `Task ${task.taskId}: ${task.goal}`,
      `Related modules: ${task.relatedModules.join(", ") || "none"}`,
      `Required tests: ${task.requiredTests.join(", ")}`
    ].join("\n"));

    return {
      taskId: task.taskId,
      module: task.module,
      status: "completed",
      changedFiles: [],
      tests: task.requiredTests.map((command) => ({ command, status: "skipped" })),
      risks: ["Pi response parsing and changed-file collection are not automated in the prototype."],
      messages: []
    };
  }

  public async close(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.session?.dispose();
    this.session = undefined;
    this.workingDirectory = undefined;
    this.requestedModel = undefined;
    this.requestedThinkingLevel = undefined;
    this.modelRuntime = undefined;
    this.providerConfig = undefined;
    this.providerId = "models-dev";
    this.selectedModelId = undefined;
  }
}
