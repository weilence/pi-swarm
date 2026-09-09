import { join } from "node:path";
import type { AgentDefinition } from "../core/agent-format.ts";
import type { ConfigStore } from "../core/config/config-store.ts";
import { getUserDataDir } from "../core/userdata.ts";
import type { StepJob } from "../core/supervisor.ts";
import type { StepRecord } from "../core/task-run.ts";
import { Agent } from "./agent.ts";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelRuntime, SessionManager as PiSessionManager } from "@earendil-works/pi-coding-agent";

/** 执行准则：delegate 工具可用时追加到系统提示。 */
const DELEGATE_GUIDELINES = [
  "任务执行准则：",
  "1. 收到用户任务后先判断：能一步自行完成的直接做；需要多个步骤或适合交给子 agent 的，用 delegate 派发。",
  "2. delegate 一次最多 6 个步骤，无依赖的并行执行；步骤目标要具体、可独立验收。",
  "3. 根据 delegate 返回的真实结果继续决策：再派下一批、换 agent 重做失败步骤，或自己补完剩余工作。",
  "4. 全部完成后向用户输出 markdown 总结：完成了什么、关键变更、失败与风险、后续建议。"
].join("\n");

/** 花名册段：模型可委派的对象清单（delegate 工具的 agent 字段只能取以下 name）。 */
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

export interface AgentFactoryOptions {
  /** Agent 定义（markdown 解析结果）：name、description、prompt 与工具允许名单。 */
  definition: AgentDefinition;
  /** 并行会话命名空间标注（事件路由用）；子 agent 与所属会话的 supervisor 同值。 */
  sessionId?: string;
  /**
   * Shared ModelRuntime：/provider 注册的 provider 对该 agent 会话可见。
   * 协调者传入全局共享实例；子 agent 同样共享，模型/thinking 缺省时经
   * resolveModel/resolveThinkingLevel 拉取全局默认。
   */
  modelRuntime?: ModelRuntime;
  /** Working directory the agent reasons about; defaults to the project root. */
  cwd?: string;
  /** Pi agent directory; defaults depend on the role（见下）。 */
  agentDir?: string;
  /** Config persistence capability（协调者：/provider /model 等配置落盘）。 */
  configStore?: ConfigStore;
  /** Injected Pi session（persistent JSONL or inMemory）；defaults to inMemory. */
  sessionManager?: PiSessionManager;
  /** Returns the current global default model (provider/model) when one is configured. */
  resolveModel?: () => string | undefined;
  /** Returns the supervisor's current thinking level so sub-agents stay in step with it. */
  resolveThinkingLevel?: () => ModelThinkingLevel | undefined;
  /**
   * Delegate capability（协调者专属）：附加 delegate 工具与任务预算。有此能力时
   * 系统提示 = 定义 prompt + 实时花名册 +（可用时）执行准则；没有子 agent 时
   * 自然退化为自执行 agent。
   */
  delegate?: {
    /** Registered agent catalog; drives the roster prompt and the delegate tool. */
    agents: { list(): AgentDefinition[] };
    /** Executes a delegate step on its agent (Supervisor.run). */
    stepExecutor: { run(job: StepJob): Promise<StepRecord> };
    /** Progress log for delegate batches and step lifecycles. */
    log?: (line: string) => void;
  };
  /** Per-attempt wall-clock limit for runStep（子 agent 派发步骤的常用护栏）。 */
  timeoutMs?: number;
  /** Wall clock for status metrics (TTFT, average output speed); defaults to Date.now. */
  now?: () => number;
}

/**
 * 唯一的 agent 工厂：协调者与子 agent 曾是 createSupervisorAgent /
 * createSubAgent 两个入口，但角色差异本来就只是配置——现在收敛为一个
 * createAgent，差异表达为能力组合而不是两个平行工厂：
 *
 * - 传 delegate（协调者）：系统提示按会话开活动态装配（定义 prompt + 实时
 *   花名册 + 执行准则），agentDir 默认 <userData>/agents/<name>，通常配
 *   configStore 与 sessionManager（会话切换/持久化）；
 * - 不传 delegate（子 agent）：系统提示 = 身份行 + 定义 prompt，frontmatter
 *   的 tools 作为工具允许名单，agentDir 默认 <userData>/sub-agents/<name>，
 *   模型/thinking 经 resolve* 拉取全局默认。
 */
export function createAgent(options: AgentFactoryOptions): Agent {
  const { definition, delegate } = options;
  return new Agent({
    name: definition.name,
    sessionId: options.sessionId,
    modelRuntime: options.modelRuntime,
    cwd: options.cwd,
    agentDir: options.agentDir
      ?? (delegate ? undefined : join(getUserDataDir(), "sub-agents", definition.name)),
    systemPrompt: delegate
      ? () => {
          const roster = delegate.agents.list();
          const available = Boolean(delegate.stepExecutor) && roster.length > 0;
          return [
            definition.systemPrompt,
            rosterPrompt(roster),
            ...(available ? [DELEGATE_GUIDELINES] : [])
          ];
        }
      : [
          `You are the "${definition.name}" sub-agent. ${definition.description}`,
          definition.systemPrompt
        ],
    tools: definition.tools,
    configStore: options.configStore,
    sessionManager: options.sessionManager,
    resolveModel: options.resolveModel,
    resolveThinkingLevel: options.resolveThinkingLevel,
    timeoutMs: options.timeoutMs,
    now: options.now,
    ...(delegate ? { delegate } : {})
  });
}
