import assert from "node:assert/strict";
import { test } from "node:test";
import { macAltKeyHint } from "../src/cli/alt-key-hint.ts";

test("macAltKeyHint stays silent off macOS and when the kitty protocol is active", () => {
  assert.equal(macAltKeyHint({ platform: "linux", env: {}, kittyProtocolActive: false }), undefined);
  assert.equal(macAltKeyHint({ platform: "win32", env: { TERM_PROGRAM: "Apple_Terminal" }, kittyProtocolActive: false }), undefined);
  // 协议激活的终端（kitty/Ghostty/WezTerm/VS Code 1.109+）能直接上报修饰键。
  assert.equal(macAltKeyHint({ platform: "darwin", env: { TERM_PROGRAM: "Apple_Terminal" }, kittyProtocolActive: true }), undefined);
});

test("macAltKeyHint gives per-terminal Option-as-Meta instructions on macOS", () => {
  const hint = (termProgram: string): string =>
    macAltKeyHint({ platform: "darwin", env: { TERM_PROGRAM: termProgram }, kittyProtocolActive: false })!;

  assert.ok(hint("Apple_Terminal").includes("将 Option 键用作 Meta 键"));
  assert.ok(hint("iTerm.app").includes("Esc+"));
  assert.ok(hint("vscode").includes("macOptionIsMeta"));
  assert.ok(hint("ghostty").includes("macos-option-as-alt"));
  assert.ok(hint("WezTerm").includes("option_as_alt"));
  assert.ok(hint("Alacritty").includes("option_as_alt"));
});

test("macAltKeyHint falls back to generic advice for unknown terminals", () => {
  const hint = macAltKeyHint({ platform: "darwin", env: {}, kittyProtocolActive: false })!;
  assert.ok(hint.includes("Option as Meta"), "generic advice still names the fix");
  assert.ok(hint.includes("Kitty"), "points at kitty-protocol terminals for a no-config fix");
});
