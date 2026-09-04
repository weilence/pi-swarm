/** Preferred arg keys for the one-line tool summary, in priority order. */
const TOOL_SUMMARY_KEYS = ["command", "path", "file_path", "url", "pattern", "query", "name", "skill", "agent"];

/** Flattens whitespace and truncates to a single short line. */
function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 80 ? `${flat.slice(0, 79)}…` : flat;
}

/**
 * One-line human summary of a tool call's arguments: the first meaningful
 * string among known keys (command, path, …), else the first string value.
 * Shared by the live TUI tool rows and the session-history replay so both
 * render tool calls identically.
 */
export function summarizeToolArgs(args: unknown): string {
  if (args == null) return "";
  if (typeof args !== "object") return oneLine(String(args));
  const record = args as Record<string, unknown>;
  for (const key of TOOL_SUMMARY_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return oneLine(value);
  }
  for (const value of Object.values(record)) {
    if (typeof value === "string" && value.trim()) return oneLine(value);
  }
  return "";
}
