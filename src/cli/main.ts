import { loadEnvFile } from "node:process";
import { basename, resolve } from "node:path";
import { EventBus } from "../core/event-bus.ts";
import { Supervisor } from "../core/supervisor.ts";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { ModelsDevCatalog, type ModelsDevProvider } from "../models-dev/catalog.ts";
import { JsonFileConfigStore } from "../core/config/json-file-config-store.ts";
import { JsonFileSessionStore } from "../core/session/json-file-session-store.ts";
import { SessionRegistry } from "../core/session/session-registry.ts";
import { createAgent } from "../pi/agent-factory.ts";
import type { Agent } from "../pi/agent.ts";
import { AgentRegistry, defaultAgentDirs } from "../core/agent-registry.ts";
import { OutputRouter } from "./output-router.ts";
import { TuiRepl } from "./tui-repl.ts";
import { openDraftSession, deleteSessionById, executeCommand, switchToSessionId, type CommandServices, type CommandState } from "./commands.ts";
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
  // supervisorAgent 声明在后，闭包运行时取值。
  statusSnapshot: () => supervisorAgent.statusSnapshot
});

// REPL 在启动流程中创建；创建前子 agent 懒派发等路径只做空值降级。
let repl: TuiRepl | undefined;

// One shared runtime: /provider and /model register once and apply to the
// supervisor session and every sub-agent session alike.
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
// 编排缝上的任务生命周期事件 → transcript 行（此前直接 console.log，
// REPL 全屏模式下会污染画面；现在与其它输出同路）。
events.subscribe((event) => output.taskEvent(event));
const configStore = new JsonFileConfigStore();
// Session management: persistent JSONL conversations under the user data dir.
// initialize() only loads the index (needed by /sessions); no session is
// created here — the first dispatched task auto-creates one (dispatchTask),
// so an untouched startup leaves nothing on disk. Old sessions stay
// switchable via /sessions + /switch.
const sessionStore = new JsonFileSessionStore();
const sessionManager = new SessionRegistry({ cwd: process.cwd(), store: sessionStore });
await sessionManager.initialize();
// Sub-agent sessions are created lazily on first dispatch and reused after;
// the supervisor and the Supervisor (core) reference each other lazily, so both
// bindings carry explicit types.
const subAgents = new Map<string, Agent>();
const supervisorAgent = createAgent({
  definition: agentRegistry.supervisor,
  modelRuntime: sharedRuntime,
  configStore,
  // Forwarder: `supervisor` is declared right after; run() only fires on dispatch.
  delegate: { agents: agentRegistry, stepExecutor: { run: (job) => supervisor.run(job) }, log: (line) => output.log(line) }
});
output.attachAgent(supervisorAgent);
const supervisor: Supervisor = new Supervisor((name) => {
  let agent = subAgents.get(name);
  if (!agent) {
    const definition = agentRegistry.get(name);
    if (!definition) throw new Error(`未注册的 agent：${name}`);
    agent = createAgent({
      definition,
      modelRuntime: sharedRuntime,
      resolveModel: () => supervisorAgent.currentModel,
      resolveThinkingLevel: () => supervisorAgent.currentThinkingLevel
    });
    output.attachAgent(agent);
    // Lazy dispatch: make sure the sub-agent has a tab in the TUI.
    repl?.registerAgent(name);
    subAgents.set(name, agent);
  }
  // The unified Agent speaks runStep; adapt it to the Supervisor's StepRunner.
  return { run: (job) => agent.runStep(job), close: () => agent.close() };
}, events);

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
  "输入任务，/provider /model /thinking 打开选择弹窗，/apikey <key> 配置密钥，/context <n>[k|w|m] 设置上下文容量，/compact 手动压缩上下文（输出中双击 Esc 停止），/new /sessions /switch /close /delete 管理会话，/status 查看状态，或 /exit 退出。\n"
);

output.log(`[主 agent] ${await supervisorAgent.restore()}`);
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
  agent: supervisorAgent,
  catalog: modelsCatalog,
  agents: agentRegistry,
  sessions: sessionManager
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
  // 窗口标题：swarm - 会话名 - 项目目录；草稿/未命名时省略会话段。会话的
  // 延迟创建与切换都经过 refreshBars（/new /switch /close /delete、点侧栏、
  // 首个任务物化），repl 起来后的首次调用即启动标题。
  const updateTerminalTitle = (): void => {
    const name = sessionManager.isDraft() ? "草稿" : sessionManager.current()?.name;
    const cwd = basename(process.cwd());
    setTerminalTitle(name ? `swarm - ${name} - ${cwd}` : `swarm - ${cwd}`);
  };
  // 会话栏与状态栏快照：会话是延迟创建的（启动不建会话、「＋ 新建」只开草稿），
  // 草稿激活时列表顶部多一行「✎ 草稿」；首个任务物化、/new /switch /close
  // 或点击会话之后，都统一在这里刷新。状态栏（模型/上下文/缓存）同批刷新。
  const refreshBars = async (): Promise<void> => {
    if (!repl) return;
    repl.setDraftMode(sessionManager.isDraft());
    repl.setSessions(await sessionManager.list());
    output.refreshStatus();
    updateTerminalTitle();
  };
  repl = new TuiRepl({
    onSubmit: async (line) => {
      // 必须把结果透传（如 "exit"），否则 /exit 永远不会结束进程。
      const outcome = await executeCommand(line, services, commandState);
      await refreshBars();
      return outcome;
    },
    // 会话栏点击："draft" 是未保存草稿（等同 /new），其余为会话 id，走
    // /switch 同一核心流程。右键菜单的删除动作走 /delete 同一核心流程。
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
    // 双击 Esc 停止输出：busy 判断与中止动作都走 supervisor agent。
    isBusy: () => supervisorAgent.isBusy(),
    onAbort: () => supervisorAgent.abort()
  });
  output.attachRepl(repl);
  // Tabs: supervisor plus every registry agent; later dispatches register lazily.
  repl.registerAgent("supervisor");
  for (const definition of agentRegistry.list()) repl.registerAgent(definition.name);
  repl.start();
  await refreshBars();
  await exited;
  repl.stop();
  // 离开备用屏后清掉标题，避免退出后外层 shell 沿用 swarm 的标题。
  resetTerminalTitle();
}

await supervisor.close();
await supervisorAgent.close();
output.dispose();
console.log("pi-swarm 已退出。");
