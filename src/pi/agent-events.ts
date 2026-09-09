/** agent 会话流向消费者的单一事件类型：文本/思考流、工具生命周期、流结束。sessionId 标注事件属于哪个并行会话（路由/缓冲归位用）。 */
export type AgentEvent =
  | { type: "text"; agent: string; sessionId?: string; delta: string }
  | { type: "thinking"; agent: string; sessionId?: string; delta: string }
  | { type: "streamEnd"; agent: string; sessionId?: string }
  | { type: "toolStart"; agent: string; sessionId?: string; toolCallId: string; toolName: string; args: unknown }
  | { type: "toolEnd"; agent: string; sessionId?: string; toolCallId: string; toolName: string; isError: boolean };

export type AgentListener = (event: AgentEvent) => void;

/**
 * 轻量类型化事件发射器：替代五回调在层间的穿线。多消费者可并存——今天的
 * 输出路由，以及未来的 transcript 持久化、headless SDK、web UI 都只是新的
 * 订阅者，不再改动 agent 的构造选项。
 */
export class AgentEventEmitter {
  private readonly listeners = new Set<AgentListener>();

  /** 订阅事件流；返回退订函数。 */
  public on(listener: AgentListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public emit(event: AgentEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }
}
