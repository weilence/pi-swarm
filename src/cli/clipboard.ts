import { stdout } from "node:process";

/** OSC 52 载荷上限（base64 字符数）：过长 payload 会被部分终端静默丢弃。 */
const MAX_BASE64 = 100_000;

/**
 * 系统剪贴板写入，走 OSC 52（事实协议）：`ESC ] 52 ; c ; <base64> BEL`。
 *
 * 背景：终端原生的文字选择只作用于屏幕字符网格，既无法按应用的 UI 逻辑块
 * 跨行选择，也没有任何协议让程序回读用户的选区。因此「按聊天块/编辑器内容
 * 复制」只能在应用端做自己的复制动作，再借 OSC 52 写进系统剪贴板。支持：
 * kitty、Alacritty、WezTerm、Windows Terminal、iTerm2 3.5+、VTE；不支持：
 * macOS Terminal.app；tmux 需要 `set -g set-clipboard on`（或 allow-passthrough），
 * 部分终端默认要求用户放行 OSC 52。
 */
export function writeClipboard(text: string): boolean {
  if (!stdout.isTTY || !text) return false;
  const encoded = Buffer.from(text, "utf8").toString("base64");
  if (encoded.length > MAX_BASE64) return false;
  stdout.write(`\x1b]52;c;${encoded}\x07`);
  return true;
}
