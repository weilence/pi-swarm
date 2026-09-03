import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { loadEnvFile } from "node:process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createElement } from "react";
import { render } from "ink";
import { EventBus } from "../core/event-bus.ts";
import { ModuleRegistry } from "../core/module-registry.ts";
import { Supervisor } from "../core/supervisor.ts";
import { MockPiWorker } from "../workers/mock-pi-worker.ts";
import { PiSdkWorker } from "../pi/pi-sdk-worker.ts";
import type { ModuleDefinition } from "../protocol/contracts.ts";
import type { ConfigurableModuleWorker } from "../core/worker.ts";
import { ModelsDevCatalog, type ModelsDevProvider } from "../models-dev/catalog.ts";
import { JsonFileConfigStore } from "../core/config/json-file-config-store.ts";
import { SupervisorAgent } from "../pi/supervisor-agent.ts";
import { InkApp } from "./ink-app.tsx";
import { LogStore } from "./log-store.ts";
import { moduleRegistryFile } from "../core/userdata.ts";
import { executeCommand, type CommandServices, type CommandState } from "./commands.ts";

try {
  loadEnvFile(resolve(process.cwd(), ".env"));
} catch (error) {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
}

const registryData = JSON.parse(
  await readFile(moduleRegistryFile(), "utf8")
) as { modules: ModuleDefinition[] };
const registry = new ModuleRegistry(registryData.modules);
const events = new EventBus();
const module = registry.get(process.env.PI_SWARM_MODULE ?? registry.list()[0].id);
const workerMode = process.env.PI_SWARM_WORKER ?? "mock";
const interactive = input.isTTY === true;
const store = new LogStore();
const log = (line: string): void => {
  if (interactive) store.append(line);
  else console.log(line);
};
const worker: ConfigurableModuleWorker =
  workerMode === "pi"
    ? new PiSdkWorker(`${module.id} manager`, interactive ? (delta) => store.appendStream(delta) : undefined)
    : new MockPiWorker();
const modelsCatalog = new ModelsDevCatalog({
  onUpdate: (info) => {
    if (info.source === "refresh" && info.updated) {
      log(`[主 agent] models.dev 目录已在后台更新：${info.count} 个 providers。`);
    }
  }
});
const supervisor = new Supervisor(registry, new Map([[module.id, worker]]), events);
const configStore = new JsonFileConfigStore();
const supervisorAgent = new SupervisorAgent({
  onText: interactive ? (delta) => store.appendStream(delta) : undefined,
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

if (interactive) {
  let settleExit!: () => void;
  const exited = new Promise<void>((settle) => {
    settleExit = settle;
  });
  const instance = render(
    createElement(
      InkApp,
      { store, agent: supervisorAgent, worker, catalog: modelsCatalog, supervisor, module, initialProvider: restoredProvider, onExit: settleExit }
    ),
    { exitOnCtrlC: false }
  );
  await exited;
  instance.unmount();
} else {
  const rl = createInterface({ input, output, terminal: true });
  const state: CommandState = { taskNumber: 0, selectedProvider: restoredProvider };
  const services: CommandServices = {
    agent: supervisorAgent,
    worker,
    catalog: modelsCatalog,
    interactive: false,
    log,
    pick: async () => undefined,
    supervisor,
    module
  };
  try {
    for await (const line of rl) {
      if ((await executeCommand(line, services, state)) === "exit") break;
    }
  } finally {
    rl.close();
  }
}

await supervisor.close();
await supervisorAgent.close();
console.log("pi-swarm 已退出。");
