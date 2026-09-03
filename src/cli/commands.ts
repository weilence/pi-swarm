import { THINKING_LEVELS } from "../core/worker.ts";
import type { ConfigurableModuleWorker } from "../core/worker.ts";
import type { ModuleDefinition, WorkerResult } from "../protocol/contracts.ts";
import type { AgentDefinition } from "../core/agent-format.ts";
import { Orchestrator, type AgentBrain, type PlannedStep, type TaskDispatcher } from "../core/orchestrator.ts";
import {
  PI_API_TYPES,
  inferPiApi,
  parsePiApi,
  toPiProviderConfig,
  type KnownApi,
  type ModelsDevProvider
} from "../models-dev/catalog.ts";
/** One selectable row in an interactive picker. */
export interface PickerOption<T> {
  value: T;
  label: string;
  hint?: string;
  /** Extra searchable text, e.g. aliases. */
  keywords?: string;
}

/** Minimal catalog surface so tests can stub out models.dev. */
export interface ProviderCatalog {
  load(): Promise<ModelsDevProvider[]>;
}

/**
 * Runtime-configurable, model-backed supervisor agent: target of
 * /provider /model /thinking /apikey and the orchestrator's model brain.
 */
export interface AgentController extends AgentBrain {
  configureProvider?(providerId: string, config: unknown, modelId?: string): Promise<string>;
  setModel?(specifier: string): Promise<string>;
  setThinkingLevel?(level: string): Promise<string>;
  setApiKey?(key: string): Promise<string>;
  status?(): string;
}

export interface CommandServices {
  agent?: AgentController;
  worker?: ConfigurableModuleWorker;
  catalog: ProviderCatalog;
  log: (line: string) => void;
  /** Interactive selection; resolves to undefined when cancelled or unavailable. */
  pick: <T>(title: string, options: readonly PickerOption<T>[]) => Promise<T | undefined>;
  /** Interactive clarification channel used by the orchestrator. */
  askUser?: (question: string) => Promise<string>;
  interactive: boolean;
  supervisor?: TaskDispatcher;
  module?: ModuleDefinition;
  /** All registered modules offered to intent analysis and planning. */
  modules?: ModuleDefinition[];
  /** User-created agents available for dynamic routing. */
  agents?: { list(): AgentDefinition[] };
  /** Supervisor self-execution path when no agent matches a step. */
  selfExecute?: (step: PlannedStep) => Promise<WorkerResult>;
}

export interface CommandState {
  selectedProvider?: ModelsDevProvider;
  selectedModelId?: string;
}

export type CommandOutcome = "exit" | "continue";

export async function executeCommand(line: string, services: CommandServices, state: CommandState): Promise<CommandOutcome> {
  const goal = line.trim();
  if (!goal) return "continue";
  if (goal === "/exit" || goal === "/quit") return "exit";
  if (goal === "/status") {
    services.log(`[主 agent] supervisor：${services.agent?.status?.() ?? "状态不可用"}`);
    if (services.worker) {
      services.log(`[主 agent] worker：${services.worker.status?.() ?? "当前 Worker 不支持运行时状态查询"}`);
    }
    return "continue";
  }
  if (goal === "/provider" || goal.startsWith("/provider ")) {
    const [, providerId, apiName] = goal.split(/\s+/, 3);
    await commandProvider(providerId, apiName, services, state);
    return "continue";
  }
  if (goal === "/model") {
    await commandModel(undefined, services, state);
    return "continue";
  }
  if (goal.startsWith("/model ")) {
    await commandModel(goal.slice("/model ".length).trim(), services, state);
    return "continue";
  }
  if (goal === "/thinking") {
    await commandThinking(undefined, services);
    return "continue";
  }
  if (goal.startsWith("/thinking ")) {
    await commandThinking(goal.slice("/thinking ".length), services);
    return "continue";
  }
  if (goal === "/apikey" || goal.startsWith("/apikey ")) {
    await commandApiKey(goal.slice("/apikey".length).trim(), services, state);
    return "continue";
  }
  await dispatchTask(goal, services, state);
  return "continue";
}

async function commandProvider(
  providerId: string | undefined,
  apiName: string | undefined,
  services: CommandServices,
  state: CommandState
): Promise<void> {
  try {
    const providers = await services.catalog.load();
    if (!providerId) {
      if (services.interactive) {
        const picked = await services.pick(
          "选择 provider",
          providers.map((provider) => ({
            value: provider.id,
            label: provider.id,
            hint: provider.name,
            keywords: [provider.npm, provider.doc].filter(Boolean).join(" ")
          }))
        );
        if (picked === undefined) {
          services.log("[主 agent] 已取消 provider 选择。");
          return;
        }
        providerId = picked;
      } else {
        services.log(`[主 agent] providers：${providers.map((provider) => `${provider.id} (${provider.name ?? provider.id})`).join(", ")}`);
        return;
      }
    }

    const provider = providers.find((candidate) => candidate.id === providerId);
    if (!provider) throw new Error(`models.dev 中找不到 provider：${providerId}`);

    let api = parsePiApi(apiName);
    if (!apiName && services.interactive) {
      const apiOptions: PickerOption<KnownApi | "auto">[] = [
        { value: "auto", label: "自动（根据 provider 推断）", hint: inferPiApi(provider), keywords: "default auto" },
        ...PI_API_TYPES.map((candidate) => ({ value: candidate as KnownApi | "auto", label: candidate }))
      ];
      const pickedApi = await services.pick("选择接口类型", apiOptions);
      if (pickedApi !== undefined) api = pickedApi === "auto" ? undefined : pickedApi;
    }

    const config = toPiProviderConfig(provider, api);
    services.log(`[主 agent] ${await services.agent?.configureProvider?.(provider.id, config) ?? "当前 supervisor agent 不支持 provider 配置"}`);
    state.selectedProvider = provider;

    if (services.interactive) {
      const modelId = await pickModel(provider, services);
      if (modelId !== undefined) await applyModel(modelId, services, state);
      else services.log("[主 agent] 已跳过模型选择，可用 /model 随时切换。");
      return;
    }
    services.log(
      `[主 agent] 可用模型：${selectableModels(provider)
        .map((model) => {
          const badges = modelBadges(model);
          return badges.length > 0 ? `${model.id}（${badges.join("，")}）` : model.id;
        })
        .join(", ")}`
    );
  } catch (error) {
    services.log(`[主 agent] provider 配置失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function commandModel(modelId: string | undefined, services: CommandServices, state: CommandState): Promise<void> {
  if (!modelId) {
    if (!state.selectedProvider) {
      services.log("[主 agent] 请先使用 /provider <id> 选择 provider。");
      return;
    }
    if (services.interactive) {
      const picked = await pickModel(state.selectedProvider, services);
      if (picked === undefined) {
        services.log("[主 agent] 已取消模型选择。");
        return;
      }
      await applyModel(picked, services, state);
      return;
    }
    services.log(
      `[主 agent] ${selectableModels(state.selectedProvider)
        .map((model) => {
          const badges = modelBadges(model);
          return badges.length > 0 ? `${model.id} (${model.name ?? model.id}；${badges.join("，")})` : `${model.id} (${model.name ?? model.id})`;
        })
        .join(", ")}`
    );
    return;
  }
  await applyModel(modelId, services, state);
}

/** models.dev status/lifecycle shown next to the model id. */
function modelBadges(model: ModelsDevProvider["models"][string]): string[] {
  const badges: string[] = [];
  if (model.experimental) badges.push("experimental");
  if (model.tool_call === false) badges.push("无工具调用");
  if (model.knowledge) badges.push(`知识截止 ${model.knowledge}`);
  return badges;
}

function selectableModels(provider: ModelsDevProvider): ModelsDevProvider["models"][string][] {
  return Object.values(provider.models).filter((model) => model.status !== "deprecated");
}

async function pickModel(provider: ModelsDevProvider, services: CommandServices): Promise<string | undefined> {
  return await services.pick(
    `选择模型（${provider.id}）`,
    selectableModels(provider).map((model) => {
      const badges = modelBadges(model);
      return {
        value: model.id,
        label: model.id,
        hint: [model.name, ...badges].filter(Boolean).join(" · "),
        keywords: [model.description, model.family, model.release_date, ...(model.reasoning ? ["reasoning"] : [])]
          .filter(Boolean)
          .join(" ")
      };
    })
  );
}

async function applyModel(modelId: string, services: CommandServices, state: CommandState): Promise<void> {
  if (state.selectedProvider && !modelId.includes("/")) {
    if (!state.selectedProvider.models[modelId]) {
      services.log(`[主 agent] provider ${state.selectedProvider.id} 没有模型：${modelId}`);
      return;
    }
    state.selectedModelId = modelId;
    try {
      services.log(`[主 agent] ${await services.agent?.setModel?.(`${state.selectedProvider.id}/${modelId}`) ?? "当前 supervisor agent 不支持模型切换"}`);
    } catch (error) {
      services.log(`[主 agent] 模型切换失败：${error instanceof Error ? error.message : String(error)}`);
    }
    return;
  }
  state.selectedModelId = undefined;
  try {
    services.log(`[主 agent] ${await services.agent?.setModel?.(modelId) ?? "当前 supervisor agent 不支持运行时模型切换"}`);
  } catch (error) {
    services.log(`[主 agent] 模型切换失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function commandApiKey(key: string | undefined, services: CommandServices, state: CommandState): Promise<void> {
  if (!key) {
    const provider = state.selectedProvider;
    const envHint = provider?.env?.[0]
      ? `provider ${provider.id} 默认从环境变量 ${provider.env[0]} 读取密钥；`
      : provider
        ? `provider ${provider.id} 在 models.dev 未登记环境变量；`
        : "";
    services.log(`[主 agent] ${envHint}用法：/apikey <key>。密钥以明文保存在用户数据目录的 config.json。`);
    return;
  }
  try {
    services.log(`[主 agent] ${await services.agent?.setApiKey?.(key) ?? "当前 supervisor agent 不支持 API key 配置"}`);
  } catch (error) {
    services.log(`[主 agent] API key 配置失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function commandThinking(level: string | undefined, services: CommandServices): Promise<void> {
  if (!level) {
    if (services.interactive) {
      const picked = await services.pick("选择 thinking level", THINKING_LEVELS.map((candidate) => ({ value: candidate, label: candidate })));
      if (picked === undefined) {
        services.log("[主 agent] 已取消 thinking 切换。");
        return;
      }
      level = picked;
    } else {
      services.log(`[主 agent] thinking level 可选：${THINKING_LEVELS.join(", ")}`);
      return;
    }
  }
  try {
    services.log(`[主 agent] ${await services.agent?.setThinkingLevel?.(level) ?? "当前 supervisor agent 不支持运行时 thinking 切换"}`);
  } catch (error) {
    services.log(`[主 agent] thinking 切换失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function dispatchTask(goal: string, services: CommandServices, _state: CommandState): Promise<void> {
  if (!services.supervisor || !services.module || !services.modules) {
    services.log("[主 agent] 任务派发未配置。");
    return;
  }
  const orchestrator = new Orchestrator({
    agent: services.agent,
    supervisor: services.supervisor,
    modules: services.modules,
    defaultModule: services.module.id,
    agents: services.agents,
    selfExecute: services.selfExecute,
    askUser: services.askUser,
    log: services.log
  });
  await orchestrator.run(goal);
}
