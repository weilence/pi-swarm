import { stdout } from "node:process";

/**
 * 终端窗口标题（OSC 0）。
 *
 * 标题没有 ISO 级标准：ECMA-48 只定义了 OSC 转义机制本身，参数语义来自
 * xterm 的事实协议——`ESC ] 0 ; <title> BEL` 同时设置窗口标题与图标名，
 * 主流终端（VTE、iTerm2、Terminal.app、Alacritty、kitty、Windows
 * Terminal、conhost）都支持；tmux 默认拦截，需要 allow-passthrough。
 */

/** 剔除控制字符：标题里的 BEL/ESC 会截断或污染转义序列。 */
function sanitize(title: string): string {
  return title.replace(/[\u0000-\u001f\u007f]/g, " ");
}

/** 设置终端窗口标题；stdout 非 TTY（重定向、测试注入）时静默跳过。 */
export function setTerminalTitle(title: string): void {
  if (!stdout.isTTY) return;
  stdout.write(`\x1b]0;${sanitize(title)}\x07`);
}

/**
 * 退出时调用。进入前无法读回原标题（标题查询转义的支持极差），置空交给
 * shell 在下个提示符重写（bash/zsh 主流配置都会）。
 */
export function resetTerminalTitle(): void {
  setTerminalTitle("");
}
