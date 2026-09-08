import { spawn } from "node:child_process";
import {
  CombinedAutocompleteProvider,
  type AutocompleteItem,
  type AutocompleteProvider,
  type AutocompleteSuggestions,
  fuzzyFilter,
  type SlashCommand
} from "@earendil-works/pi-tui";
import { SLASH_COMMANDS } from "./commands.ts";

/** PATH 探测结果做模块级缓存：多个 provider 实例只探测一次。 */
let fdProbe: Promise<string | null> | undefined;

/**
 * 预热 fd 探测（模块级缓存）。UI 构建时调用可把探测成本提前到首次 @ 之前
 * （Windows 上进程拉起可达百毫秒级）；测试用它消除固定等待的竞态。
 */
export function primeFdProbe(): Promise<string | null> {
  fdProbe ??= probeFdInPath();
  return fdProbe;
}

/** 探测 PATH 上是否有可用的 fd（@ 文件补全的模糊搜索引擎）；没有则返回 null。 */
function probeFdInPath(): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn("fd", ["--version"], { stdio: "ignore" });
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code === 0 ? "fd" : null));
  });
}

/** 命令表条目 → 下拉列表条目：参数提示放在描述列（与 pi 主程序样式一致）。 */
function toAutocompleteItem(command: SlashCommand): AutocompleteItem {
  const parts = [command.argumentHint, command.description].filter(Boolean);
  return {
    value: command.name,
    label: command.name,
    ...(parts.length > 0 && { description: parts.join(" — ") })
  };
}

export interface ChatAutocompleteOptions {
  /** 斜杠命令表；默认 SLASH_COMMANDS。 */
  commands?: readonly SlashCommand[];
  /** 补全基准目录；默认 process.cwd()。 */
  basePath?: string;
  /** 显式指定 fd 可执行文件；null 强制视为未安装（测试用）；undefined = 探测 PATH。 */
  fdPath?: string | null;
  /** 探测不到 fd 时回调一次（UI 层可借此提示：@ 文件补全不可用）。 */
  onFdMissing?: () => void;
  /**
   * 注入文件补全引擎，替代内部按 fdPath 构造的 CombinedAutocompleteProvider。
   * 单测用 mock，不调用真实 fd 进程；null = 显式无引擎（等同 fd 缺失：空结果
   * + 一次性 onFdMissing）；undefined = 按 fdPath 探测 PATH。
   */
  fdEngine?: AutocompleteProvider | null;
}

/**
 * 输入框补全 provider：`/` 斜杠命令 + `@` 文件引用。触发、过滤、
 * Tab/Enter/Esc 键位全部由 pi-tui 的 Editor 内建，本类只负责两个上下文的
 * 候选来源与写回：
 *
 * - 斜杠上下文（仅第一行、光标前以 / 开头）：命令名阶段按 / 后文本模糊匹配
 *   （空串 = 全部命令），参数阶段交给命令自带的 getArgumentCompletions
 *   （如 /context re → reset）。
 * - @ 文件上下文（@ 位于行首或空白之后——词元边界，与 Editor 触发条件一致，
 *   避免把邮箱 user@host 之类误当文件引用）：完全交给
 *   CombinedAutocompleteProvider（fd 模糊搜索：尊重 .gitignore、单次扫描上限
 *   100、打分取 Top 20；目录补 `/` 可继续下钻）。刻意不做斜杠/@ 上下文之外
 *   的补全（如裸路径），普通文本输入不受影响。
 *
 * @ 补全不做任何降级兜底：fd 是唯一引擎，探测不到时返回空并通过
 * {@link ChatAutocompleteOptions.onFdMissing} 提示一次。
 */
export class ChatAutocompleteProvider implements AutocompleteProvider {
  /** @ 词元：行首或空白后的 @，到光标为止（@ 后跟引号时允许词元内含空格）。 */
  private static readonly AT_PREFIX = /(?:^|\s)(@[^"\s]*|@"[^"]*)$/;

  /** 文件补全引擎：注入的 mock 或按 fdPath 构造的 Combined（commands 传空数组，斜杠分支永远为空）。 */
  private files?: AutocompleteProvider;
  private readonly commands: readonly SlashCommand[];
  private readonly basePath: string;
  private readonly fdOverride: string | null | undefined;
  private readonly fdEngine: AutocompleteProvider | null | undefined;
  private readonly onFdMissing?: () => void;
  private fdMissingReported = false;

  constructor(options: ChatAutocompleteOptions = {}) {
    this.commands = options.commands ?? SLASH_COMMANDS;
    this.basePath = options.basePath ?? process.cwd();
    this.fdOverride = options.fdPath;
    this.fdEngine = options.fdEngine;
    this.onFdMissing = options.onFdMissing;
    // 注入引擎直接就绪（null = 显式禁用，applyCompletion 走通用兑底）。
    if (this.fdEngine !== undefined) this.files = this.fdEngine ?? undefined;
    // 走 PATH 探测时提前起跑：用户键到 @ 时探测多半已完成。
    if (this.fdEngine === undefined && this.fdOverride === undefined) void primeFdProbe();
  }

  public async getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options?: { signal: AbortSignal; force?: boolean }
  ): Promise<AutocompleteSuggestions | null> {
    const request = options ?? { signal: new AbortController().signal };
    const currentLine = lines[cursorLine] ?? "";
    const beforeCursor = currentLine.slice(0, cursorCol);

    // 斜杠命令：与 pi-tui Editor 的斜杠菜单判定（isSlashMenuAllowed）一致，只认第一行。
    if (cursorLine === 0 && beforeCursor.startsWith("/")) {
      return await this.slashSuggestions(beforeCursor);
    }
    // @ 文件：任意行可用（Editor 的 @ 触发本就不限行）。
    const atMatch = ChatAutocompleteProvider.AT_PREFIX.exec(beforeCursor);
    if (atMatch) {
      return await this.fileSuggestions(request, atMatch[1]);
    }
    return null;
  }

  public applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string
  ): { lines: string[]; cursorLine: number; cursorCol: number } {
    // @ 文件补全（含 @"引号 形式）：目录不带尾随空格（可继续下钻），文件补一个空格。
    // 候选只可能来自 files 引擎；engine 未就绪时按通用规则整段替换兜底。
    if (prefix.startsWith("@")) {
      if (this.files) {
        return this.files.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
      }
      const currentLine = lines[cursorLine] ?? "";
      const beforePrefix = currentLine.slice(0, cursorCol - prefix.length);
      const afterCursor = currentLine.slice(cursorCol);
      const suffix = item.value.endsWith("/") ? "" : " ";
      const nextLines = [...lines];
      nextLines[cursorLine] = `${beforePrefix}${item.value}${suffix}${afterCursor}`;
      return { lines: nextLines, cursorLine, cursorCol: beforePrefix.length + item.value.length + suffix.length };
    }
    const currentLine = lines[cursorLine] ?? "";
    const beforePrefix = currentLine.slice(0, cursorCol - prefix.length);
    const afterCursor = currentLine.slice(cursorCol);
    // 命令名补全（前缀以 / 开头且位于行首）：替换整个前缀并补一个空格，方便直接接参数；
    // 参数补全：只替换参数前缀本身。
    const isCommandName = prefix.startsWith("/") && beforePrefix.trim() === "";
    const inserted = isCommandName ? `/${item.value} ` : item.value;
    const nextLines = [...lines];
    nextLines[cursorLine] = `${beforePrefix}${inserted}${afterCursor}`;
    return { lines: nextLines, cursorLine, cursorCol: beforePrefix.length + inserted.length };
  }

  /** 斜杠上下文的候选：命令名模糊匹配，或命令参数候选。 */
  private async slashSuggestions(beforeCursor: string): Promise<AutocompleteSuggestions | null> {
    const spaceIndex = beforeCursor.indexOf(" ");
    if (spaceIndex === -1) {
      // 命令名补全：/ 与光标之间还没有空格。
      const prefix = beforeCursor.slice(1);
      const items = fuzzyFilter([...this.commands], prefix, (command) => command.name).map(toAutocompleteItem);
      if (items.length === 0) return null;
      return { items, prefix: beforeCursor };
    }
    // 参数补全：命令名需完全匹配且声明了参数候选。
    const commandName = beforeCursor.slice(1, spaceIndex);
    const argumentPrefix = beforeCursor.slice(spaceIndex + 1);
    const command = this.commands.find((candidate) => candidate.name === commandName);
    const items = await command?.getArgumentCompletions?.(argumentPrefix);
    if (!items || items.length === 0) return null;
    return { items, prefix: argumentPrefix };
  }

  /**
   * @ 上下文的候选。fd 探测只做一次（模块级缓存）；引擎（Combined 实例）
   * 必须在 fd 路径确定后创建——它的构造参数就是 fd 路径，null 等于禁用。
   * 我们的 @ 词元提取是 Combined.extractAtPrefix 规则的严格子集，委托时
   * 必走其 @ 分支，不会漏进裸路径补全分支。
   */
  private async fileSuggestions(
    request: { signal: AbortSignal; force?: boolean },
    token: string
  ): Promise<AutocompleteSuggestions | null> {
    // 引擎来源优先级：注入的 mock（测试）> fdPath 显式指定 > PATH 探测。
    // fd 探测只做一次（模块级缓存）；引擎必须在 fd 路径确定后创建。
    const engine = this.fdEngine !== undefined ? this.fdEngine : await this.ensureFdEngine();
    if (!engine) {
      // 不降级兜底：没有 fd 就没有 @ 补全；每个实例只提示一次。
      if (!this.fdMissingReported) {
        this.fdMissingReported = true;
        this.onFdMissing?.();
      }
      return null;
    }
    return await engine.getSuggestions([token], 0, token.length, request);
  }

  /** 按 fdPath/PATH 探测结果构造真实引擎；不可用时返回 undefined。 */
  private async ensureFdEngine(): Promise<AutocompleteProvider | undefined> {
    if (this.files) return this.files;
    let fdPath: string | null;
    if (this.fdOverride !== undefined) {
      fdPath = this.fdOverride;
    } else {
      fdProbe ??= probeFdInPath();
      fdPath = await fdProbe;
    }
    if (!fdPath) return undefined;
    this.files ??= new CombinedAutocompleteProvider([], this.basePath, fdPath);
    return this.files;
  }
}
