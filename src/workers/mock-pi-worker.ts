import type { ConfigurableModuleWorker } from "../core/worker.ts";
import { THINKING_LEVELS } from "../core/worker.ts";
import type { TaskEnvelope, WorkerResult } from "../protocol/contracts.ts";

/** Prototype-only worker with in-memory runtime configuration, mirroring PiSdkWorker's surface. */
export class MockPiWorker implements ConfigurableModuleWorker {
  private started = false;
  private providerId?: string;
  private model?: string;
  private thinkingLevel = "off";

  public async start(): Promise<void> {
    this.started = true;
  }

  public async configureProvider(providerId: string, config: { api?: string }, modelId?: string): Promise<string> {
    this.providerId = providerId;
    if (modelId) this.model = `${providerId}/${modelId}`;
    return `provider 已配置（mock），接口：${config.api ?? "默认"}${modelId ? `；模型：${this.model}` : ""}`;
  }

  public async setModel(specifier: string): Promise<string> {
    this.model = specifier;
    return `当前模型（mock）：${specifier}`;
  }

  public async setThinkingLevel(level: string): Promise<string> {
    const normalized = level.trim().toLowerCase();
    if (!THINKING_LEVELS.includes(normalized)) throw new Error(`thinking level 应为：${THINKING_LEVELS.join(", ")}`);
    this.thinkingLevel = normalized;
    return `当前 thinking level（mock）：${normalized}`;
  }

  public status(): string {
    return `模型：${this.model ?? "未选择"}；thinking：${this.thinkingLevel}（mock worker）`;
  }

  public async run(task: TaskEnvelope): Promise<WorkerResult> {
    if (!this.started) await this.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    return {
      taskId: task.taskId,
      module: task.module,
      status: "completed",
      changedFiles: [`${task.module}/src/prototype-change.ts`],
      tests: task.requiredTests.map((command) => ({ command, status: "passed" })),
      risks: [],
      messages: []
    };
  }

  public close(): void {
    this.started = false;
  }
}
