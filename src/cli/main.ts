import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { loadEnvFile } from "node:process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { EventBus } from "../core/event-bus.ts";
import { ModuleRegistry } from "../core/module-registry.ts";
import { Supervisor } from "../core/supervisor.ts";
import { MockPiWorker } from "../workers/mock-pi-worker.ts";
import { PiSdkWorker } from "../pi/pi-sdk-worker.ts";
import type { ModuleDefinition } from "../protocol/contracts.ts";
import type { ConfigurableModuleWorker } from "../core/worker.ts";
import { ModelsDevCatalog, type ModelsDevProvider } from "../models-dev/catalog.ts";
import { JsonFileConfigStore } from "../core/config/json-file-config-store.ts";
import { dim } from "../core/ansi.ts";
import { SupervisorAgent } from "../pi/supervisor-agent.ts";
import { TuiRepl } from "./tui-repl.ts";
import { moduleRegistryFile } from "../core/userdata.ts";
import { AgentRegistry, defaultAgentDirs } from "../core/agent-registry.ts";
import { executeCommand, type CommandServices, type CommandState } from "./commands.ts";

try {
  loadEnvFile(resolve(process.cwd(), ".env"));
} catch (error) {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
}

// Module registry stays for code-module workflows, but a fresh install must
// still start with zero pre-provisioned sub-agents: a missing registry file
// degrades to a single virtual supervisor module instead of crashing.
async function loadModules(): Promise<ModuleDefinition[]> {
  try {
    const data = JSON.parse(await readFile(moduleRegistryFile(), "utf8")) as { modules?: ModuleDefinition[] };
    return Array.isArray(data.modules) ? data.modules : [];
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      console.warn(`[主 agent] 模块注册表读取失败，按空列表继续：${error instanceof Error ? error.message : String(error)}`);
    }
    return [];
  }
}
const moduleDefinitions = await loadModules();
const fallbackModule: ModuleDefinition = {
  id: "supervisor",
  path: process.cwd(),
  contextFiles: [],
  allowedPaths: [],
  testCommand: "npm test",
  contractCommand: ""
};
const registry = new ModuleRegistry(moduleDefinitions.length > 0 ? moduleDefinitions : [fallbackModule]);
const events = new EventBus();
const requestedModuleId = process.env.PI_SWARM_MODULE;
const firstModule = registry.list()[0];
let module = firstModule;
if (requestedModuleId) {
  try {
    module = registry.get(requestedModuleId);
  } catch {
    console.warn(`[主 agent] 模块 ${requestedModuleId} 不在注册表中，回退到 ${firstModule.id}。`);
  }
}
const workerMode = process.env.PI_SWARM_WORKER ?? "mock";
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

const worker: ConfigurableModuleWorker =
  workerMode === "pi"
    ? new PiSdkWorker(`${module.id} manager`, streamText, streamThinking, endStream)
    : new MockPiWorker();
const workers = new Map<string, ConfigurableModuleWorker>([[module.id, worker]]);
for (const extra of registry.list()) {
  if (!workers.has(extra.id)) {
    workers.set(
      extra.id,
      workerMode === "pi" ? new PiSdkWorker(`${extra.id} manager`, streamText, streamThinking, endStream) : new MockPiWorker()
    );
  }
}
// Agents are user-created markdown definitions (global + project dirs); none are
// pre-provisioned, matching the "no initial sub-agents" architecture.
const agentRegistry = await AgentRegistry.load(defaultAgentDirs(), (warning) =>
  log(`[主 agent] agent 定义告警（${warning.file}）：${warning.problems.join("；")}`)
);
for (const agent of agentRegistry.list()) {
  if (!workers.has(agent.name)) {
    workers.set(
      agent.name,
      workerMode === "pi" ? new PiSdkWorker(agent.name, streamText, streamThinking, endStream, agent.systemPrompt) : new MockPiWorker()
    );
  }
}
const modelsCatalog = new ModelsDevCatalog({
  onUpdate: (info) => {
    if (info.source === "refresh" && info.updated) {
      log(`[主 agent] models.dev 目录已在后台更新：${info.count} 个 providers。`);
    }
  }
});
const supervisor = new Supervisor(registry, workers, events);
const configStore = new JsonFileConfigStore();
const supervisorAgent = new SupervisorAgent({
  onText: streamText,
  onThinking: streamThinking,
  onStreamEnd: endStream,
  configStore
});
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

console.log("pi-swarm 主 agent 已启动。管理/开发 work agent 将持续复用同一会话。");
console.log(`当前 work agent: ${module.id} (${workerMode})`);
console.log(
  interactive
    ? "输入任务，/provider /model /thinking 打开选择弹窗，/apikey <key> 配置密钥，/status 查看状态，或 /exit 退出。\n"
    : "输入任务，/provider <id> [接口类型]，/model [模型]，/thinking level，/apikey <key>，/status，或输入 /exit 退出。\n"
);

await supervisor.start();
log(`[主 agent] ${await supervisorAgent.restore()}`);
void modelsCatalog.prefetch();

const commandState: CommandState = {
  selectedProvider: restoredProvider,
  selectedModelId: restoredModelId
};
const sharedServices = {
  agent: supervisorAgent,
  worker,
  catalog: modelsCatalog,
  supervisor,
  module,
  modules: registry.list(),
  agents: agentRegistry,
  selfExecute: (step: { id: string; goal: string }) => supervisorAgent.executeTask(step)
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
    pick: (title, options) => repl!.pick(title, options),
    askUser: (question) => repl!.askQuestion(question)
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
