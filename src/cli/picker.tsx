import { useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { filterOptions, windowRange, type PickerOption } from "./picker-logic.ts";

export interface PickerProps<T> {
  title: string;
  options: readonly PickerOption<T>[];
  /** Visible rows before scrolling. */
  height?: number;
  onSelect: (value: T) => void;
  onCancel: () => void;
}

/** Popup list with type-to-filter: ↑↓/Ctrl+N,P move, Enter select, Esc/Ctrl+C cancel. */
export function Picker<T>({ title, options, height = 9, onSelect, onCancel }: PickerProps<T>) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const filtered = useMemo(() => filterOptions(options, query), [options, query]);
  const safeIndex = Math.min(index, Math.max(0, filtered.length - 1));
  const { start, end } = windowRange(safeIndex, filtered.length, height);
  const visible = filtered.slice(start, end);

  useInput((input, key) => {
    if (key.return) {
      const option = filtered[safeIndex];
      if (option) onSelect(option.value);
      return;
    }
    if (key.escape || (key.ctrl && input === "c")) {
      onCancel();
      return;
    }
    if (key.upArrow || (key.ctrl && input === "p")) {
      setIndex(Math.max(0, safeIndex - 1));
      return;
    }
    if (key.downArrow || (key.ctrl && input === "n")) {
      setIndex(Math.min(filtered.length - 1, safeIndex + 1));
      return;
    }
    if (key.backspace || key.delete) {
      setQuery(query.slice(0, -1));
      setIndex(0);
      return;
    }
    if (key.ctrl || key.meta || key.shift || key.tab || key.escape || key.leftArrow || key.rightArrow) return;
    if (input) {
      setQuery(query + input);
      setIndex(0);
    }
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      alignSelf="center"
      minWidth={56}
    >
      <Box>
        <Text bold color="cyan">
          {title}
        </Text>
        <Text dimColor> ↑↓选择 · 输入过滤 · Enter 确认 · Esc 取消</Text>
      </Box>
      <Box>
        <Text dimColor>过滤: </Text>
        <Text color="green">{query}</Text>
        <Text inverse>{" "}</Text>
      </Box>
      {visible.length === 0 ? (
        <Text dimColor>（无匹配项）</Text>
      ) : (
        visible.map((option, row) => {
          const selected = start + row === safeIndex;
          return (
            <Box key={`${String(option.value)}`}>
              <Text color={selected ? "cyan" : undefined}>{selected ? "❯ " : "  "}</Text>
              <Text bold={selected} color={selected ? "cyan" : undefined}>
                {option.label}
              </Text>
              {option.hint ? <Text dimColor> {option.hint}</Text> : null}
            </Box>
          );
        })
      )}
      <Text dimColor>
        {filtered.length === 0 ? 0 : start + 1}-{end}/{filtered.length}
        {options.length !== filtered.length ? `（共 ${options.length} 项）` : ""}
      </Text>
    </Box>
  );
}
