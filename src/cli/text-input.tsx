import { useState } from "react";
import { Box, Text, useInput } from "ink";

export interface TextInputProps {
  onSubmit: (value: string) => void;
  onExit: () => void;
  /** Ignore keys (picker open or task running) but keep the line visible. */
  disabled?: boolean;
}

/** Single-line prompt with cursor editing; Enter submits, Ctrl+C exits. */
export function TextInput({ onSubmit, onExit, disabled = false }: TextInputProps) {
  const [value, setValue] = useState("");
  const [cursor, setCursor] = useState(0);

  useInput(
    (input, key) => {
      if (key.return) {
        const submitted = value;
        setValue("");
        setCursor(0);
        onSubmit(submitted);
        return;
      }
      if (key.ctrl && input === "c") {
        onExit();
        return;
      }
      if (key.leftArrow) {
        setCursor(Math.max(0, cursor - 1));
        return;
      }
      if (key.rightArrow) {
        setCursor(Math.min(value.length, cursor + 1));
        return;
      }
      if (key.backspace || key.delete) {
        if (cursor === 0) return;
        setValue(value.slice(0, cursor - 1) + value.slice(cursor));
        setCursor(cursor - 1);
        return;
      }
      if (key.upArrow || key.downArrow || key.escape || key.tab || key.ctrl || key.meta || key.shift) return;
      if (input) {
        setValue(value.slice(0, cursor) + input + value.slice(cursor));
        setCursor(cursor + input.length);
      }
    },
    { isActive: !disabled }
  );

  const before = value.slice(0, cursor);
  const at = value.slice(cursor, cursor + 1);
  const after = value.slice(cursor + 1);
  return (
    <Box>
      <Text bold color={disabled ? "gray" : "cyan"}>
        {"❯ "}
      </Text>
      <Text dimColor={disabled}>
        {before}
        {at ? <Text inverse>{at}</Text> : <Text inverse>{" "}</Text>}
        {after}
      </Text>
    </Box>
  );
}
