import { join } from "node:path";
import type { AgentDefinition } from "../core/agent-format.ts";
import { ToolObservationCollector, type ToolObservation } from "../core/tool-observation.ts";
import { getUserDataDir } from "../core/userdata.ts";
import { forwardAssistantEvent } from "./assistant-stream.ts";
import {
  BUDGET_LIMITS,
  StepTimeoutError,
  describeError,
  isRetryableError,
  type StepRecord
} from "../core/task-run.ts";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  type ModelRuntime
} from "@earendil-works/pi-coding-agent";

export interface SubAgentOptions {
  definition: AgentDefinition;
  /** Shared runtime: provider/model configuration registered by /provider applies here too. */
  modelRuntime: ModelRuntime;
  /** Working directory for the agent session; defaults to the project root. */
  cwd?: string;
  /** Returns the current global default model (provider/model) when one is configured. */
  resolveModel?: () => string | undefined;
  /** Streams assistant text (the model's answer), labeled with the agent name. */
  onText: (delta: string, agent: string) => void;
  /** Streams reasoning/thinking deltas, labeled with the agent name. */
  onThinking: (delta: string, agent: string) => void;
  /** Called when a streaming response finishes (or fails) to flush UI tails. */
  onStreamEnd: (agent: string) => void;
  /** A tool call started in this agent's session (args as delivered). */
  onToolStart: (toolCallId: string, toolName: string, args: unknown, agent: string) => void;
  /** A tool call finished; isError marks failed calls. */
  onToolEnd: (toolCallId: string, toolName: string, isError: boolean, agent: string) => void;
  /** Per-attempt wall-clock limit; the session is aborted when it fires. */
  timeoutMs?: number;
}

/**
 * A user-defined sub-agent: one long-lived Pi session per agent definition,
 * created lazily on first dispatch. Each run returns a StepRecord built from
 * real observation — tool events for files/errors, the session's final
 * assistant text as the narrative summary. Transient failures (network,
 * timeout) are retried once in the same session with failure feedback;
 * semantic failures come back as a failed record for the supervisor to judge.
 */
export class SubAgent {
  private session?: AgentSession;
  private unsubscribe?: () => void;
  private collector?: ToolObservationCollector;
  private readonly cwd: string;

  public constructor(private readonly options: SubAgentOptions) {
    this.cwd = options.cwd ?? process.cwd();
  }

  public async run(step: { id: string; goal: string }): Promise<StepRecord> {
    const timeoutMs = this.options.timeoutMs ?? BUDGET_LIMITS.stepTimeoutMs;
    let lastError: unknown;
    for (let attempt = 0; ; attempt += 1) {
      try {
        const prompt = attempt === 0
          ? `Step ${step.id}: ${step.goal}\nWhen done, summarize what you changed, tests, and risks.`
          : `Step ${step.id}（重试）：${step.goal}\n\n上一次尝试未完成：${describeError(lastError)}\n请修正问题并完成该步骤，完成后总结改动、测试与风险。`;
        await this.promptWithTimeout(prompt, timeoutMs);
        return this.completeRecord(step);
      } catch (error) {
        lastError = error;
        if (attempt >= BUDGET_LIMITS.maxRetries || !isRetryableError(error)) break;
      }
    }
    const timedOut = lastError instanceof StepTimeoutError;
    return {
      ...this.completeRecord(step),
      status: timedOut ? "timeout" : "failed",
      error: describeError(lastError)
    };
  }

  /** Builds a record from the session's current observation and final text. */
  private completeRecord(step: { id: string; goal: string }): StepRecord {
    const observation = this.currentObservation();
    return {
      id: step.id,
      agent: this.options.definition.name,
      goal: step.goal,
      status: "completed",
      summary: this.session?.getLastAssistantText() ?? "",
      changedFiles: observation.changedFiles,
      toolCalls: observation.toolCalls,
      error: observation.errors.length > 0 ? observation.errors.join("；") : undefined
    };
  }

  private currentObservation(): ToolObservation {
    return this.collector?.observation ?? { toolCalls: 0, errors: [], changedFiles: [] };
  }

  /**
   * One prompt attempt. The wall-clock race rejects while the prompt is still
   * in flight, so a timeout aborts the session and waits for the aborted turn
   * to settle before the retry (the session stays usable afterwards).
   */
  private async promptWithTimeout(prompt: string, timeoutMs: number): Promise<void> {
    const session = await this.ensureSession();
    this.collector = new ToolObservationCollector();
    const run = session.prompt(prompt);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new StepTimeoutError(`步骤超时（${Math.round(timeoutMs / 60000)} 分钟），已中断`)), timeoutMs);
    });
    try {
      await Promise.race([run, timeout]);
    } catch (error) {
      if (error instanceof StepTimeoutError) {
        await session.abort().catch(() => undefined);
        await run.catch(() => undefined);
      }
      throw error;
    } finally {
      clearTimeout(timer);
      // Flush the streaming tail on success, timeout, and failure alike — same
      // semantics as SupervisorAgent.promptModel; keeps retries residue-free.
      this.options.onStreamEnd(this.options.definition.name);
    }
  }

  private async ensureSession(): Promise<AgentSession> {
    if (this.session) return this.session;
    const { definition } = this.options;
    const agentDir = join(getUserDataDir(), "sub-agents", definition.name);
    const resourceLoader = new DefaultResourceLoader({
      cwd: this.cwd,
      agentDir,
      appendSystemPromptOverride: (base) => [
        ...base,
        `You are the "${definition.name}" sub-agent. ${definition.description}`,
        definition.systemPrompt
      ]
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd: this.cwd,
      resourceLoader,
      sessionManager: SessionManager.inMemory(),
      modelRuntime: this.options.modelRuntime,
      // The frontmatter tools list becomes the session's tool allowlist.
      ...(definition.tools.length > 0 ? { tools: definition.tools } : {})
    });
    this.session = session;
    this.unsubscribe = session.subscribe((event) => {
      this.collector?.handle(event);
      forwardAssistantEvent(event, {
        appendText: () => undefined,
        onText: (delta) => this.options.onText(delta, definition.name),
        onThinking: (delta) => this.options.onThinking(delta, definition.name),
        onToolStart: (toolCallId, toolName, args) =>
          this.options.onToolStart(toolCallId, toolName, args, definition.name),
        onToolEnd: (toolCallId, toolName, isError) =>
          this.options.onToolEnd(toolCallId, toolName, isError, definition.name)
      });
    });
    const model = this.options.resolveModel?.();
    if (model) await this.applyModel(model);
    return session;
  }

  private async applyModel(specifier: string): Promise<void> {
    const separator = specifier.indexOf("/");
    if (separator <= 0 || separator === specifier.length - 1) return;
    const model = this.options.modelRuntime.getModel(specifier.slice(0, separator), specifier.slice(separator + 1));
    if (model) await this.session!.setModel(model);
  }

  public async close(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.session?.dispose();
    this.session = undefined;
  }
}
