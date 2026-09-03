import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

export interface AssistantStreamSinks {
  /** Accumulates assistant text (the model's final answer). */
  appendText: (delta: string) => void;
  /** Streams visible assistant text to the UI. */
  onText?: (delta: string) => void;
  /** Streams reasoning/thinking deltas to the UI (not part of the answer). */
  onThinking?: (delta: string) => void;
  /** A tool call started executing (args as delivered by the model). */
  onToolStart?: (toolCallId: string, toolName: string, args: unknown) => void;
  /** A tool call finished; isError marks failed calls. */
  onToolEnd?: (toolCallId: string, toolName: string, isError: boolean) => void;
}

/**
 * Fan-out for agent session stream events: text deltas feed both the answer
 * buffer and the UI sink, thinking deltas only the UI sink, and tool lifecycle
 * events reach the UI so calls are visible while they run. Providers that
 * deliver reasoning via reasoning_content/reasoning_details are already
 * normalized to thinking_delta by pi-ai.
 */
export function forwardAssistantEvent(event: AgentSessionEvent, sinks: AssistantStreamSinks): void {
  if (event.type === "tool_execution_start") {
    const e = event as unknown as { toolCallId: string; toolName: string; args?: unknown };
    sinks.onToolStart?.(e.toolCallId, e.toolName, e.args);
    return;
  }
  if (event.type === "tool_execution_end") {
    const e = event as unknown as { toolCallId: string; toolName: string; isError?: boolean };
    sinks.onToolEnd?.(e.toolCallId, e.toolName, e.isError === true);
    return;
  }
  if (event.type !== "message_update") return;
  const inner = event.assistantMessageEvent;
  if (inner.type === "text_delta") {
    sinks.appendText(inner.delta);
    sinks.onText?.(inner.delta);
  } else if (inner.type === "thinking_delta") {
    sinks.onThinking?.(inner.delta);
  }
}
