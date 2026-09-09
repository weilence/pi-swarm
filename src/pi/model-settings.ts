import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { clampThinkingLevel, getSupportedThinkingLevels, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { AgentConfigSnapshot, ConfigStore } from "../core/config/config-store.ts";
import { DEFAULT_PROVIDER_ID } from "../models-dev/catalog.ts";

/** Provider 注册配置（ModelRuntime.registerProvider 的入参形状）。 */
export type ProviderConfig = Parameters<ModelRuntime["registerProvider"]>[1];

/** thinking 校验/兜底所需的模型实例表面（Pi 的 Model 与 getModel 返回值都满足）。 */
export type ThinkingModel = Parameters<typeof getSupportedThinkingLevels>[0];

/**
 * Agent 的模型配置状态：provider、待生效模型偏好、thinking level、手动上下文
 * 容量，以及它们的持久化快照。纯粹的“待生效偏好 + 落盘”，不接触会话——把
 * 偏好应用到会话/运行时是 Agent 门面的职责。
 */
export class ModelSettings {
  private snapshot: AgentConfigSnapshot = {};
  private _providerId = DEFAULT_PROVIDER_ID;
  private _providerConfig?: ProviderConfig;
  private requestedModel?: string;
  private requestedThinkingLevel?: ModelThinkingLevel;
  /** 手动上下文容量（token）：覆盖模型自带 contextWindow；undefined = 模型默认。 */
  private contextWindowOverride?: number;

  public constructor(private readonly store?: ConfigStore) {}

  public get providerId(): string {
    return this._providerId;
  }

  public get providerConfig(): ProviderConfig | undefined {
    return this._providerConfig;
  }

  /** 当前全局默认模型（provider/model）待生效偏好。 */
  public get model(): string | undefined {
    return this.requestedModel;
  }

  public get thinkingLevel(): ModelThinkingLevel | undefined {
    return this.requestedThinkingLevel;
  }

  public get contextWindow(): number | undefined {
    return this.contextWindowOverride;
  }

  /** 最近一次持久化的快照（防御性浅拷贝），供状态行展示。 */
  public get saved(): AgentConfigSnapshot {
    return { ...this.snapshot };
  }

  public setProvider(id: string, config: ProviderConfig): void {
    this._providerId = id;
    this._providerConfig = config;
  }

  public setModel(specifier: string | undefined): void {
    this.requestedModel = specifier;
  }

  /** 切 provider 时作废属于上一个 provider 的模型偏好。 */
  public invalidateForeignModel(providerId: string): void {
    if (this.requestedModel && !this.requestedModel.startsWith(`${providerId}/`)) {
      this.requestedModel = undefined;
    }
  }

  public setThinkingLevel(level: ModelThinkingLevel): void {
    this.requestedThinkingLevel = level;
  }

  public setContextWindow(tokens?: number): void {
    this.contextWindowOverride = tokens && tokens > 0 ? tokens : undefined;
  }

  /** provider/model 拆分；格式非法（缺分隔符或空段）返回 undefined。 */
  public static splitSpecifier(specifier: string): { provider: string; modelId: string } | undefined {
    const separator = specifier.indexOf("/");
    if (separator <= 0 || separator === specifier.length - 1) return undefined;
    return { provider: specifier.slice(0, separator), modelId: specifier.slice(separator + 1) };
  }

  /** 手动容量覆盖模型的 contextWindow（仅数据克隆，不修改共享模型表）。 */
  public patchModel<M extends { contextWindow: number }>(model: M): M {
    return this.contextWindowOverride ? { ...model, contextWindow: this.contextWindowOverride } : model;
  }

  /** Resolves the pending model preference via the given lookup; undefined when unset, malformed, or unknown. */
  public requestedModelInstance<M>(resolve: (provider: string, modelId: string) => M | undefined): M | undefined {
    const split = ModelSettings.splitSpecifier(this.requestedModel ?? "");
    if (!split) return undefined;
    return resolve(split.provider, split.modelId);
  }

  /** 校验并归一化 thinking level；模型不支持时抛错（错误文案即候选清单）。 */
  public validateThinkingLevel(level: string, model: ThinkingModel): ModelThinkingLevel {
    const normalized = level.trim().toLowerCase() as ModelThinkingLevel;
    const supported = getSupportedThinkingLevels(model);
    if (!supported.includes(normalized)) {
      throw new Error(`当前模型支持的 thinking level：${supported.join(", ")}`);
    }
    return normalized;
  }

  /**
   * 会话打开后的 thinking 兜底：显式偏好 > 拉取的全局默认（clamp 到模型支持
   * 范围）> 模型最高支持档。
   */
  public resolveThinkingDefault(model: ThinkingModel, pulled?: ModelThinkingLevel): ModelThinkingLevel {
    const requested = this.requestedThinkingLevel ?? pulled;
    const supported = getSupportedThinkingLevels(model);
    return requested ? clampThinkingLevel(model, requested) : supported[supported.length - 1];
  }

  /** 合并进快照并持久化；未接入 configStore 时只更新内存状态。 */
  public async persist(update: Partial<AgentConfigSnapshot>): Promise<void> {
    this.snapshot = { ...this.snapshot, ...update };
    await this.store?.save(this.snapshot);
  }

  /** 恢复流程的起点：把读到的持久化快照采纳为当前状态基线。 */
  public adopt(saved: AgentConfigSnapshot): void {
    this.snapshot = { ...saved };
  }

  /**
   * close() 时的状态复位。快照与容量覆盖刻意保留：close 只释放运行资源
   * （会话、运行时、provider 注册），配置历史不抹除。
   */
  public reset(): void {
    this._providerId = DEFAULT_PROVIDER_ID;
    this._providerConfig = undefined;
    this.requestedModel = undefined;
    this.requestedThinkingLevel = undefined;
  }
}

/** Masks a key for logs and status lines: keeps a short head and tail. */
export function maskKey(key: string): string {
  return key.length <= 8 ? "***" : `${key.slice(0, 3)}...${key.slice(-4)}`;
}
