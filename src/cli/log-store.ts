import { useSyncExternalStore } from "react";

export interface LogSnapshot {
  lines: string[];
  /** Partial line being streamed by the worker, rendered below the log. */
  tail: string;
}

/**
 * Log buffer shared between the worker (non-React) and the Ink app.
 * Deltas from the Pi session accumulate in `tail` and flush into `lines` on newline.
 */
export class LogStore {
  private lines: string[] = [];
  private tail = "";
  private snapshot: LogSnapshot = { lines: [], tail: "" };
  private readonly listeners = new Set<() => void>();

  public append(line: string): void {
    this.lines = [...this.lines, ...line.split("\n")];
    this.publish();
  }

  public appendStream(delta: string): void {
    const pieces = (this.tail + delta).split("\n");
    this.tail = pieces.pop() ?? "";
    this.lines = [...this.lines, ...pieces];
    this.publish();
  }

  public subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  public getSnapshot = (): LogSnapshot => this.snapshot;

  private publish(): void {
    this.snapshot = { lines: this.lines, tail: this.tail };
    for (const listener of this.listeners) listener();
  }
}

export function useLogStore(store: LogStore): LogSnapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
