import type { ProcessTerminal } from "@earendil-works/pi-tui";

/**
 * Parses an SGR mouse sequence (`\x1b[<b;x;yM|m`, 1-based coords) and keeps
 * only the right (secondary) button press/release.
 */
export function parseRightClick(data: string): { x: number; y: number; release: boolean } | undefined {
  const match = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(data);
  if (!match) return undefined;
  const button = Number(match[1]);
  if ((button & 64) !== 0 || (button & 32) !== 0) return undefined; // wheel / motion
  if ((button & 3) !== 2) return undefined; // right button only
  return { x: Number(match[2]) - 1, y: Number(match[3]) - 1, release: match[4] === "m" };
}

/**
 * Wraps the terminal so right-button presses reach onRightClick: pi-tui
 * consumes every mouse event itself and never re-emits them, so interception
 * must happen before TuiAltScreen sees the input. Press and release are both
 * swallowed; everything else passes through untouched.
 */
export function interceptRightClick(terminal: ProcessTerminal, onRightClick: (x: number, y: number) => void): ProcessTerminal {
  return new Proxy(terminal, {
    get: (target, property) => {
      if (property === "start") {
        return (onInput: (data: string) => void, onResize: () => void): void => {
          target.start((data) => {
            const event = parseRightClick(data);
            if (event) {
              if (!event.release) onRightClick(event.x, event.y);
              return;
            }
            onInput(data);
          }, onResize);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    }
  }) as ProcessTerminal;
}
