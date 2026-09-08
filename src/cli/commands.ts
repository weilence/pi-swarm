import type { AgentDefinition } from "../core/agent-format.ts";
import type { SessionManager } from "../core/session/session-manager.ts";
import { SessionBusyError, SessionClosedError, SessionNotFoundError } from "../core/session/session-types.ts";
import type { TuiRepl } from "./tui-repl.ts";
import type { AgentStatusSnapshot } from "../pi/agent.ts";
import type { ToastLevel } from "./components.ts";
import { replayHistory } from "./history-replay.ts";
import { fuzzyFilter, type AutocompleteItem, type SlashCommand } from "@earendil-works/pi-tui";
import type { SessionManager as PiSessionManager } from "@earendil-works/pi-coding-agent";
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
  /** 当前正在使用的一项：排到最前、加 ● 标记并预选中。 */
  current?: boolean;
}

/** Minimal catalog surface so tests can stub out models.dev. */
export interface ProviderCatalog {
  load(): Promise<ModelsDevProvider[]>;
}

/**
 * Runtime-configurable, model-backed supervisor agent: target of
 * /provider /model /thinking /apikey; runs user tasks through its own
 * model-driven loop (runTask).
 */
export interface AgentController {
  configureProvider?(providerId: string, config: unknown, modelId?: string): Promise<string>;
  setModel?(specifier: string): Promise<string>;
  /** 当前模型支持的 thinking level（升序）；未选模型时为空。 */
  thinkingLevels?(): string[];
  setThinkingLevel?(level: string): Promise<string>;
  setApiKey?(key: string): Promise<string>;
  status?(): string;
  /** 结构化状态快照（编辑器下方状态栏）；缺省时状态栏保持占位文本。 */
  readonly statusSnapshot?: AgentStatusSnapshot;
  /** 把 AgentSession 重绑到指定 Pi 会话（/switch、任务物化使用）。 */
  rebind?(sessionManager: PiSessionManager): Promise<string>;
  /** 解除当前会话绑定回到草稿态（/new 使用）；待生效的模型/thinking 保留。 */
  detach?(): void;
  /** 手动设置上下文容量（token）；undefined 恢复模型默认。 */
  setContextWindow?(tokens?: number): Promise<string>;
  /** 手动压缩上下文；customInstructions 可选，指定摘要侧重点。 */
  compact?(customInstructions?: string): Promise<string>;
  /** 用户主动中止当前输出（双击 Esc）。 */
  abort?(): Promise<void>;
  /** prompt 流式输出进行中（此时拒绝切换会话）。 */
  isBusy?(): boolean;
  /** Runs one user task through the supervisor's model-driven loop. */
  runTask?(goal: string): Promise<string>;
}

export interface CommandServices {
  agent?: AgentController;
  catalog: ProviderCatalog;
  log: (line: string) => void;
  /** 瞬态提示通道（编辑器上方的 toast）；缺省时命令层回退到 log。 */
  notify?: (message: string, level?: ToastLevel) => void;
  /** 交互式 TUI；/switch 历史回放直接驱动它的组件（与实时显示同源）。 */
  repl?: TuiRepl;
  /** Interactive selection; resolves to undefined when cancelled or unavailable. */
  pick: <T>(title: string, options: readonly PickerOption<T>[]) => Promise<T | undefined>;
  interactive: boolean;
  /** User-created agents available for delegation. */
  agents?: { list(): AgentDefinition[] };
  /** 会话管理；提供后启用 /new /sessions /switch /close。 */
  sessions?: SessionManager;
}

export interface CommandState {
  selectedProvider?: ModelsDevProvider;
  selectedModelId?: string;
}

export type CommandOutcome = "exit" | "continue";

/**
 * 瞬态提示走 toast（显示在编辑器上方，自动消失，不进 transcript）；未接入
 * toast 的环境（非 TUI 模式、测试桩）回退为 transcript 日志，消息不丢。
 */
function hint(services: CommandServices, message: string, level: ToastLevel = "info"): void {
  if (services.notify) services.notify(message, level);
  else services.log(`[主 agent] ${message}`);
}

/**
 * 静态参数候选：按已输入的参数前缀模糊过滤（供 SLASH_COMMANDS 的
 * getArgumentCompletions 复用）。
 */
function staticArgCompletions(items: readonly AutocompleteItem[]): (prefix: string) => AutocompleteItem[] {
  return (prefix) => fuzzyFilter([...items], prefix, (item) => `${item.value} ${item.description ?? ""}`);
}

/**
 * 斜杠命令索引：编辑器补全提示（SlashAutocompleteProvider）的数据源，
 * 须与下方 executeCommand 的分发保持同步（含别名）。argumentHint 仅用于
 * 提示列展示；参数可枚举的命令可声明 getArgumentCompletions（如 /context）。
 */
export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: "exit", description: "退出 pi-swarm" },
  { name: "quit", description: "退出（/exit 别名）" },
  { name: "status", description: "查看 supervisor / 会话 / 子 agent 状态" },
  { name: "provider", argumentHint: "[id] [api]", description: "选择模型 provider 与接口类型" },
  { name: "model", argumentHint: "[provider/]model", description: "切换模型" },
  { name: "thinking", argumentHint: "[level]", description: "调整思考深度（thinking level）" },
  { name: "apikey", argumentHint: "<key>", description: "设置 API key（明文存于 config.json）" },
  {
    name: "context",
    argumentHint: "<tokens|reset>",
    description: "查看/设置上下文容量",
    getArgumentCompletions: staticArgCompletions([{ value: "reset", label: "reset", description: "恢复模型默认容量" }])
  },
  { name: "compact", argumentHint: "[侧重点]", description: "手动压缩上下文" },
  { name: "new", argumentHint: "[名称]", description: "新建会话（草稿，首次发送时创建）" },
  { name: "sessions", description: "列出全部会话" },
  { name: "ls", description: "列出全部会话（/sessions 别名）" },
  {
    name: "switch",
    argumentHint: "<id|序号|draft>",
    description: "切换会话",
    getArgumentCompletions: staticArgCompletions([{ value: "draft", label: "draft", description: "切到未保存草稿（等同 ＋ 新建）" }])
  },
  { name: "close", argumentHint: "[id|序号]", description: "关闭会话" },
  { name: "delete", argumentHint: "<id|序号>", description: "删除会话（含记录文件）" }
];

export async function executeCommand(line: string, services: CommandServices, state: CommandState): Promise<CommandOutcome> {
  const goal = line.trim();
  if (!goal) return "continue";
  if (goal === "/exit" || goal === "/quit") return "exit";
  if (goal === "/status") {
    services.log(`[主 agent] supervisor：${services.agent?.status?.() ?? "状态不可用"}`);
    if (services.sessions) {
      const draft = services.sessions.isDraft();
      const currentSession = services.sessions.current();
      services.log(
        draft
          ? "[主 agent] 当前会话：草稿（未保存；首次发送时创建）"
          : currentSession
            ? `[主 agent] 当前会话：${currentSession.name ?? currentSession.id}（${currentSession.id}）`
            : "[主 agent] 当前会话：无（输入任务将自动创建）"
      );
    }
    const agents = services.agents?.list() ?? [];
    services.log(
      agents.length > 0
        ? `[主 agent] 已加载 agents：${agents.map((agent) => agent.name).join(", ")}`
        : "[主 agent] 未加载任何子 agent，所有任务由 supervisor 自执行。"
    );
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
  if (goal === "/context" || goal.startsWith("/context ")) {
    await commandContext(goal.slice("/context".length).trim(), services);
    return "continue";
  }
  if (goal === "/compact" || goal.startsWith("/compact ")) {
    await commandCompact(goal.slice("/compact".length).trim(), services);
    return "continue";
  }
  if (goal === "/new" || goal.startsWith("/new ")) {
    await commandNew(goal.slice("/new".length).trim(), services);
    return "continue";
  }
  if (goal === "/sessions" || goal === "/ls") {
    await commandSessions(services);
    return "continue";
  }
  if (goal === "/switch" || goal.startsWith("/switch ")) {
    await commandSwitch(goal.slice("/switch".length).trim(), services);
    return "continue";
  }
  if (goal === "/close" || goal.startsWith("/close ")) {
    await commandClose(goal.slice("/close".length).trim(), services);
    return "continue";
  }
  if (goal === "/delete" || goal.startsWith("/delete ")) {
    await commandDelete(goal.slice("/delete".length).trim(), services);
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
        // 当前 provider 排最前并标记，其余保持 models.dev 原序；当前值优先取
        // 会话实时模型（statusSnapshot），回退到 /provider 待生效偏好。
        const currentProviderId =
          services.agent?.statusSnapshot?.model?.split("/")[0] ?? state.selectedProvider?.id;
        const ordered = [...providers].sort(
          (a, b) => Number(b.id === currentProviderId) - Number(a.id === currentProviderId)
        );
        const picked = await services.pick(
          "选择 provider",
          ordered.map((provider) => ({
            value: provider.id,
            label: provider.id,
            hint: provider.name,
            keywords: [provider.npm, provider.doc].filter(Boolean).join(" "),
            current: provider.id === currentProviderId
          }))
        );
        if (picked === undefined) {
          hint(services, "已取消 provider 选择。");
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
    hint(services, (await services.agent?.configureProvider?.(provider.id, config)) ?? "当前 supervisor agent 不支持 provider 配置");
    state.selectedProvider = provider;

    if (services.interactive) {
      const modelId = await pickModel(provider, services, state);
      if (modelId !== undefined) await applyModel(modelId, services, state);
      else hint(services, "已跳过模型选择，可用 /model 随时切换。");
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
    hint(services, `provider 配置失败：${error instanceof Error ? error.message : String(error)}`, "error");
  }
}

async function commandModel(modelId: string | undefined, services: CommandServices, state: CommandState): Promise<void> {
  if (!modelId) {
    if (!state.selectedProvider) {
      hint(services, "请先使用 /provider <id> 选择 provider。", "warning");
      return;
    }
    if (services.interactive) {
      const picked = await pickModel(state.selectedProvider, services, state);
      if (picked === undefined) {
        hint(services, "已取消模型选择。");
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

/** 当前（待）生效的模型 id：优先取会话实时值，回退到 /model 待生效偏好。 */
function currentModelId(provider: ModelsDevProvider, services: CommandServices, state: CommandState): string | undefined {
  const live = services.agent?.statusSnapshot?.model;
  if (live?.startsWith(`${provider.id}/`)) return live.slice(provider.id.length + 1);
  return state.selectedProvider?.id === provider.id ? state.selectedModelId : undefined;
}

async function pickModel(provider: ModelsDevProvider, services: CommandServices, state: CommandState): Promise<string | undefined> {
  // 当前模型排最前并标记，其余保持 models.dev 原序。
  const currentModel = currentModelId(provider, services, state);
  const ordered = [...selectableModels(provider)].sort(
    (a, b) => Number(b.id === currentModel) - Number(a.id === currentModel)
  );
  return await services.pick(
    `选择模型（${provider.id}）`,
    ordered.map((model) => {
      const badges = modelBadges(model);
      return {
        value: model.id,
        label: model.id,
        hint: [model.name, ...badges].filter(Boolean).join(" · "),
        keywords: [model.description, model.family, model.release_date, ...(model.reasoning ? ["reasoning"] : [])]
          .filter(Boolean)
          .join(" "),
        current: model.id === currentModel
      };
    })
  );
}

async function applyModel(modelId: string, services: CommandServices, state: CommandState): Promise<void> {
  if (state.selectedProvider && !modelId.includes("/")) {
    if (!state.selectedProvider.models[modelId]) {
      hint(services, `provider ${state.selectedProvider.id} 没有模型：${modelId}`, "warning");
      return;
    }
    state.selectedModelId = modelId;
    try {
      hint(services, (await services.agent?.setModel?.(`${state.selectedProvider.id}/${modelId}`)) ?? "当前 supervisor agent 不支持模型切换");
    } catch (error) {
      hint(services, `模型切换失败：${error instanceof Error ? error.message : String(error)}`, "error");
    }
    return;
  }
  state.selectedModelId = undefined;
  try {
    hint(services, (await services.agent?.setModel?.(modelId)) ?? "当前 supervisor agent 不支持运行时模型切换");
  } catch (error) {
    hint(services, `模型切换失败：${error instanceof Error ? error.message : String(error)}`, "error");
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
    hint(services, `${envHint}用法：/apikey <key>。密钥以明文保存在用户数据目录的 config.json。`);
    return;
  }
  try {
    hint(services, (await services.agent?.setApiKey?.(key)) ?? "当前 supervisor agent 不支持 API key 配置");
  } catch (error) {
    hint(services, `API key 配置失败：${error instanceof Error ? error.message : String(error)}`, "error");
  }
}

/** 解析 /context 容量参数：纯数字、nk、nw、nm（如 200k、20w、0.5m）。 */
function parseContextWindow(text: string): number | undefined {
  const match = text.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)([kwm])?$/);
  if (!match) return undefined;
  const multiplier = match[2] === "k" ? 1e3 : match[2] === "w" ? 1e4 : match[2] === "m" ? 1e6 : 1;
  return Math.round(Number.parseFloat(match[1]) * multiplier);
}

/**
 * 手动上下文容量（/context）：不带参数查看当前设置；<n|nk|nw|nm> 设置
 * （影响 Pi 自动压缩阈值与用量百分比）；reset 恢复模型默认。
 */
async function commandContext(arg: string, services: CommandServices): Promise<void> {
  const agent = services.agent;
  if (!agent?.setContextWindow) {
    hint(services, "当前 agent 不支持上下文容量设置。", "warning");
    return;
  }
  const text = arg.trim();
  if (!text) {
    const snapshot = agent.statusSnapshot;
    hint(
      services,
      snapshot?.contextWindow
        ? `当前上下文容量：${snapshot.contextWindow} tokens（已用 ${snapshot.contextTokens ?? 0}）。用 /context <n>[k|w|m] 调整，/context reset 恢复模型默认。`
        : "上下文容量跟随模型默认。用 /context <n>[k|w|m] 设置（如 /context 200k、/context 20w），/context reset 恢复默认。"
    );
    return;
  }
  if (text === "reset" || text === "默认") {
    hint(services, await agent.setContextWindow(undefined));
    return;
  }
  const tokens = parseContextWindow(text);
  if (tokens === undefined || tokens < 1024) {
    hint(services, "用法：/context <tokens|nk|nw|nm>（如 /context 200k、/context 20w），最小 1024；/context reset 恢复默认。", "warning");
    return;
  }
  hint(services, await agent.setContextWindow(tokens));
}

/**
 * 手动压缩上下文（/compact）：可选自定义摘要侧重点（/compact 只保留结论）。
 * 压缩期间会调用当前模型生成摘要，耗时与一次模型请求相当；完成后状态栏的
 * 上下文占用会明显下降。
 */
async function commandCompact(args: string, services: CommandServices): Promise<void> {
  const agent = services.agent;
  if (!agent?.compact) {
    hint(services, "当前 agent 不支持手动压缩。", "warning");
    return;
  }
  if (agent.isBusy?.()) {
    hint(services, "会话正在输出，无法压缩；可双击 Esc 停止后再试。", "warning");
    return;
  }
  // 状态行：转录中的 spinner 动画让用户感知压缩正在进行（需一次模型调用）。
  const repl = services.repl;
  const status = repl?.beginStatus("压缩上下文");
  try {
    const message = await agent.compact(args.trim() || undefined);
    if (status !== undefined) repl?.endStatus(status, false);
    hint(services, message);
  } catch (error) {
    if (status !== undefined) repl?.endStatus(status, true);
    hint(services, `压缩失败：${error instanceof Error ? error.message : String(error)}`, "error");
  }
}

async function commandThinking(level: string | undefined, services: CommandServices): Promise<void> {
  if (!level) {
    const levels = services.agent?.thinkingLevels?.() ?? [];
    if (levels.length === 0) {
      hint(services, "请先用 /model 选择模型；thinking level 由当前模型决定。", "warning");
      return;
    }
    if (services.interactive) {
      const picked = await services.pick("选择 thinking level", levels.map((candidate) => ({ value: candidate, label: candidate })));
      if (picked === undefined) {
        hint(services, "已取消 thinking 切换。");
        return;
      }
      level = picked;
    } else {
      services.log(`[主 agent] 当前模型支持的 thinking level：${levels.join(", ")}`);
      return;
    }
  }
  try {
    hint(services, (await services.agent?.setThinkingLevel?.(level)) ?? "当前 supervisor agent 不支持运行时 thinking 切换");
  } catch (error) {
    hint(services, `thinking 切换失败：${error instanceof Error ? error.message : String(error)}`, "error");
  }
}

/** 解析 <id|序号> 引用：先按 id 精确匹配，再按 /sessions 的 1 基序号。 */
async function resolveSessionRef(
  ref: string,
  sessions: SessionManager
): Promise<{ id: string; name?: string } | undefined> {
  const direct = sessions.get(ref);
  if (direct) return direct;
  const index = Number.parseInt(ref, 10);
  if (Number.isInteger(index) && index >= 1) {
    const list = await sessions.list();
    const target = list[index - 1];
    if (target) return { id: target.id, name: target.name };
  }
  return undefined;
}

function sessionCommandError(error: unknown): string {
  if (error instanceof SessionBusyError) return error.message;
  if (error instanceof SessionClosedError) return error.message;
  if (error instanceof SessionNotFoundError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

/** 无显式草稿名时，用首条消息摘要作为会话名（压平空白，截到 24 字）。 */
function goalSessionName(goal: string): string | undefined {
  const text = goal.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  const chars = Array.from(text);
  const clipped = chars.slice(0, 24).join("");
  return chars.length > 24 ? `${clipped}…` : clipped;
}

/**
 * 新建会话统一入口（/new 与会话栏「＋」共用）：只开草稿，不创建任何记录。
 * 清空 transcript、解绑 agent 会话；模型/thinking 等待生效配置保留在 agent
 * 上，首次发送任务时由 materialize 真正落盘。重复点击幂等。
 */
export async function openDraftSession(services: CommandServices, name?: string): Promise<void> {
  const sessions = services.sessions;
  if (!sessions) {
    hint(services, "会话管理未配置。", "warning");
    return;
  }
  if (services.agent?.isBusy?.()) {
    hint(services, "会话正在输出，无法切换；请等待当前任务完成。", "warning");
    return;
  }
  try {
    services.agent?.detach?.();
  } catch (error) {
    // detach 失败（理论上仅在 busy 并发时发生）：保持原状，不进入草稿。
    hint(services, `无法进入草稿：${sessionCommandError(error)}`, "error");
    return;
  }
  sessions.startDraft(name);
  services.repl?.clearTranscript();
  services.repl?.appendMarkdown("*✎ 草稿：新会话将在首次发送时创建；可先 /model /thinking 配置*");
  hint(services, `已打开草稿${name ? `（名称：${name}）` : ""}；首次发送时创建，重复点击「新建」只是重新打开它。`);
}

async function commandNew(name: string, services: CommandServices): Promise<void> {
  await openDraftSession(services, name || undefined);
}

async function commandSessions(services: CommandServices): Promise<void> {
  const sessions = services.sessions;
  if (!sessions) {
    hint(services, "会话管理未配置。", "warning");
    return;
  }
  const list = await sessions.list();
  if (list.length === 0) {
    hint(services, "暂无会话；输入任务或 /new <名称> 开始（首次发送时创建）。");
    return;
  }
  services.log("[主 agent] 会话列表（/switch <id|序号> 切换，/close <id|序号> 关闭）：");
  for (const [index, session] of list.entries()) {
    const flags = session.status === "closed" ? "已关闭" : "活跃";
    const current = session.current ? "，当前" : "";
    services.log(`  ${index + 1}. ${session.name}（${flags}${current}，消息 ${session.messageCount}，更新 ${session.updatedAt}）${session.id}`);
  }
}

/**
 * 切换会话核心（/switch 与会话栏点击共用）：busy 时拒绝；点击当前会话短路为
 * 提示（避免无谓的 dispose/rebind 与历史重放）；否则先 bind（校验存在/未关闭
 * 并取得 Pi 实例），再移动指针，最后重绑 agent 并回放历史；失败时尽力把指针
 * 回滚到原会话，避免指针与实际会话脱节。
 */
export async function switchToSessionId(id: string, services: CommandServices): Promise<void> {
  const sessions = services.sessions;
  if (!sessions) {
    hint(services, "会话管理未配置。", "warning");
    return;
  }
  if (services.agent?.isBusy?.()) {
    hint(services, "会话正在输出，无法切换；请等待当前任务完成。", "warning");
    return;
  }
  const target = sessions.get(id);
  if (!target) {
    hint(services, `找不到会话：${id.trim() || "(空)"}（可用 /sessions 查看）`, "warning");
    return;
  }
  if (sessions.current()?.id === target.id) {
    hint(services, `已是当前会话：${target.name ?? target.id}`);
    return;
  }
  const previous = sessions.current();
  try {
    const pi = await sessions.bind(target.id);
    await sessions.switch(target.id);
    const message =
      (await services.agent?.rebind?.(pi)) ?? `已切换会话（agent 不支持运行时切换，仅更新指针）：${target.name ?? target.id}`;
    // transcript 属于会话内容，切换成功后必须整体替换而不是追加：否则旧会话
    // 的消息残留（切到空会话时回放 0 条，屏幕看起来纹丝不动，尤其明显）。
    // 放在 rebind 成功之后：rebind 失败会走 catch 回滚指针留在原会话，
    // 此时屏幕内容仍然有效，不应被清掉。
    services.repl?.clearTranscript();
    hint(services, message);
    replaySessionHistory(pi, services);
  } catch (error) {
    const now = sessions.current();
    if (previous && now && now.id !== previous.id) await sessions.switch(previous.id).catch(() => undefined);
    hint(services, `切换失败：${sessionCommandError(error)}`, "error");
  }
}

async function commandSwitch(ref: string, services: CommandServices): Promise<void> {
  // 「draft」是保留引用：切到未保存草稿（等同点击「＋ 新建」）。
  if (ref.trim().toLowerCase() === "draft") {
    await openDraftSession(services);
    return;
  }
  const sessions = services.sessions;
  if (!sessions) {
    hint(services, "会话管理未配置。", "warning");
    return;
  }
  if (!ref) {
    hint(services, "用法：/switch <id|序号|draft>（序号见 /sessions）。");
    return;
  }
  const target = await resolveSessionRef(ref, sessions);
  if (!target) {
    hint(services, `找不到会话：${ref}（可用 /sessions 查看）`, "warning");
    return;
  }
  await switchToSessionId(target.id, services);
}

/**
 * 切换成功后回放目标会话历史（compaction-aware）：直接驱动 TUI 组件，与实时
 * 显示同源（气泡/折叠思考/✔✘ 工具行）。整个过程不抛错——回放失败只提示，
 * 不影响切换结果。/new 不回放（新会话没有历史）。目标会话为空时回放 0 条，
 * 补一行占位说明，避免清屏后看起来像没切换。
 */
function replaySessionHistory(pi: PiSessionManager, services: CommandServices): void {
  if (!services.repl) return;
  try {
    const count = replayHistory(services.repl, pi.buildContextEntries());
    if (count === 0) services.repl.appendMarkdown("*（空会话：暂无历史记录）*");
  } catch (error) {
    hint(services, `历史回放失败：${error instanceof Error ? error.message : String(error)}`, "error");
  }
}

async function commandClose(ref: string, services: CommandServices): Promise<void> {
  const sessions = services.sessions;
  if (!sessions) {
    hint(services, "会话管理未配置。", "warning");
    return;
  }
  const target = ref ? await resolveSessionRef(ref, sessions) : sessions.current();
  if (!target) {
    hint(services, ref ? `找不到会话：${ref}（可用 /sessions 查看）` : "没有当前会话可关闭。", "warning");
    return;
  }
  const wasCurrent = sessions.current()?.id === target.id;
  try {
    const closed = await sessions.close(target.id);
    hint(services, `已关闭会话：${closed.name ?? closed.id}${wasCurrent ? "（原当前会话；输入任务将开启新草稿，或 /switch 切换）" : ""}`);
  } catch (error) {
    hint(services, `关闭失败：${sessionCommandError(error)}`, "error");
  }
}

/**
 * 删除会话核心（/delete 与会话栏右键菜单共用）：删除当前会话时先解绑 agent
 * （释放 JSONL 文件句柄，Windows 上打开中的文件无法删除）再删；随后打开侧栏
 * 同位的会话（updatedAt 倒序：后一位顶替，被删的是末位则取前一位），没有其他
 * 活跃会话时才转入草稿态并清空 transcript；删除非当前会话不动指针。
 */
export async function deleteSessionById(id: string, services: CommandServices): Promise<void> {
  const sessions = services.sessions;
  if (!sessions) {
    hint(services, "会话管理未配置。", "warning");
    return;
  }
  if (services.agent?.isBusy?.()) {
    hint(services, "会话正在输出，无法删除；请等待当前任务完成。", "warning");
    return;
  }
  const target = sessions.get(id);
  if (!target) {
    hint(services, `找不到会话：${id.trim() || "(空)"}（可用 /sessions 查看）`, "warning");
    return;
  }
  const wasCurrent = sessions.current()?.id === target.id;
  // 删除前先定位：按侧栏顺序（updatedAt 倒序，仅活跃会话）记下被删会话的位置，
  // 删除后由同位会话顶替打开，而不是落回草稿。
  const activeBefore = wasCurrent
    ? (await sessions.list()).filter((session) => session.status === "active")
    : [];
  const position = activeBefore.findIndex((session) => session.id === target.id);
  try {
    if (wasCurrent) services.agent?.detach?.();
    const removed = await sessions.delete(target.id);
    hint(services, `已删除会话：${removed.name ?? removed.id}`);
    if (wasCurrent) {
      // 同位会话顶替（列表后一位优先；被删的是末位则取前一位），走 /switch
      // 同一核心流程；没有其他活跃会话才转入草稿态，后续输入不丢。
      const successor = activeBefore[position + 1] ?? activeBefore[position - 1];
      if (successor) await switchToSessionId(successor.id, services);
      if (!sessions.current()) {
        sessions.startDraft();
        services.repl?.clearTranscript();
        services.repl?.appendMarkdown("*✎ 草稿：新会话将在首次发送时创建*");
      }
    }
  } catch (error) {
    hint(services, `删除失败：${sessionCommandError(error)}`, "error");
  }
}

async function commandDelete(ref: string, services: CommandServices): Promise<void> {
  const sessions = services.sessions;
  if (!sessions) {
    hint(services, "会话管理未配置。", "warning");
    return;
  }
  if (!ref) {
    hint(services, "用法：/delete <id|序号>（序号见 /sessions）；也可在会话栏右键删除。");
    return;
  }
  const target = await resolveSessionRef(ref, sessions);
  if (!target) {
    hint(services, `找不到会话：${ref}（可用 /sessions 查看）`, "warning");
    return;
  }
  await deleteSessionById(target.id, services);
}

async function dispatchTask(goal: string, services: CommandServices, _state: CommandState): Promise<void> {
  if (!services.agent?.runTask) {
    hint(services, "任务执行未配置。", "warning");
    return;
  }
  if (services.agent.isBusy?.()) {
    hint(services, "已有任务正在执行，请等待完成后再输入。", "warning");
    return;
  }
  // 用户输入的回显由 TUI 气泡承担（TuiRepl.handleSubmit），此处不再回显；
  // 斜杠命令是 UI 操作且可能含密钥（/apikey），两种渠道都不回显。
  // 当前会话不存在（草稿、已关闭或从未创建）时物化承接：草稿名优先，无则
  // 用首条消息摘要命名，保证无缝体验。
  let sessionId = services.sessions?.current()?.id;
  if (!sessionId && services.sessions) {
    try {
      const record = await services.sessions.materialize(goalSessionName(goal));
      try {
        const pi = await services.sessions.bind(record.id);
        hint(services, (await services.agent?.rebind?.(pi)) ?? `已创建会话：${record.name ?? record.id}`);
        sessionId = record.id;
      } catch (error) {
        // 刚物化的会话未被 agent 使用：关闭它，避免指针与实际会话脱节、touch 错误记账
        await services.sessions.close(record.id).catch(() => undefined);
        hint(services, `自动创建会话失败：${sessionCommandError(error)}`, "error");
      }
    } catch (error) {
      hint(services, `自动创建会话失败，任务将在无会话状态下执行：${sessionCommandError(error)}`, "error");
    }
  }
  try {
    await services.agent.runTask(goal);
  } catch (error) {
    hint(services, `任务执行失败：${sessionCommandError(error)}`, "error");
  } finally {
    // 一轮任务 ≈ 一条用户消息 + 一条回复；touch 失败不影响任务结果
    if (sessionId && services.sessions) {
      await services.sessions.touch(sessionId, { messages: 2 }).catch(() => undefined);
    }
  }
}
