import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { loadEnvFile } from "node:process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { EventBus } from "../core/event-bus.js";
import { ModuleRegistry } from "../core/module-registry.js";
import { Supervisor } from "../core/supervisor.js";
import { MockPiWorker } from "../workers/mock-pi-worker.js";
import { PiSdkWorker } from "../pi/pi-sdk-worker.js";
import type { ModuleDefinition, TaskEnvelope } from "../protocol/contracts.js";
import type { ConfigurableModuleWorker } from "../core/worker.js";
import { ModelsDevCatalog, parsePiApi, toPiProviderConfig, type ModelsDevProvider } from "../models-dev/catalog.js";

try {
  loadEnvFile(resolve(process.cwd(), ".env"));
} catch (error) {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
}

const registryData = JSON.parse(
  await readFile(new URL("../../module-registry.json", import.meta.url), "utf8")
) as { modules: ModuleDefinition[] };
const registry = new ModuleRegistry(registryData.modules);
const events = new EventBus();
const module = registry.get(process.env.PI_SWARM_MODULE ?? registry.list()[0].id);
const workerMode = process.env.PI_SWARM_WORKER ?? "mock";
const worker: ConfigurableModuleWorker = workerMode === "pi" ? new PiSdkWorker(`${module.id} manager`) : new MockPiWorker();
const modelsCatalog = new ModelsDevCatalog();
let selectedProvider: ModelsDevProvider | undefined;
const supervisor = new Supervisor(registry, new Map([[module.id, worker]]), events);
const rl = createInterface({ input, output, terminal: true });

console.log("pi-swarm 主 agent 已启动。管理/开发 work agent 将持续复用同一会话。");
console.log(`当前 work agent: ${module.id} (${workerMode})`);
console.log("输入任务，/provider <id> [接口类型]，/model [模型]，/thinking level，/status，或输入 /exit 退出。\n");

let taskNumber = 0;
await supervisor.start();

try {
  for await (const line of rl) {
    const goal = line.trim();
    if (!goal) continue;
    if (goal === "/exit" || goal === "/quit") break;
    if (goal === "/status") {
      console.log(`[主 agent] ${worker.status?.() ?? "当前 Worker 不支持运行时状态查询"}`);
      continue;
    }
    if (goal === "/provider" || goal.startsWith("/provider ")) {
      const [, providerId, apiName] = goal.split(/\s+/, 3);
      try {
        const providers = await modelsCatalog.load();
        if (!providerId) {
          console.log(`[主 agent] providers：${providers.map((provider) => `${provider.id} (${provider.name ?? provider.id})`).join(", ")}`);
          continue;
        }
        selectedProvider = providers.find((provider) => provider.id === providerId);
        if (!selectedProvider) throw new Error(`models.dev 中找不到 provider：${providerId}`);
        const api = parsePiApi(apiName);
        const config = toPiProviderConfig(selectedProvider, api);
        console.log(`[主 agent] ${await worker.configureProvider?.(selectedProvider.id, config) ?? "当前 Worker 不支持 provider 配置"}`);
        console.log(`[主 agent] 可用模型：${Object.values(selectedProvider.models).map((model) => model.id).join(", ")}`);
      } catch (error) {
        console.error(`[主 agent] provider 配置失败：${error instanceof Error ? error.message : String(error)}`);
      }
      continue;
    }
    if (goal === "/model") {
      if (!selectedProvider) {
        console.log("[主 agent] 请先使用 /provider <id> 选择 provider。");
      } else {
        console.log(`[主 agent] ${Object.values(selectedProvider.models).map((model) => `${model.id} (${model.name ?? model.id})`).join(", ")}`);
      }
      continue;
    }
    if (goal.startsWith("/model ") && selectedProvider && !goal.slice("/model ".length).includes("/")) {
      const modelId = goal.slice("/model ".length).trim();
      if (!selectedProvider.models[modelId]) {
        console.error(`[主 agent] provider ${selectedProvider.id} 没有模型：${modelId}`);
        continue;
      }
      try {
        console.log(`[主 agent] ${await worker.setModel?.(`${selectedProvider.id}/${modelId}`) ?? "当前 Worker 不支持模型切换"}`);
      } catch (error) {
        console.error(`[主 agent] 模型切换失败：${error instanceof Error ? error.message : String(error)}`);
      }
      continue;
    }
    if (goal.startsWith("/model ")) {
      try {
        console.log(`[主 agent] ${await worker.setModel?.(goal.slice("/model ".length)) ?? "当前 Worker 不支持运行时模型切换"}`);
      } catch (error) {
        console.error(`[主 agent] 模型切换失败：${error instanceof Error ? error.message : String(error)}`);
      }
      continue;
    }
    if (goal.startsWith("/thinking ")) {
      try {
        console.log(`[主 agent] ${await worker.setThinkingLevel?.(goal.slice("/thinking ".length)) ?? "当前 Worker 不支持运行时 thinking 切换"}`);
      } catch (error) {
        console.error(`[主 agent] thinking 切换失败：${error instanceof Error ? error.message : String(error)}`);
      }
      continue;
    }

    taskNumber += 1;
    const task: TaskEnvelope = {
      taskId: `T-${String(taskNumber).padStart(3, "0")}`,
      module: module.id,
      goal,
      workingDirectory: module.path,
      contextFiles: module.contextFiles,
      allowedPaths: module.allowedPaths,
      relatedModules: [],
      requiredTests: [module.testCommand, module.contractCommand]
    };

    try {
      const [result] = await supervisor.dispatch([task]);
      console.log(`\n[主 agent] ${result.status}：${result.module}，变更 ${result.changedFiles.length} 个文件。\n`);
    } catch (error) {
      console.error(`[主 agent] 任务失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
} finally {
  rl.close();
  await supervisor.close();
  console.log("pi-swarm 已退出。");
}
