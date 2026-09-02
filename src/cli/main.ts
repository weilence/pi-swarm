import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { readFile } from "node:fs/promises";
import { EventBus } from "../core/event-bus.js";
import { ModuleRegistry } from "../core/module-registry.js";
import { Supervisor } from "../core/supervisor.js";
import { MockPiWorker } from "../workers/mock-pi-worker.js";
import { PiSdkWorker } from "../pi/pi-sdk-worker.js";
import type { ModuleDefinition, TaskEnvelope } from "../protocol/contracts.js";

const registryData = JSON.parse(
  await readFile(new URL("../../module-registry.json", import.meta.url), "utf8")
) as { modules: ModuleDefinition[] };
const registry = new ModuleRegistry(registryData.modules);
const events = new EventBus();
const module = registry.get(process.env.PI_SWARM_MODULE ?? registry.list()[0].id);
const workerMode = process.env.PI_SWARM_WORKER ?? "mock";
const worker = workerMode === "pi" ? new PiSdkWorker(`${module.id} manager`) : new MockPiWorker();
const supervisor = new Supervisor(registry, new Map([[module.id, worker]]), events);
const rl = createInterface({ input, output, terminal: true });

console.log("pi-swarm 主 agent 已启动。管理/开发 work agent 将持续复用同一会话。");
console.log(`当前 work agent: ${module.id} (${workerMode})`);
console.log("输入任务，或输入 /exit 退出。\n");

let taskNumber = 0;
await supervisor.start();

try {
  for await (const line of rl) {
    const goal = line.trim();
    if (!goal) continue;
    if (goal === "/exit" || goal === "/quit") break;

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
