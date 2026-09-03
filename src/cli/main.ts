import { createInterface } from "node:readline/promises";
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
import { TuiRepl } from "./tui-repl.ts";
import { AgentRegistry, defaultAgentDirs } from "../core/agent-registry.ts";
import { executeCommand, type CommandServices, type CommandState } from "./commands.ts";

try {
  loadEnvFile(resolve(process.cwd(), ".env"));
} catch (error) {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
}

const interactive = input.isTTY === true;

// Streams and log lines route into the interactive REPL once it exists; before
// that (and in pipe mode) they fall back to plain stdout.
let repl: TuiRepl | undefined;
const log = (line: string): void => {
  if (repl) repl.appendLine(line);
  else console.log(line);
};
const streamText = (delta: string): void => {
  if (repl) repl.streamText(delta);
  else process.stdout.write(delta);
};
const streamThinking = (delta: string): void => {
  if (repl) repl.streamThinking(delta);
  else process.stdout.write(dim(delta));
};
const endStream = (): void => repl?.endStream();

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
// startup resumes the most recent active session (conversation context included)
// or creates a fresh one.
const sessionStore = new JsonFileSessionStore();
const sessionManager = new SessionManager({ cwd: process.cwd(), store: sessionStore });
await sessionManager.initialize();
// Startup resumes the most recent active session (conversation context included)
// or creates a fresh one; a corrupt/unreadable JSONL degrades to a new session
// instead of crashing the CLI.
const resumedSession = sessionManager.current();
let startupSession: Awaited<ReturnType<typeof sessionManager.bind>>;
try {
  startupSession = await sessionManager.bind((resumedSession ?? (await sessionManager.create())).id);
  if (resumedSession) {
    log(`[主 agent] 已恢复会话：${resumedSession.name ?? resumedSession.id}（${resumedSession.id}）`);
  }
} catch (error) {
  const record = await sessionManager.create();
  startupSession = await sessionManager.bind(record.id);
  log(`[主 agent] 会话恢复失败（${error instanceof Error ? error.message : String(error)}），已新建会话：${record.id}`);
}
// Sub-agent sessions are created lazily on first dispatch and reused after;
// the supervisor and supervisor-agent reference each other lazily, so both
// bindings carry explicit types.
const subAgents = new Map<string, SubAgent>();
const supervisorAgent: SupervisorAgent = new SupervisorAgent({
  modelRuntime: sharedRuntime,
  onText: streamText,
  onThinking: streamThinking,
  onStreamEnd: endStream,
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
      onStreamEnd: endStream
    });
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
  interactive
    ? "输入任务，/provider /model /thinking 打开选择弹窗，/apikey <key> 配置密钥，/new /sessions /switch /close 管理会话，/status 查看状态，或 /exit 退出。\n"
    : "输入任务，/provider <id> [接口类型]，/model [模型]，/thinking level，/apikey <key>，/new [名称]，/sessions，/switch <id|序号>，/close，/status，或输入 /exit 退出。\n"
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

if (interactive) {
  let settleExit!: () => void;
  const exited = new Promise<void>((settle) => {
    settleExit = settle;
  });
  const services: CommandServices = {
    ...sharedServices,
    interactive: true,
    log,
    pick: (title, options) => repl!.pick(title, options)
  };
  repl = new TuiRepl({
    onSubmit: async (line) => {
      await executeCommand(line, services, commandState);
    },
    onExit: settleExit
  });
  repl.start();
  await exited;
  repl.stop();
} else {
  const rl = createInterface({ input, output, terminal: true });
  const services: CommandServices = {
    ...sharedServices,
    interactive: false,
    log,
    pick: async () => undefined
  };
  try {
    for await (const line of rl) {
      if ((await executeCommand(line, services, commandState)) === "exit") break;
    }
  } finally {
    rl.close();
  }
}

await supervisor.close();
await supervisorAgent.close();
console.log("pi-swarm 已退出。");
