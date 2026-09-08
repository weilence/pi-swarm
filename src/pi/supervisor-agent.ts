import type { AgentDefinition } from "../core/agent-format.ts";
import type { StepJob } from "../core/supervisor.ts";
import type { StepRecord } from "../core/task-run.ts";
import type { ConfigStore } from "../core/config/config-store.ts";
import { builtinSupervisorDefinition } from "../core/agent-registry.ts";
import { Agent } from "./agent.ts";
import type { ModelRuntime, SessionManager as PiSessionManager } from "@earendil-works/pi-coding-agent";

/** Execution guidelines appended when the delegate tool is available. */
const DELEGATE_GUIDELINES = [
  "任务执行准则：",
  "1. 收到用户任务后先判断：能一步自行完成的直接做；需要多个步骤或适合交给子 agent 的，用 delegate 派发。",
  "2. delegate 一次最多 6 个步骤，无依赖的并行执行；步骤目标要具体、可独立验收。",
  "3. 根据 delegate 返回的真实结果继续决策：再派下一批、换 agent 重做失败步骤，或自己补完剩余工作。",
  "4. 全部完成后向用户输出 markdown 总结：完成了什么、关键变更、失败与风险、后续建议。"
].join("\n");

/** Roster section of the system prompt: who the model can delegate to. */
function rosterPrompt(agents: AgentDefinition[]): string {
  if (agents.length === 0) return "当前没有注册任何子 agent：请直接自行完成用户的任务。";
  const briefing = agents
    .map((agent) => {
      const capabilities = agent.capabilities.length > 0 ? `；能力：${agent.capabilities.join("、")}` : "";
      return `- ${agent.name}：${agent.description}${capabilities}`;
    })
    .join("\n");
  return `可用子 agent（delegate 工具的 agent 字段只能取以下 name）：\n${briefing}`;
}

export interface SupervisorAgentOptions {
  /** Working directory the supervisor reasons about; defaults to the repo root. */
  cwd?: string;
  /** Pi agent directory; defaults to a folder under the user data dir to keep the repo clean. */
  agentDir?: string;
  /**
   * Shared ModelRuntime: providers registered via /provider become visible to
   * the supervisor session and every sub-agent session.
   */
  modelRuntime?: ModelRuntime;
  /** Streams assistant text (the model's answer), labeled with the agent name. */
  onText: (delta: string, agent: string) => void;
  /** Streams reasoning/thinking deltas, labeled with the agent name. */
  onThinking: (delta: string, agent: string) => void;
  /** Called when a streaming response finishes (or fails) to flush UI tails. */
  onStreamEnd: (agent: string) => void;
  /** A tool call started in the supervisor session (args as delivered). */
  onToolStart: (toolCallId: string, toolName: string, args: unknown, agent: string) => void;
  /** A supervisor tool call finished; isError marks failed calls. */
  onToolEnd: (toolCallId: string, toolName: string, isError: boolean, agent: string) => void;
  /** When provided, every successful configuration change is persisted. */
  configStore?: ConfigStore;
  /**
   * Injected Pi session (persistent JSONL or inMemory); defaults to inMemory.
   * Switching sessions at runtime goes through rebind() — see the bind
   * contract in docs/session-design.md.
   */
  sessionManager?: PiSessionManager;
  /** Registered sub-agent catalog; drives the roster prompt and the delegate tool. */
  agents?: { list(): AgentDefinition[] };
  /** Executes a delegate step on its agent (Supervisor.run). */
  stepExecutor?: { run(job: StepJob): Promise<StepRecord> };
  /** Progress log for delegate batches and step lifecycles. */
  log?: (line: string) => void;
  /** Overrides the coordinator prompt; defaults to the built-in supervisor definition. */
  definition?: AgentDefinition;
  /** Wall clock for status metrics (TTFT, average output speed); defaults to Date.now. */
  now?: () => number;
}

/**
 * The supervisor wiring of the one Agent class: the coordinator role comes
 * from the (overridable) supervisor definition's prompt plus the live roster,
 * and the delegate capability attaches the delegate tool and task budgets.
 * With no registered agents it degrades to a plain self-executing agent.
 */
export function createSupervisorAgent(options: SupervisorAgentOptions): Agent {
  const agents = options.agents ?? { list: (): AgentDefinition[] => [] };
  const delegateAvailable = Boolean(options.stepExecutor) && agents.list().length > 0;
  return new Agent({
    name: "supervisor",
    modelRuntime: options.modelRuntime,
    cwd: options.cwd,
    agentDir: options.agentDir,
    systemPrompt: () => [
      (options.definition ?? builtinSupervisorDefinition()).systemPrompt,
      rosterPrompt(agents.list()),
      ...(delegateAvailable ? [DELEGATE_GUIDELINES] : [])
    ],
    configStore: options.configStore,
    sessionManager: options.sessionManager,
    now: options.now,
    ...(options.stepExecutor
      ? { delegate: { agents, stepExecutor: options.stepExecutor, log: options.log } }
      : {}),
    onText: options.onText,
    onThinking: options.onThinking,
    onStreamEnd: options.onStreamEnd,
    onToolStart: options.onToolStart,
    onToolEnd: options.onToolEnd
  });
}
