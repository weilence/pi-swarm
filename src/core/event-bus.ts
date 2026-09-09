export type EventType =
  | "task.started"
  | "task.completed"
  | "task.blocked"
  | "contract.changed"
  | "test.failed"
  | "integration.blocked";

export interface EventEnvelope {
  eventId: string;
  taskId: string;
  type: EventType;
  /** Agent name that produced the event. */
  source: string;
  target: string[];
  summary: string;
  artifacts: string[];
}

/**
 * 任务生命周期事件的发布-订阅总线：Supervisor 在编排缝上发布事件，订阅方
 * （CLI 的输出路由、未来的持久化/监控）各自消费。不累积历史——需要回放时
 * 由订阅方自行记录；单个订阅者抛错不阻断其余订阅者与编排主流程。
 */
export class EventBus {
  private readonly listeners = new Set<(event: EventEnvelope) => void>();

  /** 订阅事件流；返回退订函数。 */
  public subscribe(listener: (event: EventEnvelope) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 向全部订阅者扇出事件。 */
  public publish(event: EventEnvelope): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // 消费失败只影响该订阅者，不阻断其余订阅者与任务执行。
      }
    }
  }
}
