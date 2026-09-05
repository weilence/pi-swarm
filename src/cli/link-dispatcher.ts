/**
 * OSC 8 link plumbing: `link()` wraps text in a clickable hyperlink and
 * LinkDispatcher fans activated URLs back out to the components that rendered
 * them.
 *
 * pi-tui routes every hyperlink click through one global callback
 * (TuiAltScreenOptions.openUrl) and does no per-component hit-testing, so the
 * dispatcher turns that single callback into a prefix registry: each component
 * registers the scheme it renders and receives its own clicks back. URL
 * grammar (encode in render + decode in the registration) stays with the
 * component that owns it; adding an interactive element no longer touches the
 * REPL.
 */

/** Wraps text in an OSC 8 hyperlink so TuiAltScreen click detection can resolve the url. */
export function link(url: string, text: string): string {
  return `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;
}

export class LinkDispatcher {
  private readonly handlers = new Map<string, (rest: string) => void>();

  /**
   * Registers a URL prefix (e.g. "pi-swarm://session/"); the handler receives
   * the encoded remainder. Returns an unregister function. Prefixes are owned
   * by one component each; per-instance keys (think/{id}) register the full
   * URL and stay for as long as the component can still be clicked.
   */
  public register(prefix: string, handle: (rest: string) => void): () => void {
    this.handlers.set(prefix, handle);
    return () => {
      if (this.handlers.get(prefix) === handle) this.handlers.delete(prefix);
    };
  }

  /** Dispatches to the longest matching prefix; false when nothing claims the url. */
  public dispatch(url: string): boolean {
    let prefix = "";
    let handle: ((rest: string) => void) | undefined;
    for (const [candidate, candidateHandle] of this.handlers) {
      if (url.startsWith(candidate) && candidate.length > prefix.length) {
        prefix = candidate;
        handle = candidateHandle;
      }
    }
    if (!handle) return false;
    handle(url.slice(prefix.length));
    return true;
  }
}
