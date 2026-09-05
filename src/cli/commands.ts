import type { AgentDefinition } from "../core/agent-format.ts";
import type { SessionManager } from "../core/session/session-manager.ts";
import { SessionBusyError, SessionClosedError, SessionNotFoundError } from "../core/session/session-types.ts";
import type { TuiRepl } from "./tui-repl.ts";
import { replayHistory } from "./history-replay.ts";
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
  /** 把 AgentSession 重绑到指定 Pi 会话（/switch、任务物化使用）。 */
  rebind?(sessionManager: PiSessionManager): Promise<string>;
  /** 解除当前会话绑定回到草稿态（/new 使用）；待生效的模型/thinking 保留。 */
  detach?(): void;
  /** prompt 流式输出进行中（此时拒绝切换会话）。 */
  isBusy?(): boolean;
  /** Runs one user task through the supervisor's model-driven loop. */
  runTask?(goal: string): Promise<string>;
}

export interface CommandServices {
  agent?: AgentController;
  catalog: ProviderCatalog;
  log: (line: string) => void;
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
    const levels = services.agent?.thinkingLevels?.() ?? [];
    if (levels.length === 0) {
      services.log("[主 agent] 请先用 /model 选择模型；thinking level 由当前模型决定。");
      return;
    }
    if (services.interactive) {
      const picked = await services.pick("选择 thinking level", levels.map((candidate) => ({ value: candidate, label: candidate })));
      if (picked === undefined) {
        services.log("[主 agent] 已取消 thinking 切换。");
        return;
      }
      level = picked;
    } else {
      services.log(`[主 agent] 当前模型支持的 thinking level：${levels.join(", ")}`);
      return;
    }
  }
  try {
    services.log(`[主 agent] ${await services.agent?.setThinkingLevel?.(level) ?? "当前 supervisor agent 不支持运行时 thinking 切换"}`);
  } catch (error) {
    services.log(`[主 agent] thinking 切换失败：${error instanceof Error ? error.message : String(error)}`);
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
    services.log("[主 agent] 会话管理未配置。");
    return;
  }
  if (services.agent?.isBusy?.()) {
    services.log("[主 agent] 会话正在输出，无法切换；请等待当前任务完成。");
    return;
  }
  try {
    services.agent?.detach?.();
  } catch (error) {
    // detach 失败（理论上仅在 busy 并发时发生）：保持原状，不进入草稿。
    services.log(`[主 agent] 无法进入草稿：${sessionCommandError(error)}`);
    return;
  }
  sessions.startDraft(name);
  services.repl?.clearTranscript();
  services.repl?.appendMarkdown("*✎ 草稿：新会话将在首次发送时创建；可先 /model /thinking 配置*");
  services.log(`[主 agent] 已打开草稿${name ? `（名称：${name}）` : ""}；首次发送时创建，重复点击「新建」只是重新打开它。`);
}

async function commandNew(name: string, services: CommandServices): Promise<void> {
  await openDraftSession(services, name || undefined);
}

async function commandSessions(services: CommandServices): Promise<void> {
  const sessions = services.sessions;
  if (!sessions) {
    services.log("[主 agent] 会话管理未配置。");
    return;
  }
  const list = await sessions.list();
  if (list.length === 0) {
    services.log("[主 agent] 暂无会话；输入任务或 /new <名称> 开始（首次发送时创建）。");
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
    services.log("[主 agent] 会话管理未配置。");
    return;
  }
  if (services.agent?.isBusy?.()) {
    services.log("[主 agent] 会话正在输出，无法切换；请等待当前任务完成。");
    return;
  }
  const target = sessions.get(id);
  if (!target) {
    services.log(`[主 agent] 找不到会话：${id.trim() || "(空)"}（可用 /sessions 查看）`);
    return;
  }
  if (sessions.current()?.id === target.id) {
    services.log(`[主 agent] 已是当前会话：${target.name ?? target.id}`);
    return;
  }
  const previous = sessions.current();
  try {
    const pi = await sessions.bind(target.id);
    await sessions.switch(target.id);
    services.log(
      `[主 agent] ${await services.agent?.rebind?.(pi) ?? `已切换会话（agent 不支持运行时切换，仅更新指针）：${target.name ?? target.id}`}`
    );
    replaySessionHistory(pi, services);
  } catch (error) {
    const now = sessions.current();
    if (previous && now && now.id !== previous.id) await sessions.switch(previous.id).catch(() => undefined);
    services.log(`[主 agent] 切换失败：${sessionCommandError(error)}`);
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
    services.log("[主 agent] 会话管理未配置。");
    return;
  }
  if (!ref) {
    services.log("[主 agent] 用法：/switch <id|序号|draft>（序号见 /sessions）。");
    return;
  }
  const target = await resolveSessionRef(ref, sessions);
  if (!target) {
    services.log(`[主 agent] 找不到会话：${ref}（可用 /sessions 查看）`);
    return;
  }
  await switchToSessionId(target.id, services);
}

/**
 * 切换成功后回放目标会话历史（compaction-aware）：直接驱动 TUI 组件，与实时
 * 显示同源（气泡/折叠思考/✔✘ 工具行）。整个过程不抛错——回放失败只提示，
 * 不影响切换结果。/new 不回放（新会话没有历史）。
 */
function replaySessionHistory(pi: PiSessionManager, services: CommandServices): void {
  if (!services.repl) return;
  try {
    replayHistory(services.repl, pi.buildContextEntries());
  } catch (error) {
    services.log(`[主 agent] 历史回放失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function commandClose(ref: string, services: CommandServices): Promise<void> {
  const sessions = services.sessions;
  if (!sessions) {
    services.log("[主 agent] 会话管理未配置。");
    return;
  }
  const target = ref ? await resolveSessionRef(ref, sessions) : sessions.current();
  if (!target) {
    services.log(ref ? `[主 agent] 找不到会话：${ref}（可用 /sessions 查看）` : "[主 agent] 没有当前会话可关闭。");
    return;
  }
  const wasCurrent = sessions.current()?.id === target.id;
  try {
    const closed = await sessions.close(target.id);
    services.log(
      `[主 agent] 已关闭会话：${closed.name ?? closed.id}${wasCurrent ? "（原当前会话；输入任务将开启新草稿，或 /switch 切换）" : ""}`
    );
  } catch (error) {
    services.log(`[主 agent] 关闭失败：${sessionCommandError(error)}`);
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
    services.log("[主 agent] 会话管理未配置。");
    return;
  }
  if (services.agent?.isBusy?.()) {
    services.log("[主 agent] 会话正在输出，无法删除；请等待当前任务完成。");
    return;
  }
  const target = sessions.get(id);
  if (!target) {
    services.log(`[主 agent] 找不到会话：${id.trim() || "(空)"}（可用 /sessions 查看）`);
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
    services.log(`[主 agent] 已删除会话：${removed.name ?? removed.id}`);
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
    services.log(`[主 agent] 删除失败：${sessionCommandError(error)}`);
  }
}

async function commandDelete(ref: string, services: CommandServices): Promise<void> {
  const sessions = services.sessions;
  if (!sessions) {
    services.log("[主 agent] 会话管理未配置。");
    return;
  }
  if (!ref) {
    services.log("[主 agent] 用法：/delete <id|序号>（序号见 /sessions）；也可在会话栏右键删除。");
    return;
  }
  const target = await resolveSessionRef(ref, sessions);
  if (!target) {
    services.log(`[主 agent] 找不到会话：${ref}（可用 /sessions 查看）`);
    return;
  }
  await deleteSessionById(target.id, services);
}

async function dispatchTask(goal: string, services: CommandServices, _state: CommandState): Promise<void> {
  if (!services.agent?.runTask) {
    services.log("[主 agent] 任务执行未配置。");
    return;
  }
  if (services.agent.isBusy?.()) {
    services.log("[主 agent] 已有任务正在执行，请等待完成后再输入。");
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
        services.log(`[主 agent] ${await services.agent?.rebind?.(pi) ?? `已创建会话：${record.name ?? record.id}`}`);
        sessionId = record.id;
      } catch (error) {
        // 刚物化的会话未被 agent 使用：关闭它，避免指针与实际会话脱节、touch 错误记账
        await services.sessions.close(record.id).catch(() => undefined);
        services.log(`[主 agent] 自动创建会话失败：${sessionCommandError(error)}`);
      }
    } catch (error) {
      services.log(`[主 agent] 自动创建会话失败，任务将在无会话状态下执行：${sessionCommandError(error)}`);
    }
  }
  try {
    await services.agent.runTask(goal);
  } catch (error) {
    services.log(`[主 agent] 任务执行失败：${sessionCommandError(error)}`);
  } finally {
    // 一轮任务 ≈ 一条用户消息 + 一条回复；touch 失败不影响任务结果
    if (sessionId && services.sessions) {
      await services.sessions.touch(sessionId, { messages: 2 }).catch(() => undefined);
    }
  }
}
