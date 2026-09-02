import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

export type PiApi = "anthropic-messages" | "openai-completions" | "openai-responses" | "google-generative-ai" | "openai-codex-responses" | "azure-openai-responses" | "google-vertex" | "mistral-conversations" | "bedrock-converse-stream" | "pi-messages";

export interface ModelsDevModel {
  id: string;
  name?: string;
  reasoning?: boolean;
  modalities?: { input?: string[] };
  limit?: { context?: number; output?: number };
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
}

export interface ModelsDevProvider {
  id: string;
  name?: string;
  api?: string;
  npm?: string;
  env?: string[];
  models: Record<string, ModelsDevModel>;
}

export class ModelsDevCatalog {
  private providers?: ModelsDevProvider[];

  public constructor(private readonly endpoint = "https://models.dev/api.json") {}

  public async load(): Promise<ModelsDevProvider[]> {
    if (this.providers) return [...this.providers];
    const response = await fetch(this.endpoint);
    if (!response.ok) throw new Error(`models.dev 请求失败：HTTP ${response.status}`);
    const raw = await response.json() as Record<string, Omit<ModelsDevProvider, "id">>;
    this.providers = Object.entries(raw).map(([id, provider]) => ({ id, ...provider }));
    return [...this.providers];
  }

  public async get(id: string): Promise<ModelsDevProvider> {
    const provider = (await this.load()).find((candidate) => candidate.id === id);
    if (!provider) throw new Error(`models.dev 中找不到 provider：${id}`);
    return provider;
  }
}

export function inferPiApi(provider: ModelsDevProvider, override?: PiApi): PiApi {
  if (override) return override;
  const npm = provider.npm ?? "";
  if (npm.includes("anthropic")) return "anthropic-messages";
  if (npm.includes("google")) return "google-generative-ai";
  if (npm.includes("responses")) return "openai-responses";
  return "openai-completions";
}

export function parsePiApi(value?: string): PiApi | undefined {
  if (!value) return undefined;
  const aliases: Record<string, PiApi> = {
    anthropic: "anthropic-messages",
    "anthropic-messages": "anthropic-messages",
    openai: "openai-completions",
    "openai-completions": "openai-completions",
    responses: "openai-responses",
    "openai-responses": "openai-responses",
    codex: "openai-codex-responses",
    "openai-codex-responses": "openai-codex-responses",
    azure: "azure-openai-responses",
    "azure-openai-responses": "azure-openai-responses",
    google: "google-generative-ai",
    "google-generative-ai": "google-generative-ai",
    vertex: "google-vertex",
    "google-vertex": "google-vertex",
    mistral: "mistral-conversations",
    "mistral-conversations": "mistral-conversations",
    bedrock: "bedrock-converse-stream",
    "bedrock-converse-stream": "bedrock-converse-stream",
    "pi-messages": "pi-messages"
  };
  const parsed = aliases[value.toLowerCase()];
  if (!parsed) throw new Error(`不支持的 Pi 接口类型：${value}`);
  return parsed;
}

export function toPiProviderConfig(provider: ModelsDevProvider, api?: PiApi) {
  const selectedApi = inferPiApi(provider, api);
  const envKey = provider.env?.[0];
  return {
    name: provider.name ?? provider.id,
    baseUrl: provider.api,
    api: selectedApi,
    ...(envKey ? { apiKey: `$${envKey}` } : {}),
    models: Object.values(provider.models).map((model) => ({
      id: model.id,
      name: model.name ?? model.id,
      api: selectedApi,
      reasoning: model.reasoning ?? false,
      input: (model.modalities?.input?.includes("image") ? ["text", "image"] : ["text"]) as ("text" | "image")[],
      contextWindow: model.limit?.context ?? 128000,
      maxTokens: model.limit?.output ?? 16384,
      cost: {
        input: model.cost?.input ?? 0,
        output: model.cost?.output ?? 0,
        cacheRead: model.cost?.cache_read ?? 0,
        cacheWrite: model.cost?.cache_write ?? 0
      }
    }))
  } satisfies Parameters<ModelRuntime["registerProvider"]>[1];
}
