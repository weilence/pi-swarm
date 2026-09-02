import { THINKING_LEVELS } from "../core/worker.ts";
import type { ConfigurableModuleWorker } from "../core/worker.ts";
import type { ModuleDefinition, TaskEnvelope, WorkerResult } from "../protocol/contracts.ts";
import {
  PI_API_TYPES,
  inferPiApi,
  parsePiApi,
  toPiProviderConfig,
  type KnownApi,
  type ModelsDevProvider
} from "../models-dev/catalog.ts";
import type { PickerOption } from "./picker-logic.ts";

/** Minimal catalog surface so tests can stub out models.dev. */
export interface ProviderCatalog {
  load(): Promise<ModelsDevProvider[]>;
}

/** Minimal supervisor surface used by the CLI; the real Supervisor satisfies it structurally. */
export interface TaskDispatcher {
  dispatch(tasks: TaskEnvelope[]): Promise<WorkerResult[]>;
}

export interface CommandServices {
  worker: ConfigurableModuleWorker;
  catalog: ProviderCatalog;
  log: (line: string) => void;
  /** Interactive selection; resolves to undefined when cancelled or unavailable. */
  pick: <T>(title: string, options: readonly PickerOption<T>[]) => Promise<T | undefined>;
  interactive: boolean;
  supervisor?: TaskDispatcher;
  module?: ModuleDefinition;
}

export interface CommandState {
  selectedProvider?: ModelsDevProvider;
  taskNumber: number;
}

export type CommandOutcome = "exit" | "continue";

export async function executeCommand(line: string, services: CommandServices, state: CommandState): Promise<CommandOutcome> {
  const goal = line.trim();
  if (!goal) return "continue";
  if (goal === "/exit" || goal === "/quit") return "exit";
  if (goal === "/status") {
    services.log(`[主 agent] ${services.worker.status?.() ?? "当前 Worker 不支持运行时状态查询"}`);
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
            keywords: provider.npm
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
    services.log(`[主 agent] ${await services.worker.configureProvider?.(provider.id, config) ?? "当前 Worker 不支持 provider 配置"}`);
    state.selectedProvider = provider;

    if (services.interactive) {
      const modelId = await pickModel(provider, services);
      if (modelId !== undefined) await applyModel(modelId, services, state);
      else services.log("[主 agent] 已跳过模型选择，可用 /model 随时切换。");
      return;
    }
    services.log(`[主 agent] 可用模型：${Object.values(provider.models).map((model) => model.id).join(", ")}`);
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
    services.log(`[主 agent] ${Object.values(state.selectedProvider.models).map((model) => `${model.id} (${model.name ?? model.id})`).join(", ")}`);
    return;
  }
  await applyModel(modelId, services, state);
}

async function pickModel(provider: ModelsDevProvider, services: CommandServices): Promise<string | undefined> {
  return await services.pick(
    `选择模型（${provider.id}）`,
    Object.values(provider.models).map((model) => ({
      value: model.id,
      label: model.id,
      hint: model.name,
      keywords: model.reasoning ? "reasoning" : undefined
    }))
  );
}

async function applyModel(modelId: string, services: CommandServices, state: CommandState): Promise<void> {
  if (state.selectedProvider && !modelId.includes("/")) {
    if (!state.selectedProvider.models[modelId]) {
      services.log(`[主 agent] provider ${state.selectedProvider.id} 没有模型：${modelId}`);
      return;
    }
    try {
      services.log(`[主 agent] ${await services.worker.setModel?.(`${state.selectedProvider.id}/${modelId}`) ?? "当前 Worker 不支持模型切换"}`);
    } catch (error) {
      services.log(`[主 agent] 模型切换失败：${error instanceof Error ? error.message : String(error)}`);
    }
    return;
  }
  try {
    services.log(`[主 agent] ${await services.worker.setModel?.(modelId) ?? "当前 Worker 不支持运行时模型切换"}`);
  } catch (error) {
    services.log(`[主 agent] 模型切换失败：${error instanceof Error ? error.message : String(error)}`);
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
    services.log(`[主 agent] ${await services.worker.setThinkingLevel?.(level) ?? "当前 Worker 不支持运行时 thinking 切换"}`);
  } catch (error) {
    services.log(`[主 agent] thinking 切换失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function dispatchTask(goal: string, services: CommandServices, state: CommandState): Promise<void> {
  if (!services.supervisor || !services.module) {
    services.log("[主 agent] 任务派发未配置。");
    return;
  }
  state.taskNumber += 1;
  const task: TaskEnvelope = {
    taskId: `T-${String(state.taskNumber).padStart(3, "0")}`,
    module: services.module.id,
    goal,
    workingDirectory: services.module.path,
    contextFiles: services.module.contextFiles,
    allowedPaths: services.module.allowedPaths,
    relatedModules: [],
    requiredTests: [services.module.testCommand, services.module.contractCommand]
  };

  try {
    const [result] = await services.supervisor.dispatch([task]);
    services.log(`[主 agent] ${result.status}：${result.module}，变更 ${result.changedFiles.length} 个文件。`);
  } catch (error) {
    services.log(`[主 agent] 任务失败：${error instanceof Error ? error.message : String(error)}`);
  }
}
