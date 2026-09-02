import { readFile } from "node:fs/promises";
import { EventBus } from "../core/event-bus.js";
import { ModuleRegistry } from "../core/module-registry.js";
import { Supervisor } from "../core/supervisor.js";
import { MockPiWorker } from "../workers/mock-pi-worker.js";
import type { ModuleDefinition, TaskEnvelope } from "../protocol/contracts.js";

const registryData = JSON.parse(
  await readFile(new URL("../../module-registry.json", import.meta.url), "utf8")
) as { modules: ModuleDefinition[] };
const registry = new ModuleRegistry(registryData.modules);
const events = new EventBus();
const workers = new Map(registry.list().map((module) => [module.id, new MockPiWorker()]));
const supervisor = new Supervisor(registry, workers, events);

const tasks: TaskEnvelope[] = registry.list().map((module, index) => ({
  taskId: `T-${String(index + 1).padStart(3, "0")}`,
  module: module.id,
  goal: "验证 Supervisor 可以并行派发模块任务并收集结构化结果",
  workingDirectory: module.path,
  contextFiles: module.contextFiles,
  allowedPaths: module.allowedPaths,
  relatedModules: registry.list().filter((candidate) => candidate.id !== module.id).map((candidate) => candidate.id),
  requiredTests: [module.testCommand, module.contractCommand]
}));

const results = await supervisor.dispatch(tasks);
console.log(JSON.stringify({ results, events: events.all() }, null, 2));
