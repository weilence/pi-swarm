import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { KnownApi, ThinkingLevelMap } from "@earendil-works/pi-ai";
import { getApiProviders } from "@earendil-works/pi-ai/compat";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getUserDataDir } from "../core/userdata.ts";

export type { KnownApi };

/** API types offered in the picker, derived from Pi's runtime api registry. */
export const PI_API_TYPES: readonly KnownApi[] = getApiProviders().map((provider) => provider.api as KnownApi);

export interface ModelsDevReasoningOption {
  type: string;
  values?: (string | null)[];
  min?: number;
  max?: number;
}

export interface ModelsDevModel {
  id: string;
  name?: string;
  description?: string;
  family?: string;
  reasoning?: boolean;
  reasoning_options?: ModelsDevReasoningOption[];
  /** Where interleaved reasoning arrives; pi-ai reads all known fields natively. */
  interleaved?: boolean | { field?: string };
  tool_call?: boolean;
  status?: string;
  experimental?: boolean;
  knowledge?: string;
  release_date?: string;
  modalities?: { input?: string[]; output?: string[] };
  limit?: { context?: number; output?: number };
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
  /** Per-model routing override used by aggregators. */
  provider?: { npm?: string; api?: string };
}

export interface ModelsDevProvider {
  id: string;
  name?: string;
  api?: string;
  npm?: string;
  env?: string[];
  doc?: string;
  models: Record<string, ModelsDevModel>;
}

export interface CatalogUpdateInfo {
  source: "network" | "cache" | "refresh" | "refresh-failed";
  count: number;
  /** True when the provider list changed (first fetch counts as a change). */
  updated: boolean;
  error?: unknown;
}

export interface ModelsDevCatalogOptions {
  endpoint?: string;
  /** On-disk cache file; defaults to <user data dir>/models-dev.json (see getUserDataDir). */
  cacheFile?: string;
  onUpdate?: (info: CatalogUpdateInfo) => void;
}

interface CachePayload {
  fetchedAt: number;
  providers: ModelsDevProvider[];
  etag?: string;
}

/**
 * models.dev catalog with stale-while-revalidate caching:
 * a disk cache is served instantly while a background fetch checks for updates,
 * so pickers never wait on the network after the first run.
 */
export class ModelsDevCatalog {
  private providers?: ModelsDevProvider[];
  private etag?: string;
  private inflight?: Promise<ModelsDevProvider[]>;
  private revalidating = false;
  private readonly endpoint: string;
  private readonly cacheFile: string;
  private readonly onUpdate?: (info: CatalogUpdateInfo) => void;

  public constructor(options: ModelsDevCatalogOptions = {}) {
    this.endpoint = options.endpoint ?? "https://models.dev/api.json";
    this.cacheFile = options.cacheFile ?? join(getUserDataDir(), "models-dev.json");
    this.onUpdate = options.onUpdate;
  }

  public async load(): Promise<ModelsDevProvider[]> {
    if (this.providers) return [...this.providers];
    this.inflight ??= this.loadUncached().finally(() => {
      this.inflight = undefined;
    });
    return await this.inflight;
  }

  public async get(id: string): Promise<ModelsDevProvider> {
    const provider = (await this.load()).find((candidate) => candidate.id === id);
    if (!provider) throw new Error(`models.dev 中找不到 provider：${id}`);
    return provider;
  }

  /** Warm the catalog at startup; failures stay silent until the data is actually needed. */
  public async prefetch(): Promise<void> {
    try {
      await this.load();
    } catch {
      // surfaced by load() when a command really needs the catalog
    }
  }

  private async loadUncached(): Promise<ModelsDevProvider[]> {
    const cached = await this.readCache();
    if (cached) {
      this.providers = cached.providers;
      this.etag = cached.etag;
      this.onUpdate?.({ source: "cache", count: cached.providers.length, updated: false });
      void this.revalidate();
      return [...this.providers];
    }
    return await this.fetchAndStore();
  }

  /**
   * Background freshness check, at most once per process. Sends the cached
   * ETag as `If-None-Match`: a 304 settles "no update" without transferring
   * the body; a 200 falls back to a full deep comparison of the payload.
   */
  private async revalidate(): Promise<void> {
    if (this.revalidating) return;
    this.revalidating = true;
    try {
      const { notModified, providers, etag } = await this.fetchProviders(this.etag);
      if (notModified) {
        this.onUpdate?.({ source: "refresh", count: this.providers?.length ?? 0, updated: false });
        return;
      }
      const changed = !this.providers || JSON.stringify(providers) !== JSON.stringify(this.providers);
      if (changed) this.providers = providers;
      if (changed || etag !== this.etag) {
        this.etag = etag;
        await this.writeCache(this.providers!, etag);
      }
      this.onUpdate?.({ source: "refresh", count: providers.length, updated: changed });
    } catch (error) {
      this.onUpdate?.({ source: "refresh-failed", count: this.providers?.length ?? 0, updated: false, error });
    } finally {
      this.revalidating = false;
    }
  }

  private async fetchAndStore(): Promise<ModelsDevProvider[]> {
    const { providers, etag } = await this.fetchProviders();
    this.providers = providers;
    this.etag = etag;
    await this.writeCache(providers, etag);
    this.onUpdate?.({ source: "network", count: providers.length, updated: true });
    return [...providers];
  }

  private async fetchProviders(ifNoneMatch?: string): Promise<{
    notModified: boolean;
    providers: ModelsDevProvider[];
    etag?: string;
  }> {
    const response = await fetch(this.endpoint, {
      signal: AbortSignal.timeout(15_000),
      ...(ifNoneMatch ? { headers: { "if-none-match": ifNoneMatch } } : {})
    });
    if (response.status === 304) return { notModified: true, providers: [] };
    if (!response.ok) throw new Error(`models.dev 请求失败：HTTP ${response.status}`);
    const raw = await response.json();
    if (typeof raw !== "object" || raw === null) throw new Error("models.dev 响应格式异常");
    const providers = Object.entries(raw as Record<string, Omit<ModelsDevProvider, "id">>).map(([id, provider]) => ({
      id,
      ...provider
    }));
    return { notModified: false, providers, etag: response.headers.get("etag") ?? undefined };
  }

  private async readCache(): Promise<CachePayload | undefined> {
    try {
      const payload = JSON.parse(await readFile(this.cacheFile, "utf8")) as CachePayload;
      const valid =
        typeof payload.fetchedAt === "number" &&
        Array.isArray(payload.providers) &&
        payload.providers.every((provider) => typeof provider?.id === "string" && typeof provider?.models === "object") &&
        (payload.etag === undefined || typeof payload.etag === "string");
      if (!valid) return undefined;
      return { fetchedAt: payload.fetchedAt, providers: payload.providers, etag: payload.etag };
    } catch {
      return undefined;
    }
  }

  private async writeCache(providers: ModelsDevProvider[], etag?: string): Promise<void> {
    const payload: CachePayload = { fetchedAt: Date.now(), providers, etag };
    await mkdir(dirname(this.cacheFile), { recursive: true });
    const tmpFile = `${this.cacheFile}.${process.pid}.tmp`;
    await writeFile(tmpFile, JSON.stringify(payload), "utf8");
    await rename(tmpFile, this.cacheFile);
  }
}

/**
 * models.dev `npm` (AI SDK package) → Pi `KnownApi` mapping, exact package
 * name match. Packages not listed (community OpenAI-compatible providers)
 * fall back to `openai-completions`.
 */
const NPM_API_RULES: Readonly<Record<string, KnownApi>> = {
  "@ai-sdk/anthropic": "anthropic-messages",
  "@ai-sdk/amazon-bedrock": "bedrock-converse-stream",
  "@ai-sdk/google-vertex": "google-vertex",
  "@ai-sdk/google": "google-generative-ai",
  "@ai-sdk/azure": "azure-openai-responses",
  "@ai-sdk/mistral": "mistral-conversations",
  "@ai-sdk/openai": "openai-responses"
};

const DEFAULT_API: KnownApi = "openai-completions";

/** models.dev effort value → Pi thinking level; "none" means reasoning off. */
const EFFORT_TO_PI_LEVEL: Readonly<Record<string, keyof ThinkingLevelMap>> = {
  none: "off",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max"
};

const PI_THINKING_LEVELS: readonly (keyof ThinkingLevelMap)[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * Builds a Pi thinkingLevelMap from models.dev reasoning_options. Effort-style
 * options pass their provider value through 1:1 (none → off); Pi levels the
 * model does not list are marked null (unsupported). Toggle- or budget-token-
 * only models return undefined so Pi provider defaults keep applying.
 */
export function toThinkingLevelMap(model: ModelsDevModel): ThinkingLevelMap | undefined {
  const effort = model.reasoning_options?.find((option) => option.type === "effort");
  const values = effort?.values ?? [];
  const map: ThinkingLevelMap = {};
  for (const value of values) {
    const level = value === null ? undefined : EFFORT_TO_PI_LEVEL[value];
    if (level) map[level] = value;
  }
  if (Object.keys(map).length === 0) return undefined;
  for (const level of PI_THINKING_LEVELS) {
    if (map[level] === undefined) map[level] = null;
  }
  return map;
}

export function inferPiApi(provider: ModelsDevProvider, override?: KnownApi): KnownApi {
  if (override) return override;
  return npmToApi(provider.npm);
}

function npmToApi(npm?: string): KnownApi {
  return NPM_API_RULES[npm ?? ""] ?? DEFAULT_API;
}

/** Validates the API type given to `/provider <id> <api>`: exact KnownApi id or nothing. */
export function parsePiApi(value?: string): KnownApi | undefined {
  if (!value) return undefined;
  const parsed = PI_API_TYPES.find((api) => api === value);
  if (!parsed) throw new Error(`不支持的 Pi 接口类型：${value}（可选：${PI_API_TYPES.join(", ")}）`);
  return parsed;
}

/**
 * models.dev interleaved reasoning → Pi compat flags. pi-ai already reads all
 * known reasoning delta fields natively, so only the replay side needs a flag:
 * endpoints emitting reasoning_content (deepseek/zai style) require replayed
 * assistant messages to carry an empty reasoning_content field.
 */
function toModelCompat(model: ModelsDevModel, api: KnownApi): Record<string, unknown> | undefined {
  if (api !== "openai-completions") return undefined;
  return typeof model.interleaved === "object" && model.interleaved.field === "reasoning_content"
    ? { requiresReasoningContentOnAssistantMessages: true }
    : undefined;
}

export function toPiProviderConfig(provider: ModelsDevProvider, api?: KnownApi) {
  const selectedApi = inferPiApi(provider, api);
  const envKey = provider.env?.[0];
  return {
    name: provider.name ?? provider.id,
    baseUrl: provider.api,
    api: selectedApi,
    ...(envKey ? { apiKey: `$${envKey}` } : {}),
    models: Object.values(provider.models)
      .filter((model) => !model.modalities?.output || model.modalities.output.includes("text"))
      .map((model) => {
        // Aggregator models may route to a different protocol/endpoint than
        // their parent provider (models.dev per-model provider override).
        const overrideApi = model.provider?.npm ? npmToApi(model.provider.npm) : undefined;
        const modelApi = overrideApi ?? selectedApi;
        const compat = toModelCompat(model, modelApi);
        return {
          id: model.id,
          name: model.name ?? model.id,
          api: modelApi,
          ...(model.provider?.api ? { baseUrl: model.provider.api } : {}),
          reasoning: model.reasoning ?? false,
          input: (model.modalities?.input?.includes("image") ? ["text", "image"] : ["text"]) as ("text" | "image")[],
          contextWindow: model.limit?.context ?? 128000,
          maxTokens: model.limit?.output ?? 16384,
          thinkingLevelMap: toThinkingLevelMap(model),
          ...(compat ? { compat } : {}),
          cost: {
            input: model.cost?.input ?? 0,
            output: model.cost?.output ?? 0,
            cacheRead: model.cost?.cache_read ?? 0,
            cacheWrite: model.cost?.cache_write ?? 0
          }
        };
      })
  } satisfies Parameters<ModelRuntime["registerProvider"]>[1];
}
