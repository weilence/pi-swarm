/** Pure logic shared by the Ink picker component; kept UI-free for tests. */

export interface PickerOption<T> {
  value: T;
  label: string;
  hint?: string;
  /** Extra searchable text, e.g. aliases. */
  keywords?: string;
}

/** Case-insensitive AND-of-terms substring match over label, hint, keywords, and value. */
export function filterOptions<T>(options: readonly PickerOption<T>[], query: string): PickerOption<T>[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [...options];
  return options.filter((option) => {
    const haystacks = [option.label, option.hint ?? "", option.keywords ?? "", String(option.value)].map((text) =>
      text.toLowerCase()
    );
    return terms.every((term) => haystacks.some((haystack) => haystack.includes(term)));
  });
}

/** Scroll window that keeps `index` visible within `height` rows. */
export function windowRange(index: number, count: number, height: number): { start: number; end: number } {
  const safeHeight = Math.max(1, height);
  const maxStart = Math.max(0, count - safeHeight);
  const start = Math.min(Math.max(0, index - Math.floor(safeHeight / 2)), maxStart);
  return { start, end: Math.min(count, start + safeHeight) };
}
