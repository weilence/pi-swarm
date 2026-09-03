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

export class EventBus {
  private readonly events: EventEnvelope[] = [];

  public publish(event: EventEnvelope): void {
    this.events.push(event);
    console.log(`[event] ${event.type} ${event.source}: ${event.summary}`);
  }

  public all(): EventEnvelope[] {
    return [...this.events];
  }
}
