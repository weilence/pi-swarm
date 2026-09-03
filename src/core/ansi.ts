/** Wraps text in ANSI dim (faint) escapes; terminals and Ink pass them through. */
export function dim(text: string): string {
  return `\x1b[2m${text}\x1b[22m`;
}
