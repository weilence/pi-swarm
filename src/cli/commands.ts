import type { AgentDefinition } from "../core/agent-format.ts";
import type { WorktreeRegistry } from "../core/worktree/worktree-registry.ts";
import type { SessionRegistry } from "../core/session/session-registry.ts";
import {
  closeSessionById,
  deleteSessionById as flowDeleteSessionById,
  dispatchTask as flowDispatchTask,
  listWorktrees,
  openDraftSession as flowOpenDraftSession,
  switchToSessionId as flowSwitchToSessionId,
  switchWorktreeScope,
  type SessionFlowPorts
} from "../core/session/session-flows.ts";
import type { TuiRepl } from "./tui-repl.ts";
import { DRAFT_SESSION } from "./chat-panel.ts";
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
  /** 手动设置上下文容量（token）；undefined 恢复模型默认。 */
  setContextWindow?(tokens?: number): Promise<string>;
  /** 手动压缩上下文；customInstructions 可选，指定摘要侧重点。 */
  compact?(customInstructions?: string): Promise<string>;
  /** 用户主动中止聚焦会话的当前输出（双击 Esc）。 */
  abort?(): Promise<void>;
  /** 聚焦会话是否正在流式输出。 */
  isBusy?(): boolean;
}

/**
 * 执行池门面（并行会话）：按会话粒度的 busy 查询 / context 创建 / 释放。
 * 与 {@link AgentController} 的区别：后者面向「聚焦会话的 agent」，这里面向
 * 「任意 id 的会话」（后台会话的 close/delete 守卫、任务派发都用它）。
 */
export interface SessionTasks {
  isBusy(id: string): boolean;
  ensure(id: string): Promise<{ runTask(goal: string): Promise<string> }>;
  dispose?(id: string): Promise<void>;
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
  sessions?: SessionRegistry;
  /** worktree 作用域注册表；提供后启用 /worktree /worktrees。 */
  worktrees?: WorktreeRegistry;
  /** 执行池门面；提供后任务派发/会话关闭删除走并行会话语义。 */
  tasks?: SessionTasks;
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
 * 命令注册表：名称、别名、描述、参数提示、补全与处理器的唯一真相。
 * SLASH_COMMANDS（编辑器补全提示的数据源）由它派生，分发由 executeCommand
 * 查表完成——不再存在「补全列表与分发 if 链」两份需要人工同步的真相。
 * argumentHint 仅用于提示列展示；参数可枚举的命令声明 getArgumentCompletions。
 */
interface CommandEntry {
  name: string;
  aliases?: readonly string[];
  description: string;
  argumentHint?: string;
  getArgumentCompletions?: (prefix: string) => AutocompleteItem[];
  /** 处理器：args 是命令名之后的剩余文本（已 trim；空串表示无参数）。 */
  handle: (args: string, services: CommandServices, state: CommandState) => Promise<CommandOutcome | void>;
}

const COMMANDS: readonly CommandEntry[] = [
  { name: "exit", aliases: ["quit"], description: "退出 pi-swarm", handle: async () => "exit" },
  { name: "status", description: "查看 supervisor / 会话 / 子 agent 状态", handle: (_args, services) => commandStatus(services) },
  {
    name: "provider",
    argumentHint: "[id] [api]",
    description: "选择模型 provider 与接口类型",
    handle: (args, services, state) => {
      const [providerId, apiName] = args.split(/\s+/, 2);
      return commandProvider(providerId || undefined, apiName || undefined, services, state);
    }
  },
  { name: "model", argumentHint: "[provider/]model", description: "切换模型", handle: (args, services, state) => commandModel(args || undefined, services, state) },
  { name: "thinking", argumentHint: "[level]", description: "调整思考深度（thinking level）", handle: (args, services) => commandThinking(args || undefined, services) },
  { name: "apikey", argumentHint: "<key>", description: "设置 API key（明文存于 config.json）", handle: (args, services, state) => commandApiKey(args || undefined, services, state) },
  {
    name: "context",
    argumentHint: "<tokens|reset>",
    description: "查看/设置上下文容量",
    getArgumentCompletions: staticArgCompletions([{ value: "reset", label: "reset", description: "恢复模型默认容量" }]),
    handle: (args, services) => commandContext(args, services)
  },
  { name: "compact", argumentHint: "[侧重点]", description: "手动压缩上下文", handle: (args, services) => commandCompact(args, services) },
  { name: "new", argumentHint: "[名称]", description: "新建会话（草稿，首次发送时创建）", handle: (args, services) => commandNew(args, services) },
  { name: "sessions", aliases: ["ls"], description: "列出全部会话", handle: (_args, services) => commandSessions(services) },
  {
    name: "switch",
    argumentHint: "<id|序号|draft>",
    description: "切换会话",
    getArgumentCompletions: staticArgCompletions([{ value: "draft", label: "draft", description: "切到未保存草稿（等同 ＋ 新建）" }]),
    handle: (args, services) => commandSwitch(args, services)
  },
  {
    name: "worktree",
    argumentHint: "[名称|.]",
    description: "切换 worktree 作用域（省略名称=随机新建，.=主工作区）",
    handle: (args, services) => commandWorktree(args, services)
  },
  { name: "worktrees", description: "列出 worktree 作用域", handle: (_args, services) => listWorktrees(flowPorts(services)) },
  { name: "close", argumentHint: "[id|序号]", description: "关闭会话", handle: (args, services) => commandClose(args, services) },
  { name: "delete", argumentHint: "<id|序号>", description: "删除会话（含记录文件）", handle: (args, services) => commandDelete(args, services) }
];

/**
 * 编辑器补全提示（SlashAutocompleteProvider）的数据源：从命令注册表派生，
 * 主命令与别名各占一项（别名描述标注来源命令），顺序即注册表顺序。
 */
export const SLASH_COMMANDS: readonly SlashCommand[] = COMMANDS.flatMap((entry) =>
  [entry.name, ...(entry.aliases ?? [])].map((name) => ({
    name,
    description: name === entry.name ? entry.description : `${entry.description}（/${entry.name} 别名）`,
    ...(entry.argumentHint ? { argumentHint: entry.argumentHint } : {}),
    ...(entry.getArgumentCompletions ? { getArgumentCompletions: entry.getArgumentCompletions } : {})
  }))
);

export async function executeCommand(line: string, services: CommandServices, state: CommandState): Promise<CommandOutcome> {
  const goal = line.trim();
  if (!goal) return "continue";
  if (!goal.startsWith("/")) {
    await dispatchTask(goal, services, state);
    return "continue";
  }
  const name = goal.slice(1).split(/\s+/, 1)[0].toLowerCase();
  const entry = COMMANDS.find((candidate) => candidate.name === name || candidate.aliases?.includes(name));
  if (!entry) {
    // 未识别的斜杠输入按任务文本派发（与历史行为一致：supervisor 自行解读）。
    await dispatchTask(goal, services, state);
    return "continue";
  }
  const args = goal.slice(1 + name.length).trim();
  const outcome = await entry.handle(args, services, state);
  return outcome === "exit" ? "exit" : "continue";
}

/** /status：supervisor / 当前会话 / 子 agent 三段状态。 */
async function commandStatus(services: CommandServices): Promise<void> {
  services.log(`[主 agent] supervisor：${services.agent?.status?.() ?? "状态不可用"}`);
  if (services.sessions) {
    const draft = services.sessions.isDraft();
    const currentSession = services.sessions.current();
    services.log(`[主 agent] 当前作用域：⎇ ${services.sessions.currentScope() ?? "主工作区"}`);
    services.log(
      draft
        ? "[主 agent] 当前会话：草稿（未保存；首次发送时在当前作用域创建）"
        : currentSession
          ? `[主 agent] 当前会话：${currentSession.name ?? currentSession.id}（${currentSession.id}${currentSession.worktree ? `，⎇ ${currentSession.worktree}` : ""}）`
          : "[主 agent] 当前会话：无（输入任务将自动创建）"
    );
  }
  const agents = services.agents?.list() ?? [];
  services.log(
    agents.length > 0
      ? `[主 agent] 已加载 agents：${agents.map((agent) => agent.name).join(", ")}`
      : "[主 agent] 未加载任何子 agent，所有任务由 supervisor 自执行。"
  );
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
  sessions: SessionRegistry
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

/**
 * 把命令层服务适配为 core 会话用例端口：视图动作路由到 TUI（转录清理、
 * markdown 追加、历史回放），提示路由到 toast/log 通道。业务规则本体在
 * core/session/session-flows.ts——本层只留 UI 装配。
 */
function flowPorts(services: CommandServices): SessionFlowPorts {
  return {
    sessions: services.sessions,
    worktrees: services.worktrees,
    agent: services.tasks,
    view: {
      showSession: (session) => {
        services.repl?.setActiveSession(session);
        // 已有缓冲内容 → 切回即补放；空 → 由调用方回放 JSONL。
        return services.repl?.sessionPopulated(session) ?? true;
      },
      showDraft: () => {
        services.repl?.setActiveSession(DRAFT_SESSION);
        services.repl?.clearTranscript(undefined, DRAFT_SESSION);
      },
      appendMarkdown: (markdown, session) => services.repl?.appendMarkdown(markdown, undefined, session),
      appendUserMessage: (message, session) => services.repl?.appendUserMessage(message, session),
      hint: (message, level = "info") => hint(services, message, level),
      replay: (pi, session) => replaySessionHistory(pi, session, services)
    }
  };
}

/** 新建会话（/new、会话栏「＋」共用）：规则见 core 的同名用例。 */
export async function openDraftSession(services: CommandServices, name?: string): Promise<void> {
  await flowOpenDraftSession(flowPorts(services), name);
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
    hint(services, "暂无会话；输入任务或 /new <名称> 开始（首次发送时创建）。/worktree <名称> 可切作用域。");
    return;
  }
  // 按作用域分组输出（主工作区最前）；序号保持全局连续，与 /switch <序号> 对齐。
  const groups = new Map<string, { index: number; session: (typeof list)[number] }[]>();
  for (const [index, session] of list.entries()) {
    const key = session.worktree ?? "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push({ index: index + 1, session });
  }
  const ordered = [...groups.entries()].sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : 0));
  services.log("[主 agent] 会话列表（/switch <id|序号> 切换，/close 关闭，/worktree 切作用域）：");
  for (const [key, groupEntries] of ordered) {
    services.log(`  ⎇ ${key || "主工作区"}`);
    for (const { index, session } of groupEntries) {
      const flags = session.status === "closed" ? "已关闭" : "活跃";
      const current = session.current ? "，当前" : "";
      services.log(`    ${index}. ${session.name}（${flags}${current}，消息 ${session.messageCount}，更新 ${session.updatedAt}）${session.id}`);
    }
  }
}

/**
 * 切换会话核心（/switch 与会话栏点击共用）：busy 时拒绝；点击当前会话短路为
 * 提示（避免无谓的 dispose/rebind 与历史重放）；否则先 bind（校验存在/未关闭
 * 并取得 Pi 实例），再移动指针，最后重绑 agent 并回放历史；失败时尽力把指针
 * 回滚到原会话，避免指针与实际会话脱节。
 */
/** 切换会话（/switch、会话栏点击共用）：规则见 core 的同名用例。 */
export async function switchToSessionId(id: string, services: CommandServices): Promise<void> {
  await flowSwitchToSessionId(flowPorts(services), id);
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
 * 切换成功后回放目标会话历史（compaction-aware，写入该会话命名空间）：直接
 * 驱动 TUI 组件，与实时显示同源（气泡/折叠思考/✔✘ 工具行）。整个过程不抛
 * 错——回放失败只提示，不影响切换结果。
 */
function replaySessionHistory(pi: PiSessionManager, session: string, services: CommandServices): void {
  if (!services.repl) return;
  try {
    const count = replayHistory(services.repl, pi.buildContextEntries(), undefined, session);
    if (count === 0) services.repl.appendMarkdown("*（空会话：暂无历史记录）*", undefined, session);
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
  const target = ref ? await resolveSessionRef(ref, sessions) : undefined;
  if (ref && !target) {
    hint(services, `找不到会话：${ref}（可用 /sessions 查看）`, "warning");
    return;
  }
  await closeSessionById(flowPorts(services), target?.id);
}

/** /worktree：切换作用域；`.` 回主工作区，名称省略随机新建。 */
async function commandWorktree(args: string, services: CommandServices): Promise<void> {
  await switchWorktreeScope(flowPorts(services), args || undefined);
}

/** 删除会话（/delete、会话栏右键菜单共用）：规则见 core 的同名用例。 */
export async function deleteSessionById(id: string, services: CommandServices): Promise<void> {
  await flowDeleteSessionById(flowPorts(services), id);
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

/** 任务派发（命令层与未来 headless 入口共用 core 流程）：规则见 core。 */
async function dispatchTask(goal: string, services: CommandServices, _state: CommandState): Promise<void> {
  await flowDispatchTask(flowPorts(services), goal);
}
