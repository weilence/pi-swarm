import { join } from "node:path";
import type { AgentDefinition } from "../core/agent-format.ts";
import { getUserDataDir } from "../core/userdata.ts";
import { Agent } from "./agent.ts";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelRuntime as PiModelRuntime } from "@earendil-works/pi-coding-agent";

export interface SubAgentOptions {
  definition: AgentDefinition;
  /** Shared runtime: provider/model configuration registered by /provider applies here too. */
  modelRuntime: PiModelRuntime;
  /** Working directory for the agent session; defaults to the project root. */
  cwd?: string;
  /** Returns the current global default model (provider/model) when one is configured. */
  resolveModel?: () => string | undefined;
  /** Returns the supervisor's current thinking level so sub-agents stay in step with it. */
  resolveThinkingLevel?: () => ModelThinkingLevel | undefined;
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
 * A user-defined sub-agent: the one Agent class configured with the
 * definition's prompt and tool allowlist. The session is created lazily on
 * first dispatch, pulls the global default model and thinking level once at
 * creation, and is reused across steps until the process exits.
 */
export function createSubAgent(options: SubAgentOptions): Agent {
  const { definition } = options;
  return new Agent({
    name: definition.name,
    modelRuntime: options.modelRuntime,
    cwd: options.cwd,
    agentDir: join(getUserDataDir(), "sub-agents", definition.name),
    systemPrompt: [
      `You are the "${definition.name}" sub-agent. ${definition.description}`,
      definition.systemPrompt
    ],
    tools: definition.tools,
    resolveModel: options.resolveModel,
    resolveThinkingLevel: options.resolveThinkingLevel,
    timeoutMs: options.timeoutMs,
    onText: options.onText,
    onThinking: options.onThinking,
    onStreamEnd: options.onStreamEnd,
    onToolStart: options.onToolStart,
    onToolEnd: options.onToolEnd
  });
}
