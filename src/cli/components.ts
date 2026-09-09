import { visibleWidth, truncateToWidth, Container, fuzzyFilter, Input, matchesKey, SelectList, Text, wrapTextWithAnsi, type Component, type SelectItem } from "@earendil-works/pi-tui";
import { getSelectListTheme } from "@earendil-works/pi-coding-agent";
import { dim } from "../core/ansi.ts";
import type { AgentStatusSnapshot } from "../pi/agent.ts";
import type { PickerOption } from "./commands.ts";

/** Fixed column width of the sessions sidebar (labels truncate to fit). */
export const SESSION_SIDEBAR_WIDTH = 22;

/** Render-time snapshot of one entry in the sessions sidebar. */
export interface SessionEntryState {
  id: string;
  name: string;
  current: boolean;
  closed: boolean;
  /** 归属作用域名；undefined = 主工作区（分组展示用）。 */
  worktree?: string;
  /** 该会话正在流式输出（行内 ⏳ 标记）。 */
  busy?: boolean;
  /** 该会话有未读输出（行内 • 标记，切回清零）。 */
  unread?: boolean;
}

/** Render-time snapshot of one tab for the tab bar. */
export interface AgentTabState {
  name: string;
  active: boolean;
  unread: boolean;
}

/** One selectable sidebar row: the draft pseudo-entry or a real session. */
type SidebarRow = { kind: "draft" } | { kind: "group"; label: string } | { kind: "session"; entry: SessionEntryState };

/**
 * 侧栏分组顺序：主工作区永远在最上，其余作用域按首次出现序（即最近活跃
 * 优先，与 entries 的 updatedAt 倒序一致）。
 */
function groupRows(entries: readonly SessionEntryState[]): SidebarRow[] {
  const rows: SidebarRow[] = [];
  const groups = new Map<string, SessionEntryState[]>();
  for (const entry of entries) {
    const key = entry.worktree ?? "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(entry);
  }
  // 稳定排序只把主工作区（空 key）提到最前，其余保持首次出现序。
  const ordered = [...groups.entries()].sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : 0));
  for (const [key, groupEntries] of ordered) {
    rows.push({ kind: "group", label: key || "主工作区" });
    for (const entry of groupEntries) rows.push({ kind: "session", entry });
  }
  return rows;
}

/**
 * One border edge of the sessions sidebar; the top edge carries the title and
 * the ＋ 新建 hint (the n key opens it), the bottom edge lists the navigation
 * keys while the sidebar is focused. Borders live outside the ScrollView so
 * the box stays put while rows scroll.
 */
export class SidebarBorderLine {
  public constructor(
    private readonly top: boolean,
    private readonly focused?: () => boolean
  ) { }

  public render(width: number): string[] {
    if (this.top) {
      const titleGap = "─ 会话 ";
      const newHint = dim("＋ 新建 (n)");
      const used = visibleWidth(titleGap) + visibleWidth(newHint) + 1;
      const fill = "─".repeat(Math.max(1, width - 2 - used));
      return [`╭${dim(titleGap)}${newHint} ${dim(fill)}╮`];
    }
    if (this.focused?.()) {
      const max = Math.max(1, width - 2);
      const hint = truncateToWidth(" ↑↓ 选择 Enter 打开", max);
      const fill = "─".repeat(Math.max(0, max - visibleWidth(hint)));
      return [`╰${dim(hint)}${dim(fill)}╯`];
    }
    return [`╰${dim("─".repeat(Math.max(1, width - 2)))}╯`];
  }

  public invalidate(): void { }
}
/**
 * Sessions sidebar rows: the draft entry (✎ 草稿， shown while a draft is
 * open) under its scope's group header, then one session per line — current
 * highlighted, closed marked ✕. Fully keyboard-driven: while focused, ↑/↓
 * move the selection (the reverse-video row), Enter opens, n starts a draft,
 * d asks to delete, Esc returns to the editor; handleInput reports whether it
 * consumed the key.
 * Rendered inside a full-height ScrollView (see TuiRepl): overflow is handled
 * by scrolling with a visible scrollbar, not by truncation. The empty-state
 * hint keeps the lazy-creation invariant: startup creates nothing, the first
 * dispatched task does.
 */
export class SessionSidebar implements Component {
  private selected = 0;
  private focused = false;

  public constructor(
    private readonly snapshot: () => { entries: readonly SessionEntryState[]; draft: boolean; draftScope?: string; },
    private readonly handlers: {
      onActivate(id: string): void;
      onDeleteRequest(entry: SessionEntryState): void;
      onLeave(): void;
      onSwitchPanel(): void;
    }
  ) { }

  /** Keyboard navigation while focused; returns false for keys it does not own. */
  public handleInput(data: string): boolean {
    if (matchesKey(data, "escape")) {
      this.handlers.onLeave();
      return true;
    }
    if (matchesKey(data, "tab")) {
      this.handlers.onSwitchPanel();
      return true;
    }
    if (matchesKey(data, "up")) {
      this.move(-1);
      return true;
    }
    if (matchesKey(data, "down")) {
      this.move(1);
      return true;
    }
    if (matchesKey(data, "enter")) {
      const row = this.selectedRow();
      if (row?.kind === "session") this.handlers.onActivate(row.entry.id);
      else if (row) this.handlers.onActivate("draft");
      return true;
    }
    if (matchesKey(data, "n")) {
      this.handlers.onActivate("draft");
      return true;
    }
    if (matchesKey(data, "d") || matchesKey(data, "delete")) {
      const row = this.selectedRow();
      if (row?.kind === "session") this.handlers.onDeleteRequest(row.entry);
      return true;
    }
    return false;
  }

  /** Keyboard-focus state: focused shows the selected row and border hints. */
  public setFocused(focused: boolean): void {
    this.focused = focused;
  }

  /** Index of the selection into the rendered rows; 0 when the list is empty. */
  public selectedRowIndex(): number {
    this.clampSelection();
    return this.selected;
  }

  /** The selected row, if any (empty list ⇒ undefined). */
  public selectedEntry(): SessionEntryState | undefined {
    const row = this.selectedRow();
    return row?.kind === "session" ? row.entry : undefined;
  }

  /**
   * Screen row of the selection: row 0 is the border line above the rows
   * viewport, so the selection renders at 1 + index - scrollTop.
   */
  public screenRowOfSelected(scrollTop: number): number {
    return 1 + this.selectedRowIndex() - scrollTop;
  }

  public render(width: number): string[] {
    const rows = this.rows();
    this.clampSelection();
    // Leave room for the row pad plus clearance from the scrollbar column.
    const labelWidth = Math.max(8, width - 3);
    const lines: string[] = [];
    if (rows.length === 0) {
      lines.push(" " + dim("暂无会话"));
      lines.push(" " + dim("输入任务自动创建"));
      return lines;
    }
    rows.forEach((row, index) => {
      if (row.kind === "group") {
        lines.push(" " + dim(truncateToWidth(`⎇ ${row.label}`, labelWidth)));
        return;
      }
      const label =
        row.kind === "draft"
          ? truncateToWidth("✎ 草稿（未保存）", labelWidth)
          : truncateToWidth(
              `${row.entry.current ? "●" : row.entry.closed ? "✕" : " "} ${row.entry.name}${
                row.entry.unread || row.entry.busy ? " " : ""
              }${row.entry.unread ? "•" : ""}${row.entry.busy ? "⏳" : ""}`,
              labelWidth
            );
      const isCurrent = row.kind === "draft" || (row.kind === "session" && row.entry.current);
      const isSelected = this.focused && index === this.selected;
      const isClosed = row.kind === "session" && row.entry.closed;
      const styled = isCurrent || isSelected ? `\x1b[7m${label}\x1b[27m` : isClosed ? dim(label) : label;
      lines.push(" " + styled);
    });
    return lines;
  }

  public invalidate(): void { }

  private rows(): readonly SidebarRow[] {
    const { entries, draft, draftScope } = this.snapshot();
    const rows: SidebarRow[] = groupRows(entries);
    // 草稿行归属当前作用域（物化时盖章的就是它）：插在对应分组头之下，
    // 而不是整张列表的最上面；该作用域还没有会话时在末尾补建分组。
    if (draft) {
      const label = draftScope || "主工作区";
      const header = rows.findIndex((row) => row.kind === "group" && row.label === label);
      if (header >= 0) rows.splice(header + 1, 0, { kind: "draft" });
      else rows.push({ kind: "group", label }, { kind: "draft" });
    }
    return rows;
  }

  private selectedRow(): SidebarRow | undefined {
    this.clampSelection();
    return this.rows()[this.selected];
  }

  /** Keeps the selection inside the (possibly shrunken) row list; group 头不可选中。 */
  private clampSelection(): void {
    const rows = this.rows();
    if (rows.length === 0) {
      this.selected = 0;
      return;
    }
    this.selected = Math.min(this.selected, rows.length - 1);
    let scanned = 0;
    while (rows[this.selected]?.kind === "group" && scanned < rows.length) {
      this.selected = (this.selected + 1) % rows.length;
      scanned += 1;
    }
  }

  private move(delta: number): void {
    const rows = this.rows();
    if (rows.length === 0) return;
    let index = this.selected;
    do {
      index = (index + delta + rows.length) % rows.length;
    } while (rows[index].kind === "group" && index !== this.selected);
    this.selected = index;
  }
}
/** Single-line, right-aligned row of agent tabs; keyboard cycling lives in TuiRepl. */
export class AgentTabBar implements Component {
  public constructor(private readonly snapshot: () => readonly AgentTabState[]) { }

  public render(width: number): string[] {
    const tabs = this.snapshot();
    if (tabs.length === 0) return [""];
    const cells = tabs.map((tab) => {
      const label = `${tab.unread ? "● " : ""}${tab.name}`;
      return tab.active ? `\x1b[7m${label}\x1b[27m` : label;
    });
    const line = cells.join(dim(" │ "));
    const pad = Math.max(0, width - visibleWidth(line));
    return [`${" ".repeat(pad)}${line}`];
  }

  public invalidate(): void { }
}
/**
 * One thinking entry in a transcript: a dim one-line summary that expands to
 * the full dim (width-wrapped) text. Expansion is driven by TuiRepl's
 * transcript-mode key (f toggles every entry).
 */
export class CollapsibleReasoning implements Component {
  private expanded = false;
  private readonly chars: number;
  private readonly body: Text;

  public constructor(public readonly id: number, text: string) {
    this.chars = [...text].length;
    this.body = new Text(dim(text), 0, 0);
  }

  public isExpanded(): boolean {
    return this.expanded;
  }

  public setExpanded(expanded: boolean): void {
    this.expanded = expanded;
  }

  public render(width: number): string[] {
    const label = this.expanded
      ? `▾ 思考（${this.chars} 字）`
      : `▸ 思考（${this.chars} 字）`;
    return this.expanded ? [dim(label), ...this.body.render(width)] : [dim(label)];
  }

  public invalidate(): void {
    this.body.invalidate();
  }
}
/**
 * Live thinking tail: the latest lines of the streaming thinking buffer, dim,
 * capped at 3 rendered lines. Expansion is automatic; folded reasoning still
 * lands in the transcript once the stream moves on.
 */
export class ThinkingTail implements Component {
  private static readonly MAX_LINES = 3;

  public constructor(private readonly buffer: string) { }

  public render(width: number): string[] {
    const wrapped = wrapTextWithAnsi(this.buffer.trim(), Math.max(20, width));
    return wrapped
      .slice(-ThinkingTail.MAX_LINES)
      .map((line, index) => dim(index === 0 ? `▸ ${line}` : `  ${line}`));
  }

  public invalidate(): void { }
}
/** User bubble style: bright white text on a blue background. */
const USER_BUBBLE_BG = "\x1b[48;5;61m";
const USER_BUBBLE_FG = "\x1b[97m";
const USER_BUBBLE_RESET = "\x1b[0m";
/**
 * One user message: a right-aligned chat bubble with a colored background so
 * submitted input stands out from the agent's left-aligned output.
 */
export class UserMessage implements Component {
  public constructor(private readonly message: string) { }

  public render(width: number): string[] {
    const rightMargin = 1;
    const innerMax = Math.max(12, Math.floor(width * 0.7) - 2);
    const lines: string[] = [];
    for (const raw of this.message.split("\n")) {
      lines.push(...(raw.trim() ? wrapTextWithAnsi(raw, innerMax) : [""]));
    }
    const rightEdge = Math.max(0, width - rightMargin);
    return lines.map((line) => {
      const bubbleWidth = visibleWidth(line) + 2; // one padding column per side
      const pad = Math.max(0, rightEdge - bubbleWidth);
      return `${" ".repeat(pad)}${USER_BUBBLE_BG}${USER_BUBBLE_FG} ${line} ${USER_BUBBLE_RESET}`;
    });
  }

  public invalidate(): void { }
}
/**
 * One tool call in a transcript: a dim running line that mutates in place into
 * ✔/✘ when the call finishes (pi-tui re-renders components each frame).
 */
export class ToolCallLine implements Component {
  private state: "running" | "ok" | "error" = "running";

  public constructor(
    private readonly toolName: string,
    private readonly summary: string
  ) { }

  public finish(isError: boolean): void {
    this.state = isError ? "error" : "ok";
  }

  public render(_width: number): string[] {
    const label = `${this.toolName}${this.summary ? ` ${this.summary}` : ""}`;
    if (this.state === "running") return [dim(`⏳ ${label} …`)];
    const mark = this.state === "ok" ? dim("✔") : "\x1b[31m✘\x1b[0m";
    return [`${mark}${dim(` ${label}`)}`];
  }

  public invalidate(): void { }
}
/** Toast levels: icon, ANSI accent color, pill background, and default delay. */
export type ToastLevel = "info" | "warning" | "error";

const TOAST_STYLE: Record<ToastLevel, { icon: string; color: string; bg: string; text: string; ttlMs: number }> = {
  info: { icon: "ℹ", color: "\x1b[36m", bg: "\x1b[48;5;236m", text: "\x1b[97m", ttlMs: 3_000 },
  warning: { icon: "⚠", color: "\x1b[93m", bg: "\x1b[48;5;58m", text: "\x1b[97m", ttlMs: 6_000 },
  error: { icon: "✘", color: "\x1b[91m", bg: "\x1b[48;5;52m", text: "\x1b[97m", ttlMs: 10_000 }
};

/** Icons for the pre-TUI console fallback (main.ts notify before the REPL). */
export const TOAST_ICONS: Record<ToastLevel, string> = {
  info: TOAST_STYLE.info.icon,
  warning: TOAST_STYLE.warning.icon,
  error: TOAST_STYLE.error.icon
};

/** Simultaneously visible toasts; the oldest is dropped beyond the cap. */
const MAX_TOASTS = 4;

interface ToastEntry {
  id: number;
  message: string;
  level: ToastLevel;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Transient hint stack rendered as solid-background pills above the editor.
 * The stack itself is a screen-level overlay: ChatPanel.syncToastOverlay()
 * mounts it via ui.showOverlay (bottom-right, lifted above the editor,
 * non-capturing) and the TUI composites it over the transcript every frame,
 * so hints cover chat content instead of pushing it up or piling into the
 * transcript. Non-interactive by design — toasts never take focus or keys.
 * A repeat of a visible message extends its stay rather than stacking a
 * duplicate; beyond MAX_TOASTS the oldest entry is dropped. Timers are
 * unref'd so a pending dismissal never blocks exit.
 */
export class ToastStack implements Component {
  private entries: ToastEntry[] = [];
  private nextId = 0;

  public constructor(
    private readonly requestRender: () => void,
    /** Fired after every visual change (also on expiry/clear) — mounts/hides the overlay. */
    private readonly onChange: () => void = requestRender
  ) { }

  /** Shows one toast; ttlMs defaults to the level's delay. */
  public notify(message: string, level: ToastLevel = "info", ttlMs?: number): void {
    const text = message.trim();
    if (!text) return;
    const ttl = ttlMs ?? TOAST_STYLE[level].ttlMs;
    const existing = this.entries.find((entry) => entry.message === text && entry.level === level);
    if (existing) {
      // Same message again: just extend its stay instead of stacking a copy.
      clearTimeout(existing.timer);
      existing.timer = this.startTimer(existing.id, ttl);
      return;
    }
    const id = this.nextId++;
    this.entries.push({ id, message: text, level, timer: this.startTimer(id, ttl) });
    while (this.entries.length > MAX_TOASTS) this.dismiss(this.entries[0].id);
    this.requestRender();
    this.onChange();
  }

  /** Drops every toast and cancels its timers (REPL teardown, tests). */
  public clear(): void {
    if (this.entries.length === 0) return;
    for (const entry of this.entries) clearTimeout(entry.timer);
    this.entries = [];
    this.requestRender();
    this.onChange();
  }

  /** True when nothing is shown; the overlay can stay hidden. */
  public isEmpty(): boolean {
    return this.entries.length === 0;
  }

  /** Natural pill-block width at the given terminal width (0 when empty). */
  public measureWidth(width: number): number {
    return this.entries.length === 0 ? 0 : this.layout(width).pillWidth;
  }

  public render(width: number): string[] {
    if (this.entries.length === 0) return [];
    // `width` IS the pill-block width: the overlay is sized to measureWidth()
    // at mount time, so rendering re-wraps at exactly that width (idempotent —
    // no re-wrap churn between mount and paint). Standalone callers just pass
    // the width they want the pills to span.
    const pillWidth = Math.max(12, width);
    const groups = this.entries.map((entry) => ({
      style: TOAST_STYLE[entry.level],
      wrapped: wrapTextWithAnsi(entry.message, Math.max(8, pillWidth - 4))
    }));
    const lines: string[] = [];
    for (const { style, wrapped } of groups) {
      wrapped.forEach((line, index) => {
        const lead = index === 0 ? `${style.color}${style.icon}${style.text} ` : "  ";
        const content = `${lead}${line}`;
        const pad = Math.max(0, pillWidth - 2 - visibleWidth(content));
        lines.push(`${style.bg} ${content}${" ".repeat(pad + 1)}\x1b[0m`);
      });
    }
    return lines;
  }

  /** Shared pill layout math for render() and measureWidth(). */
  private layout(width: number) {
    const pillMax = Math.max(12, Math.min(width, Math.floor(width * 0.8)));
    const groups = this.entries.map((entry) => ({
      style: TOAST_STYLE[entry.level],
      wrapped: wrapTextWithAnsi(entry.message, Math.max(8, pillMax - 4))
    }));
    const widest = Math.max(...groups.flatMap(({ wrapped }) => wrapped.map((line) => visibleWidth(line))));
    const pillWidth = Math.min(width, widest + 4); // padding column per side + icon + space
    return { groups, pillWidth };
  }

  public invalidate(): void { }

  private startTimer(id: number, ttlMs: number): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => this.dismiss(id), Math.max(0, ttlMs));
    timer.unref?.();
    return timer;
  }

  private dismiss(id: number): void {
    const index = this.entries.findIndex((entry) => entry.id === id);
    if (index === -1) return;
    clearTimeout(this.entries[index].timer);
    this.entries.splice(index, 1);
    this.requestRender();
    this.onChange();
  }
}

/** 1.2k 风格的 token 缩写（≥1000 才缩写，保留 1 位小数）。 */
export function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** 秒的紧凑格式：0.8s / 12.3s / 125s（状态栏首字响应时间用）。 */
export function formatSeconds(ms: number): string {
  const s = ms / 1000;
  return s >= 100 ? `${Math.round(s)}s` : `${s.toFixed(1)}s`;
}

/**
 * 缓存命中率：缓存读取占全部输入侧 token（读取 + 写入 + 未缓存输入）的
 * 比例；没有输入侧数据时 undefined（状态栏整段省略）。
 */
export function cacheHitRate(snapshot: AgentStatusSnapshot): number | undefined {
  const total = (snapshot.cacheRead ?? 0) + (snapshot.cacheWrite ?? 0) + (snapshot.inputTokens ?? 0);
  return total > 0 ? ((snapshot.cacheRead ?? 0) / total) * 100 : undefined;
}

/**
 * 编辑器下方的一行状态栏：模型、thinking、上下文占用、缓存命中率、首字
 * 响应时间、任务平均输出速度、花费、忙碌状态。dim 单行（超宽截断），快照
 * 由 main.ts 在流结束、命令与会话切换后推送；输出中另由定时器每秒推送，
 * 让平均速度随窗口推进。TTFT 与平均速度由 Agent 在快照里算好：窗口从首
 * 字符到本轮结束，任务结束后指标定格保留，直到下一个任务的首字符到达才
 * 刷新。数据缺
 * 失的段整段省略；未选模型时显示占位文本，栏高恒为一行不跳动。
 */
export class StatusBar implements Component {
  private snapshot: AgentStatusSnapshot = {};

  public set(snapshot: AgentStatusSnapshot): void {
    this.snapshot = snapshot;
  }

  public render(width: number): string[] {
    return [truncateToWidth(` ${dim(this.line())}`, Math.max(1, width))];
  }

  public invalidate(): void { }

  private line(): string {
    const s = this.snapshot;
    const parts: string[] = [`⎇ ${s.worktree ?? "主工作区"}`, `模型 ${s.model ?? "未选择"}`];
    if (s.thinkingLevel) parts.push(`thinking ${s.thinkingLevel}`);
    if (s.contextWindow && s.contextWindow > 0) {
      const used = s.contextTokens ?? 0;
      const percent = s.contextPercent ?? (used / s.contextWindow) * 100;
      parts.push(`上下文 ${formatTokens(used)}/${formatTokens(s.contextWindow)}（${percent.toFixed(1)}%）`);
    }
    const rate = cacheHitRate(s);
    if (rate !== undefined) parts.push(`缓存命中 ${rate.toFixed(1)}%`);
    if (s.ttftMs !== undefined) parts.push(`首字 ${formatSeconds(s.ttftMs)}`);
    if (s.avgOutputSpeed !== undefined) {
      const speed = s.avgOutputSpeed;
      parts.push(`速度 ${speed >= 100 ? speed.toFixed(0) : speed.toFixed(1)} tok/s`);
    }
    if (s.cost && s.cost > 0) parts.push(`$${s.cost.toFixed(2)}`);
    if (s.busy) parts.push("任务执行中");
    return parts.join(" · ");
  }
}
/** Spinner 动画帧（与 pi-tui Loader 同款）。 */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * 恰好渲染一个空行的分隔符。不能用 Text("")/Text(" ")：pi-tui 的 Text 对
 * 纯空白文本直接返回零行（曾导致流式空行分隔符全部失效）。
 */
export class BlankLine implements Component {
  public render(_width: number): string[] {
    return [""];
  }

  public invalidate(): void { }
}

/**
 * 转录中的长任务状态行（/compact 这类耗时命令的进行中反馈）：spinner 动画
 * （80ms/帧，requestRender 驱动），完成后原地变 ✔/✘，与工具行同风格。计时器
 * unref，不阻塞进程退出；stop() 供 REPL 关闭时兜底清理。
 */
export class StatusLine implements Component {
  private frame = 0;
  private state: "running" | "ok" | "error" = "running";
  private readonly timer: ReturnType<typeof setInterval>;

  public constructor(
    private readonly label: string,
    private readonly requestRender: () => void
  ) {
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % SPINNER_FRAMES.length;
      this.requestRender();
    }, 80);
    this.timer.unref?.();
  }

  /** 结束状态行：isError 决定 ✔/✘；重复调用无副作用。 */
  public finish(isError: boolean): void {
    if (this.state !== "running") return;
    this.state = isError ? "error" : "ok";
    clearInterval(this.timer);
    this.requestRender();
  }

  /** 停止动画但不改变状态（进程退出前的兕底清理）。 */
  public stop(): void {
    clearInterval(this.timer);
  }

  public render(width: number): string[] {
    const label = truncateToWidth(this.label, Math.max(8, width - 4));
    if (this.state === "running") return [dim(`${SPINNER_FRAMES[this.frame]} ${label} …`)];
    const mark = this.state === "ok" ? dim("✔") : "\x1b[31m✘\x1b[0m";
    return [`${mark}${dim(` ${label}`)}`];
  }

  public invalidate(): void { }
}
/**
 * Delete-confirmation menu on a sidebar session: a small positioned overlay,
 * driven purely by the keyboard (↑/↓/Enter/Esc). The selected row is
 * reverse-videoed.
 */
export class SessionContextMenu {
  private selected = 0;

  public constructor(
    private readonly title: string,
    private readonly actions: readonly { label: string; run(): void }[],
    private readonly close: () => void,
    private readonly requestRender: () => void
  ) { }

  public handleInput(data: string): void {
    if (matchesKey(data, "escape")) {
      this.close();
      return;
    }
    if (matchesKey(data, "up")) {
      this.selected = (this.selected - 1 + this.actions.length) % this.actions.length;
      this.requestRender();
      return;
    }
    if (matchesKey(data, "down")) {
      this.selected = (this.selected + 1) % this.actions.length;
      this.requestRender();
      return;
    }
    if (matchesKey(data, "enter")) {
      const action = this.actions[this.selected];
      this.close();
      action?.run();
    }
  }

  public render(width: number): string[] {
    const labelWidth = Math.max(8, width - 2);
    const lines: string[] = [];
    this.actions.forEach((action, index) => {
      const label = truncateToWidth(action.label, labelWidth);
      lines.push(" " + (index === this.selected ? `\x1b[7m${label}\x1b[27m` : label));
    });
    return lines;
  }

  public invalidate(): void { }
}
/** 弹窗面板底色（深灰）与边框色：与聊天内容明确区分。 */
const PICKER_BG = "\x1b[48;5;234m";
const PICKER_BORDER = "\x1b[36m";

/** 浮层选择弹窗：标题边框面板 + 类型过滤 + 模糊过滤列表。 */
export class PickerComponent<T> extends Container {
  private readonly searchInput = new Input();
  private list: SelectList;
  private readonly listIndex: number;
  private readonly title: string;

  private readonly entries: { option: PickerOption<T>; searchable: string; }[];

  public constructor(
    title: string,
    entries: readonly { option: PickerOption<T>; searchable: string; }[],
    private readonly settle: (value: T | undefined) => void
  ) {
    super();
    this.title = title;
    this.entries = [...entries];
    // 标题只渲染在边框上（见 render），不再加重复的 Text 行。
    this.list = this.buildList(this.entries);
    // 列表必须真正挂进 children：此前漏掉导致弹窗打开时不渲染列表（看起来
    // “默认是空”），直到输入过滤字符才由 applyFilter 把列表错误地顶掉标题。
    this.addChild(this.list);
    this.listIndex = this.children.length - 1;
    this.addChild(new Text(dim("输入过滤 · Enter 确认 · Esc 取消"), 0, 0));
  }

  /**
   * 面板化渲染：实底背景 + 圆角边框 + 标题，覆盖在聊天内容之上。内容行自带
   * 的 SGR reset 会清掉底色，所以在每个 reset 后补回，保证整行实底。
   */
  public render(width: number): string[] {
    const contentWidth = Math.max(24, width - 4); // 两侧边框 + 留白各一列
    const inner = super.render(contentWidth).map((line) =>
      PICKER_BG + line.replace(/\x1b\[0m/g, `\x1b[0m${PICKER_BG}`)
    );
    const pad = (line: string): string => {
      const truncated = truncateToWidth(line, contentWidth);
      // 填充空格也要在底色内（line 可能已用 reset 结尾）。
      return truncated + PICKER_BG + " ".repeat(Math.max(0, contentWidth - visibleWidth(truncated)));
    };
    const titleRow = ` ${this.title} `;
    const fill = "─".repeat(Math.max(1, contentWidth + 1 - visibleWidth(titleRow)));
    return [
      `${PICKER_BORDER}╭─\x1b[0m${PICKER_BG}\x1b[1m${titleRow}\x1b[0m${PICKER_BORDER}${fill}╮\x1b[0m`,
      // 内容行 = │ + 留白 + contentWidth + 留白 + │，与顶/底边框（contentWidth + 4）对齐。
      ...inner.map((line) => `${PICKER_BORDER}│\x1b[0m${PICKER_BG} ${pad(line)} \x1b[0m${PICKER_BORDER}│\x1b[0m`),
      `${PICKER_BORDER}╰${"─".repeat(contentWidth + 2)}╯\x1b[0m`
    ];
  }

  private buildList(entries: readonly { option: PickerOption<T>; searchable: string; }[]): SelectList {
    const items: SelectItem[] = entries.map((entry, index) => {
      const current = entry.option.current === true;
      return {
        value: String(index),
        // 固定两格标记列（● / 空白）：所有选项的文字起点一致，垂直对齐。
        // 当前项已有 ● 标记，描述不再重复“当前”字样。
        label: (current ? "● " : "  ") + entry.option.label,
        ...(entry.option.hint ? { description: entry.option.hint } : {})
      };
    });
    const list = new SelectList(items, Math.min(items.length, 10), getSelectListTheme());
    list.onSelect = (item) => {
      const entry = entries[Number(item.value)];
      this.settle(entry ? entry.option.value : undefined);
    };
    list.onCancel = () => this.settle(undefined);
    // 预选中当前项（SelectList 默认选中第 0 行）：打开弹窗即高亮，Enter 直接确认。
    const current = entries.findIndex((entry) => entry.option.current === true);
    if (current > 0) list.setSelectedIndex(current);
    return list;
  }

  private applyFilter(query: string): void {
    const previous = this.list.getSelectedItem();
    const filtered = query ? fuzzyFilter(this.entries, query, (entry) => entry.searchable) : this.entries;
    this.list = this.buildList(filtered);
    this.children[this.listIndex] = this.list;
    if (previous) {
      const restore = filtered.findIndex((entry) => entry === this.entries[Number(previous.value)]);
      if (restore >= 0) this.list.setSelectedIndex(restore);
    }
  }

  public handleInput(data: string): void {
    if (data === "\r" || data === "\n" || data.startsWith("\x1b")) {
      this.list.handleInput(data);
      return;
    }
    this.searchInput.handleInput(data);
    this.applyFilter(this.searchInput.getValue());
  }
}
