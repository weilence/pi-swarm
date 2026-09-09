import { loadEnvFile } from "node:process";
import { basename, resolve } from "node:path";
import { EventBus } from "../core/event-bus.ts";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { ModelsDevCatalog, type ModelsDevProvider } from "../models-dev/catalog.ts";
import { JsonFileConfigStore } from "../core/config/json-file-config-store.ts";
import { JsonFileSessionStore } from "../core/session/json-file-session-store.ts";
import { SessionRegistry } from "../core/session/session-registry.ts";
import { SessionContextPool } from "../core/session/session-context.ts";
import { WorktreeRegistry } from "../core/worktree/worktree-registry.ts";
import { createAgent } from "../pi/agent-factory.ts";
import type { Agent, AgentStatusSnapshot } from "../pi/agent.ts";
import type { AgentController, CommandServices, CommandState } from "./commands.ts";
import { AgentRegistry, defaultAgentDirs } from "../core/agent-registry.ts";
import { OutputRouter } from "./output-router.ts";
import { TuiRepl } from "./tui-repl.ts";
import { DRAFT_SESSION } from "./chat-panel.ts";
import { openDraftSession, deleteSessionById, executeCommand, switchToSessionId } from "./commands.ts";
import { resetTerminalTitle, setTerminalTitle } from "./terminal-title.ts";

try {
  loadEnvFile(resolve(process.cwd(), ".env"));
} catch (error) {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
}

// 终端能力缺失时（如 stdin 被重定向）ProcessTerminal 会自动降级，不硬退。
// 输出路由器是所有流/日志/提示的唯一出口：REPL 就绪前降级为裸 console，
// 就绪后统一切到 TUI 通道，并托管状态栏快照的流式轮询。
const output = new OutputRouter({
  // agentController 声明在后，闭包运行时取值。
  statusSnapshot: () => agentController.statusSnapshot,
  // 轮播 tick：侧栏的 busy/未读标记随流式活动每秒刷新（实现在下方块内赋值）。
  onTick: () => void refreshBars()
});

/** REPL 就绪后由启动块赋值；此前的 tick 是空操作。 */
let refreshBars: () => Promise<void> = async () => undefined;

// REPL 在启动流程中创建；创建前子 agent 懒派发等路径只做空值降级。
let repl: TuiRepl | undefined;

// One shared runtime: /provider and /model register once and apply to every
// session context and every sub-agent session alike（并发流式共用一个 runtime
// 正是本原型要验证的问题，见 docs/parallel-worktree-design.md §9.8）。
const sharedRuntime = await ModelRuntime.create({ refreshOnCreate: false });
const modelsCatalog = new ModelsDevCatalog({
  onUpdate: (info) => {
    if (info.source === "refresh" && info.updated) {
      output.notify(`models.dev 目录已在后台更新：${info.count} 个 providers。`);
    }
  }
});

// Sub-agents are user-created markdown definitions (global + project dirs);
// none are pre-provisioned, matching the "no initial sub-agents" architecture.
const agentRegistry = await AgentRegistry.load(defaultAgentDirs(), (warning) =>
  output.notify(`agent 定义告警（${warning.file}）：${warning.problems.join("；")}`, "warning")
);

const events = new EventBus();
// 编排缝上的任务生命周期事件 → transcript 行。
events.subscribe((event) => output.taskEvent(event));
const configStore = new JsonFileConfigStore();
const worktrees = new WorktreeRegistry({ cwd: process.cwd() });

// Session management: persistent JSONL conversations under the user data dir.
// initialize() only loads the index; no session is created here — the first
// dispatched task auto-creates one in the CURRENT scope (startup scope is
// always the main workspace). Worktree cwd resolution is injected so the
// session module never touches git itself.
const sessionStore = new JsonFileSessionStore();
const sessionManager = new SessionRegistry({
  cwd: process.cwd(),
  store: sessionStore,
  resolveWorktreeCwd: (name) => worktrees.pathOf(name)
});
await sessionManager.initialize();

// 每会话一个执行上下文：切换会话/作用域是纯视图操作，只有真正派发任务才
// 会在这里懒创建 context（supervisor agent + 本会话专属的子 agent 池）。
const pool = new SessionContextPool({
  sessions: sessionManager,
  worktrees,
  agentRegistry,
  modelRuntime: sharedRuntime,
  events,
  cwd: process.cwd(),
  configStore,
  delegateLog: (line) => output.log(line),
  onContextCreated: (context) => {
    repl?.registerAgent("supervisor", context.id);
    output.attachAgent(context.agent);
  },
  onSubAgent: (_context, agent, name) => {
    repl?.registerAgent(name);
    output.attachAgent(agent);
  }
});

// 草稿态的配置宿主：草稿没有 context，/model /thinking 等偏好先落在这里
// （并持久化到 configStore）；context 创建时 restore() 自动继承同一份配置。
const draftAgent = createAgent({
  definition: agentRegistry.supervisor,
  modelRuntime: sharedRuntime,
  configStore
});

/** 聚焦会话的 context agent；草稿态降级到草稿配置宿主。 */
function focusedAgent(): Agent | undefined {
  return pool.focused()?.agent;
}

// 面向命令层的 agent 门面：配置类操作路由到聚焦 context（草稿落到草稿宿主）。
const agentController: AgentController = {
  get statusSnapshot(): AgentStatusSnapshot | undefined {
    return { ...(focusedAgent() ?? draftAgent).statusSnapshot, worktree: sessionManager.currentScope() };
  },
  status: () => (focusedAgent() ?? draftAgent).status(),
  configureProvider: (providerId, config, modelId) => (focusedAgent() ?? draftAgent).configureProvider(providerId, config, modelId),
  setModel: (specifier) => (focusedAgent() ?? draftAgent).setModel(specifier),
  thinkingLevels: () => (focusedAgent() ?? draftAgent).thinkingLevels(),
  setThinkingLevel: (level) => (focusedAgent() ?? draftAgent).setThinkingLevel(level),
  setApiKey: (key) => (focusedAgent() ?? draftAgent).setApiKey(key),
  setContextWindow: (tokens) => (focusedAgent() ?? draftAgent).setContextWindow(tokens),
  compact: (customInstructions) => (focusedAgent() ?? draftAgent).compact(customInstructions),
  // 中止/busy 只作用于聚焦会话：后台会话不受双击 Esc 影响。
  abort: async () => {
    await focusedAgent()?.abort();
  },
  isBusy: () => focusedAgent()?.isBusy() ?? false
};

const savedConfig = await configStore.load();
let restoredProvider: ModelsDevProvider | undefined;
if (savedConfig.providerId) {
  try {
    restoredProvider = (await modelsCatalog.load()).find((candidate) => candidate.id === savedConfig.providerId);
  } catch {
    // catalog unavailable: the agent still restores from providerConfig; /model will ask for /provider again
  }
}

console.log("pi-swarm 主 agent 已启动。");
const loadedAgents = agentRegistry.list();
console.log(loadedAgents.length > 0 ? `已加载子 agent：${loadedAgents.map((agent) => agent.name).join(", ")}` : "未加载任何子 agent，所有任务由 supervisor 自执行。");
console.log(
  "输入任务，/provider /model /thinking 打开选择弹窗，/apikey <key> 配置密钥，/context <n>[k|w|m] 设置上下文容量，/compact 手动压缩上下文（输出中双击 Esc 停止），/new /sessions /switch /close /delete 管理会话，/worktree [名称] 切换作用域（.=主工作区），/status 查看状态，或 /exit 退出。\n"
);

output.log(`[主 agent] ${await draftAgent.restore()}`);
void modelsCatalog.prefetch();

const restoredModelId =
  restoredProvider && savedConfig.model?.startsWith(`${restoredProvider.id}/`)
    ? savedConfig.model.slice(restoredProvider.id.length + 1)
    : undefined;

const commandState: CommandState = {
  selectedProvider: restoredProvider,
  selectedModelId: restoredModelId
};
const sharedServices = {
  agent: agentController,
  catalog: modelsCatalog,
  agents: agentRegistry,
  sessions: sessionManager,
  worktrees,
  tasks: {
    isBusy: (id: string) => pool.isBusy(id),
    ensure: (id: string) => pool.ensure(id),
    dispose: (id: string) => pool.dispose(id)
  }
};

{
  let settleExit!: () => void;
  const exited = new Promise<void>((settle) => {
    settleExit = settle;
  });
  const services: CommandServices = {
    ...sharedServices,
    interactive: true,
    log: (line) => output.log(line),
    notify: (message, level) => output.notify(message, level),
    // getter：repl 在 services 之后才创建；/switch 历史回放直接驱动它的组件
    get repl() {
      return repl;
    },
    pick: (title, options) => repl!.pick(title, options)
  };
  // 窗口标题：swarm - 会话名 - 项目目录；草稿/未命名时省略会话段。
  const updateTerminalTitle = (): void => {
    const name = sessionManager.isDraft() ? "草稿" : sessionManager.current()?.name;
    const cwd = basename(process.cwd());
    setTerminalTitle(name ? `swarm - ${name} - ${cwd}` : `swarm - ${cwd}`);
  };
  // 会话栏与状态栏快照：会话是延迟创建的（启动不建会话、「＋ 新建」只开草稿），
  // 草稿激活时列表顶部多一行「✎ 草稿」；首个任务物化、/new /switch /close
  // /delete /worktree、点击会话之后，都统一在这里刷新。busy/未读标记来自
  // 执行池与聊天缓冲，输出轮询的 onTick 也会触发本函数。
  const refreshBarsImpl = async (): Promise<void> => {
    const ui = repl;
    if (!ui) return;
    ui.setDraftMode(sessionManager.isDraft());
    const list = await sessionManager.list();
    ui.setSessions(
      list.map((session) => ({
        id: session.id,
        name: session.name,
        current: session.current,
        closed: session.status === "closed",
        worktree: session.worktree,
        busy: pool.isBusy(session.id),
        unread: ui.sessionUnread(session.id)
      }))
    );
    output.refreshStatus();
    updateTerminalTitle();
  };
  refreshBars = refreshBarsImpl;
  repl = new TuiRepl({
    // session 是提交时刻的会话命名空间；任务派发由 core flows 按当前指针路由。
    onSubmit: async (line) => {
      // 必须把结果透传（如 "exit"），否则 /exit 永远不会结束进程。
      const outcome = await executeCommand(line, services, commandState);
      await refreshBars();
      return outcome;
    },
    // 会话栏点击："draft" 是未保存草稿（等同 /new），其余为会话 id，走
    // /switch 同一核心流程（跨作用域点击会连作用域一起切）。
    onSessionClick: async (sessionId) => {
      if (sessionId === "draft") await openDraftSession(services);
      else await switchToSessionId(sessionId, services);
      await refreshBars();
    },
    onDeleteSession: async (sessionId) => {
      await deleteSessionById(sessionId, services);
      await refreshBars();
    },
    onExit: settleExit,
    // 双击 Esc 停止输出：只中止聚焦会话；后台会话继续跑。
    isBusy: () => agentController.isBusy?.() ?? false,
    onAbort: () => {
      void focusedAgent()?.abort();
    }
  });
  output.attachRepl(repl);
  // 草稿命名空间的标签：supervisor + 已注册子 agent（子 agent 派发时懒注册）。
  repl.registerAgent("supervisor", DRAFT_SESSION);
  for (const definition of agentRegistry.list()) repl.registerAgent(definition.name, DRAFT_SESSION);
  repl.start();
  await refreshBars();
  await exited;
  repl.stop();
  // 离开备用屏后清掉标题，避免退出后外层 shell 沿用 swarm 的标题。
  resetTerminalTitle();
}

await pool.disposeAll();
await draftAgent.close();
output.dispose();
console.log("pi-swarm 已退出。");
