import { stdin as input, stdout as output } from "node:process";
import { loadEnvFile } from "node:process";
import { resolve } from "node:path";
import { EventBus } from "../core/event-bus.ts";
import { Supervisor } from "../core/supervisor.ts";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { ModelsDevCatalog, type ModelsDevProvider } from "../models-dev/catalog.ts";
import { JsonFileConfigStore } from "../core/config/json-file-config-store.ts";
import { JsonFileSessionStore } from "../core/session/json-file-session-store.ts";
import { SessionManager } from "../core/session/session-manager.ts";
import { dim } from "../core/ansi.ts";
import { SupervisorAgent } from "../pi/supervisor-agent.ts";
import { SubAgent } from "../pi/sub-agent.ts";
import { TuiRepl, summarizeToolArgs } from "./tui-repl.ts";
import { AgentRegistry, defaultAgentDirs } from "../core/agent-registry.ts";
import { executeCommand, type CommandServices, type CommandState } from "./commands.ts";

try {
  loadEnvFile(resolve(process.cwd(), ".env"));
} catch (error) {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
}

// 终端能力缺失时（如 stdin 被重定向）ProcessTerminal 会自动降级，不硬退。
// Streams and log lines route into the interactive REPL once it exists; before
// that they fall back to plain stdout.
let repl: TuiRepl | undefined;
const log = (line: string, agent = "supervisor"): void => {
  if (repl) repl.appendLine(line, agent);
  else console.log(line);
};
const streamText = (delta: string, agent = "supervisor"): void => {
  if (repl) repl.streamText(delta, agent);
  else process.stdout.write(delta);
};
const streamThinking = (delta: string, agent = "supervisor"): void => {
  if (repl) repl.streamThinking(delta, agent);
  else process.stdout.write(dim(delta));
};
const endStream = (agent = "supervisor"): void => repl?.endStream(agent);
// Tool calls render as live lines in the transcript; without a REPL they log
// start/end lines to stdout.
const toolStart = (id: string, name: string, args: unknown, agent: string): void => {
  if (repl) {
    repl.toolStart(agent, id, name, args);
    return;
  }
  const summary = summarizeToolArgs(args);
  log(`[${agent}] 🔧 ${name}${summary ? ` ${summary}` : ""} …`, agent);
};
const toolEnd = (id: string, _name: string, isError: boolean, agent: string): void => {
  if (repl) {
    repl.toolEnd(agent, id, isError);
    return;
  }
  log(`[${agent}] ${isError ? "✘" : "✔"} 工具调用结束`, agent);
};

// One shared runtime: /provider and /model register once and apply to the
// supervisor session and every sub-agent session alike.
const sharedRuntime = await ModelRuntime.create({ refreshOnCreate: false });
const modelsCatalog = new ModelsDevCatalog({
  onUpdate: (info) => {
    if (info.source === "refresh" && info.updated) {
      log(`[主 agent] models.dev 目录已在后台更新：${info.count} 个 providers。`);
    }
  }
});

// Sub-agents are user-created markdown definitions (global + project dirs);
// none are pre-provisioned, matching the "no initial sub-agents" architecture.
const agentRegistry = await AgentRegistry.load(defaultAgentDirs(), (warning) =>
  log(`[主 agent] agent 定义告警（${warning.file}）：${warning.problems.join("；")}`)
);

const events = new EventBus();
const configStore = new JsonFileConfigStore();
// Session management: persistent JSONL conversations under the user data dir;
// initialize() still loads the index (needed by /sessions), then startup always
// creates a fresh session — old ones remain switchable via /sessions + /switch.
const sessionStore = new JsonFileSessionStore();
const sessionManager = new SessionManager({ cwd: process.cwd(), store: sessionStore });
await sessionManager.initialize();
const startupRecord = await sessionManager.create();
const startupSession: Awaited<ReturnType<typeof sessionManager.bind>> = await sessionManager.bind(
  startupRecord.id
);
log(`[主 agent] 已新建会话：${startupRecord.name ?? startupRecord.id}（${startupRecord.id}）`);
// Sub-agent sessions are created lazily on first dispatch and reused after;
// the supervisor and supervisor-agent reference each other lazily, so both
// bindings carry explicit types.
const subAgents = new Map<string, SubAgent>();
const supervisorAgent: SupervisorAgent = new SupervisorAgent({
  modelRuntime: sharedRuntime,
  onText: streamText,
  onThinking: streamThinking,
  onStreamEnd: endStream,
  onToolStart: toolStart,
  onToolEnd: toolEnd,
  configStore,
  sessionManager: startupSession,
  agents: agentRegistry,
  // Forwarder: `supervisor` is declared right after; run() only fires on dispatch.
  stepExecutor: { run: (job) => supervisor.run(job) },
  log
});
const supervisor: Supervisor = new Supervisor((name) => {
  let agent = subAgents.get(name);
  if (!agent) {
    const definition = agentRegistry.get(name);
    if (!definition) throw new Error(`未注册的 agent：${name}`);
    agent = new SubAgent({
      definition,
      modelRuntime: sharedRuntime,
      resolveModel: () => supervisorAgent.currentModel,
      onText: streamText,
      onThinking: streamThinking,
      onStreamEnd: endStream,
      onToolStart: toolStart,
      onToolEnd: toolEnd
    });
    // Lazy dispatch: make sure the sub-agent has a tab in the TUI.
    repl?.registerAgent(name);
    subAgents.set(name, agent);
  }
  return agent;
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
const restoredModelId =
  restoredProvider && savedConfig.model?.startsWith(`${restoredProvider.id}/`)
    ? savedConfig.model.slice(restoredProvider.id.length + 1)
    : undefined;

console.log("pi-swarm 主 agent 已启动。");
const loadedAgents = agentRegistry.list();
console.log(loadedAgents.length > 0 ? `已加载子 agent：${loadedAgents.map((agent) => agent.name).join(", ")}` : "未加载任何子 agent，所有任务由 supervisor 自执行。");
console.log(
  "输入任务，/provider /model /thinking 打开选择弹窗，/apikey <key> 配置密钥，/new /sessions /switch /close 管理会话，/status 查看状态，或 /exit 退出。\n"
);

log(`[主 agent] ${await supervisorAgent.restore()}`);
void modelsCatalog.prefetch();

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
    log,
    // getter：repl 在 services 之后才创建；/switch 历史回放直接驱动它的组件
    get repl() {
      return repl;
    },
    pick: (title, options) => repl!.pick(title, options)
  };
  repl = new TuiRepl({
    onSubmit: async (line) => {
      // 必须把结果透传（如 "exit"），否则 /exit 永远不会结束进程。
      return await executeCommand(line, services, commandState);
    },
    onExit: settleExit
  });
  // Tabs: supervisor plus every registry agent; later dispatches register lazily.
  repl.registerAgent("supervisor");
  for (const definition of agentRegistry.list()) repl.registerAgent(definition.name);
  repl.start();
  await exited;
  repl.stop();
}

await supervisor.close();
await supervisorAgent.close();
console.log("pi-swarm 已退出。");
