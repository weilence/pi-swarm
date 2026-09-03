import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

export interface AssistantStreamSinks {
  /** Accumulates assistant text (the model's final answer). */
  appendText: (delta: string) => void;
  /** Streams visible assistant text to the UI. */
  onText?: (delta: string) => void;
  /** Streams reasoning/thinking deltas to the UI (not part of the answer). */
  onThinking?: (delta: string) => void;
}

/**
 * Fan-out for agent session stream events: text deltas feed both the answer
 * buffer and the UI sink, thinking deltas only the UI sink. Providers that
 * deliver reasoning via reasoning_content/reasoning_details are already
 * normalized to thinking_delta by pi-ai.
 */
export function forwardAssistantEvent(event: AgentSessionEvent, sinks: AssistantStreamSinks): void {
  if (event.type !== "message_update") return;
  const inner = event.assistantMessageEvent;
  if (inner.type === "text_delta") {
    sinks.appendText(inner.delta);
    sinks.onText?.(inner.delta);
  } else if (inner.type === "thinking_delta") {
    sinks.onThinking?.(inner.delta);
  }
}
