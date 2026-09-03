import { join } from "node:path";
import type { AgentDefinition } from "../core/agent-format.ts";
import { getUserDataDir } from "../core/userdata.ts";
import { dim } from "../core/ansi.ts";
import { forwardAssistantEvent } from "./assistant-stream.ts";
import type { StepRequest, StepResult } from "../protocol/contracts.ts";
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
  onText?: (delta: string) => void;
  onThinking?: (delta: string) => void;
  onStreamEnd?: () => void;
}

/**
 * A user-defined sub-agent: one long-lived Pi session per agent definition,
 * created lazily on first dispatch. The session runs with the Markdown body
 * as its system prompt on the shared ModelRuntime.
 */
export class SubAgent {
  private session?: AgentSession;
  private unsubscribe?: () => void;
  private readonly cwd: string;

  public constructor(private readonly options: SubAgentOptions) {
    this.cwd = options.cwd ?? process.cwd();
  }

  public async run(request: StepRequest): Promise<StepResult> {
    const session = await this.ensureSession();
    try {
      await session.prompt(
        [
          `Step ${request.taskId}: ${request.goal}`,
          "When done, summarize what you changed, tests, and risks."
        ].join("\n")
      );
    } finally {
      this.options.onStreamEnd?.();
    }
    return {
      taskId: request.taskId,
      agent: this.options.definition.name,
      status: "completed",
      changedFiles: [],
      tests: [],
      risks: ["Pi response parsing and changed-file collection are not automated in the prototype."],
      messages: []
    };
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
      modelRuntime: this.options.modelRuntime
    });
    this.session = session;
    this.unsubscribe = session.subscribe((event) => {
      forwardAssistantEvent(event, {
        appendText: () => undefined,
        onText: (delta) => this.options.onText?.(delta),
        onThinking: (delta) => {
          if (this.options.onThinking) this.options.onThinking(delta);
          else process.stdout.write(dim(delta));
        }
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
