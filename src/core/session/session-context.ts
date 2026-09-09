import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ConfigStore } from "../config/config-store.ts";
import type { StepJob } from "../supervisor.ts";
import type { AgentRegistry } from "../agent-registry.ts";
import { EventBus } from "../event-bus.ts";
import { Supervisor } from "../supervisor.ts";
import { SessionNotFoundError } from "./session-types.ts";
import type { SessionRegistry } from "./session-registry.ts";
import type { WorktreeRegistry } from "../worktree/worktree-registry.ts";
import type { Agent } from "../../pi/agent.ts";
import { createAgent } from "../../pi/agent-factory.ts";

/**
 * 一个会话的全部执行资源：该会话专属的 supervisor agent + 它派发出去的
 * 子 agent 池。并行会话的核心单位——不同会话的 context 互不共享任何
 * AgentSession / 子 agent 实例，cwd 各自等于归属作用域的目录。
 */
export interface SessionContext {
  readonly id: string;
  /** 本会话的 supervisor agent（注入了本会话的 PiSessionManager）。 */
  readonly agent: Agent;
  /** 归属作用域名；undefined = 主工作区。 */
  readonly worktree?: string;
  /** 跑一个用户任务（agent.runTask 门面，flows 只需要这一个动作）。 */
  runTask(goal: string): Promise<string>;
  /** 释放整个 context（编排器 + supervisor agent + 子 agent 池）。 */
  close(): Promise<void>;
}

export interface SessionContextPoolOptions {
  sessions: SessionRegistry;
  worktrees: WorktreeRegistry;
  agentRegistry: AgentRegistry;
  modelRuntime: ModelRuntime;
  events: EventBus;
  /** 主工作区目录（未归属 worktree 的会话用）。 */
  cwd: string;
  /** 会话持久化配置（provider/model/thinking），context 创建时 restore。 */
  configStore?: ConfigStore;
  /** delegate 进度日志通道。 */
  delegateLog?: (line: string) => void;
  /** 新 context 创建后回调（main 注入：注册 TUI 标签、接入输出路由）。 */
  onContextCreated?: (context: SessionContext) => void;
  /** 懒创建的子 agent 回调（main 注入：接入输出路由）。 */
  onSubAgent?: (context: SessionContext, agent: Agent, name: string) => void;
}

/**
 * 每会话一个执行上下文的缓存池。创建是 lazy 的（首次对该会话派发任务时），
 * 创建后驻留进程全程（原型不做淘汰）；切换会话/作用域不经过本池——那是
 * 纯视图操作，只有真正要跑任务才需要 context。
 */
export class SessionContextPool {
  private readonly contexts = new Map<string, SessionContext>();

  public constructor(private readonly options: SessionContextPoolOptions) { }

  /** 聚焦会话的 context（仅查缓存，不创建）；无会话/草稿态返回 undefined。 */
  public focused(): SessionContext | undefined {
    const id = this.options.sessions.current()?.id;
    return id ? this.contexts.get(id) : undefined;
  }

  /** 某会话的 context 是否已驻留。 */
  public has(id: string): boolean {
    return this.contexts.has(id);
  }

  /** 某会话是否正在流式输出（无 context = 不忙）。 */
  public isBusy(id: string): boolean {
    return this.contexts.get(id)?.agent.isBusy() ?? false;
  }

  /** 取指定会话的 context；首次访问时创建（bind + restore + 装配编排器）。 */
  public async ensure(id: string): Promise<SessionContext> {
    const existing = this.contexts.get(id);
    if (existing) return existing;
    const context = await this.create(id);
    this.contexts.set(id, context);
    return context;
  }

  /** 释放某会话的 context（close/delete 会话时）；不存在时幂等。 */
  public async dispose(id: string): Promise<void> {
    const context = this.contexts.get(id);
    if (!context) return;
    this.contexts.delete(id);
    await context.close();
  }

  /** 进程退出前释放全部 context。 */
  public async disposeAll(): Promise<void> {
    for (const [id, context] of [...this.contexts]) {
      this.contexts.delete(id);
      await context.close();
    }
  }

  private async create(id: string): Promise<SessionContext> {
    const { sessions, worktrees, agentRegistry, modelRuntime } = this.options;
    const record = sessions.get(id);
    if (!record) throw new SessionNotFoundError(`会话不存在：${id}`);
    // 归属即 cwd：未归属 worktree 的会话落主工作区（bind 内部对同一规则
    // 已做过一次解析——这里的 pathOf 只为子 agent 拿到同一个目录）。
    const cwd = record.worktree ? await worktrees.pathOf(record.worktree) : this.options.cwd;
    const pi = await sessions.bind(id);
    const subAgents = new Map<string, Agent>();
    let supervisorAgent!: Agent;
    let context!: SessionContext;
    // 每 context 一个编排器：子 agent 在本会话内懒创建、cwd 随本会话，
    // 不同会话的 delegate 各用各的实例（隔离是容器模型的硬性要求）。
    const supervisor = new Supervisor((name) => {
      let sub = subAgents.get(name);
      if (!sub) {
        const definition = agentRegistry.get(name);
        if (!definition) throw new Error(`未注册的 agent：${name}`);
        sub = createAgent({
          definition,
          modelRuntime,
          sessionId: id,
          cwd,
          resolveModel: () => supervisorAgent.currentModel,
          resolveThinkingLevel: () => supervisorAgent.currentThinkingLevel
        });
        subAgents.set(name, sub);
        this.options.onSubAgent?.(context, sub, name);
      }
      return { run: (job) => sub!.runStep(job), close: () => sub!.close() };
    }, this.options.events);
    supervisorAgent = createAgent({
      definition: agentRegistry.supervisor,
      modelRuntime,
      configStore: this.options.configStore,
      sessionId: id,
      cwd,
      sessionManager: pi,
      delegate: {
        agents: agentRegistry,
        stepExecutor: { run: (job: StepJob) => supervisor.run(job) },
        log: this.options.delegateLog
      }
    });
    // 从持久化配置恢复 provider/model/thinking（/model 等作用于聚焦会话后
    // 落盘，这里保证晚创建的 context 与早创建的偏好一致）。
    await supervisorAgent.restore();
    context = {
      id,
      agent: supervisorAgent,
      worktree: record.worktree,
      runTask: (goal) => supervisorAgent.runTask(goal),
      close: async () => {
        await supervisor.close();
        await supervisorAgent.close();
        for (const sub of subAgents.values()) await sub.close();
        subAgents.clear();
      }
    };
    this.options.onContextCreated?.(context);
    return context;
  }
}
