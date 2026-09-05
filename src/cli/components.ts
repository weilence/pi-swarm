import { visibleWidth, Component, truncateToWidth, Container, fuzzyFilter, Input, SelectList, Text, wrapTextWithAnsi, type SelectItem } from "@earendil-works/pi-tui";
import { dim } from "../core/ansi.ts";
import { link, SessionEntryState, AgentTabState } from "./tui-repl.ts";
import { getSelectListTheme } from "@earendil-works/pi-coding-agent";
import type { PickerOption } from "./commands.ts";


/**
 * One border edge of the sessions sidebar; the top edge carries the title and
 * the ＋ 新建 link (saves a dedicated row inside the box). Borders live
 * outside the ScrollView so the box stays put while rows scroll.
 */
export class SidebarBorderLine {
  public constructor(private readonly top: boolean) { }

  public render(width: number): string[] {
    if (this.top) {
      const titleGap = "─ 会话 ";
      const newLink = link("pi-swarm://session/draft", dim("＋ 新建"));
      const used = visibleWidth(titleGap) + visibleWidth(newLink) + 1;
      const fill = "─".repeat(Math.max(1, width - 2 - used));
      return [`╭${dim(titleGap)}${newLink} ${dim(fill)}╮`];
    }
    return [`╰${dim("─".repeat(Math.max(1, width - 2)))}╯`];
  }

  public invalidate(): void { }
}
/**
 * Sessions sidebar rows: the draft entry (✎ 草稿， shown while a draft is
 * open) first, then one session per line — current highlighted, closed marked
 * ✕. Every entry is a pi-swarm://session link. Rendered inside a full-height ScrollView (see TuiRepl): overflow is
 * handled by scrolling with a visible scrollbar, not by truncation. The
 * empty-state hint keeps the lazy-creation invariant: startup creates
 * nothing, the first dispatched task does.
 */
export class SessionSidebar implements Component {
  public constructor(private readonly snapshot: () => { entries: readonly SessionEntryState[]; draft: boolean; }) { }

  public render(width: number): string[] {
    const { entries, draft } = this.snapshot();
    // Leave room for the row pad plus clearance from the scrollbar column.
    const labelWidth = Math.max(8, width - 3);
    const lines: string[] = [];
    if (draft) {
      const label = truncateToWidth("✎ 草稿（未保存）", labelWidth);
      lines.push(" " + link("pi-swarm://session/draft", `\x1b[7m${label}\x1b[27m`));
    }
    if (entries.length === 0 && !draft) {
      lines.push(" " + dim("暂无会话"));
      lines.push(" " + dim("输入任务自动创建"));
    }
    for (const entry of entries) {
      const marker = entry.current ? "●" : entry.closed ? "✕" : " ";
      const label = truncateToWidth(`${marker} ${entry.name}`, labelWidth);
      const styled = entry.current ? `\x1b[7m${label}\x1b[27m` : entry.closed ? dim(label) : label;
      lines.push(" " + link(`pi-swarm://session/${encodeURIComponent(entry.id)}`, styled));
    }
    return lines;
  }

  public invalidate(): void { }
}
/** Single-line, right-aligned row of agent tabs; each tab is a pi-swarm://agent link. */
export class AgentTabBar implements Component {
  public constructor(private readonly snapshot: () => readonly AgentTabState[]) { }

  public render(width: number): string[] {
    const tabs = this.snapshot();
    if (tabs.length === 0) return [""];
    const cells = tabs.map((tab) => {
      const label = `${tab.unread ? "● " : ""}${tab.name}`;
      const styled = tab.active ? `\x1b[7m${label}\x1b[27m` : label;
      return link(`pi-swarm://agent/${encodeURIComponent(tab.name)}`, styled);
    });
    const line = cells.join(dim(" │ "));
    const pad = Math.max(0, width - visibleWidth(line));
    return [`${" ".repeat(pad)}${line}`];
  }

  public invalidate(): void { }
}
/**
 * One thinking entry in a transcript: a dim one-line summary that expands to
 * the full dim (width-wrapped) text when clicked, and collapses on click again.
 */
export class CollapsibleReasoning implements Component {
  public readonly id: number;
  private expanded = false;
  private readonly chars: number;
  private readonly body: Text;

  public constructor(id: number, text: string) {
    this.id = id;
    this.chars = [...text].length;
    this.body = new Text(dim(text), 0, 0);
  }

  public toggle(): void {
    this.expanded = !this.expanded;
  }

  public render(width: number): string[] {
    const label = this.expanded
      ? `▾ 思考（${this.chars} 字）· 点击收起`
      : `▸ 思考（${this.chars} 字）· 点击展开`;
    const header = link(`pi-swarm://think/${this.id}`, dim(label));
    return this.expanded ? [header, ...this.body.render(width)] : [header];
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
/** Overlay picker: title, type-to-filter input, fuzzy-filtered select list. */
export class PickerComponent<T> extends Container {
  private readonly searchInput = new Input();
  private list: SelectList;
  private readonly listIndex: number;

  private readonly entries: { option: PickerOption<T>; searchable: string; }[];

  public constructor(
    title: string,
    entries: readonly { option: PickerOption<T>; searchable: string; }[],
    private readonly settle: (value: T | undefined) => void
  ) {
    super();
    this.entries = [...entries];
    this.addChild(new Text(title, 0, 0));
    this.list = this.buildList(this.entries);
    this.listIndex = this.children.length - 1;
    this.addChild(new Text(dim("输入过滤 · Enter 确认 · Esc 取消"), 0, 0));
  }

  private buildList(entries: readonly { option: PickerOption<T>; searchable: string; }[]): SelectList {
    const items: SelectItem[] = entries.map((entry, index) => ({
      value: String(index),
      label: entry.option.label,
      description: entry.option.hint
    }));
    const list = new SelectList(items, Math.min(items.length, 10), getSelectListTheme());
    list.onSelect = (item) => {
      const entry = entries[Number(item.value)];
      this.settle(entry ? entry.option.value : undefined);
    };
    list.onCancel = () => this.settle(undefined);
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

