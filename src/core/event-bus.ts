import type { EventEnvelope } from "../protocol/contracts.ts";

export class EventBus {
  private readonly events: EventEnvelope[] = [];

  public publish(event: EventEnvelope): void {
    this.events.push(event);
    console.log(`[event] ${event.type} ${event.sourceModule}: ${event.summary}`);
  }

  public all(): EventEnvelope[] {
    return [...this.events];
  }
}
