/**
 * macOS Alt（Option）组合键兼容性检测与提示。
 *
 * 背景：macOS 终端的 Option 键默认用于输入特殊字符（⌥T → "†"、⌥S → "ß"），
 * 而不是作为 Alt 修饰键发送，因此 alt+s/alt+t 等组合键永远不会到达程序。
 * 两条出路：
 * 1. 在终端设置中启用 "Option as Meta"（各终端入口不同，见下方映射表）；
 * 2. 使用支持 Kitty 键盘协议的终端（协议握手直接上报修饰键，开箱即用）——
 *    pi-tui 的 ProcessTerminal 启动时会握手并把结果暴露在 kittyProtocolActive。
 *
 * 本模块只负责「检测 + 出提示文案」，不改键位行为。
 */

export interface AltKeyEnvironment {
  /** 运行平台（process.platform）。 */
  platform: NodeJS.Platform;
  /** 进程环境变量（只读 TERM_PROGRAM）。 */
  env: NodeJS.ProcessEnv;
  /** Kitty 键盘协议握手是否成功（ProcessTerminal.kittyProtocolActive）。 */
  kittyProtocolActive: boolean;
}

/** 各终端启用 Option as Meta 的入口；key 为 TERM_PROGRAM 的取值。 */
const MAC_OPTION_AS_META_HINTS: Readonly<Record<string, string>> = {
  Apple_Terminal: "终端 → 设置 → 描述文件 → 键盘 → 勾选「将 Option 键用作 Meta 键」",
  "iTerm.app": "iTerm2 → Settings → Profiles → Keys → Option 键设为 Esc+",
  vscode: "VS Code settings.json 设置 terminal.integrated.macOptionIsMeta = true",
  ghostty: "Ghostty 配置添加 macos-option-as-alt = true",
  WezTerm: "wezterm.lua 配置 option_as_alt = \"Both\"",
  Alacritty: "alacritty.toml 的 [window] 段设置 option_as_alt = \"Both\""
};

/**
 * 需要提示时返回一句话指引，否则返回 undefined。
 * 仅在 macOS 且 Kitty 协议未激活时提示——协议激活的终端
 * （kitty/Ghostty/WezTerm/VS Code 1.109+）能直接上报 Alt 修饰键。
 */
export function macAltKeyHint(env: AltKeyEnvironment): string | undefined {
  if (env.platform !== "darwin" || env.kittyProtocolActive) return undefined;
  const fix = MAC_OPTION_AS_META_HINTS[env.env.TERM_PROGRAM ?? ""];
  const fixText =
    fix ??
    "请按所用终端启用 Option as Meta，或改用支持 Kitty 键盘协议的终端（kitty/Ghostty/WezTerm/iTerm2 等）";
  return `macOS 下 Alt 组合键可能无效（Option 默认输入特殊字符）。修复：${fixText}`;
}
