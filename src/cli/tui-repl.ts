import {
  Container,
  Editor,
  fuzzyFilter,
  Input,
  type MarkdownTheme,
  Markdown,
  matchesKey,
  type OverlayHandle,
  ProcessTerminal,
  SelectList,
  type SelectItem,
  Text,
  TuiAltScreen,
  type TUI,
  visibleWidth
} from "@earendil-works/pi-tui";
import { getMarkdownTheme, getSelectListTheme, initTheme } from "@earendil-works/pi-coding-agent";
import { dim } from "../core/ansi.ts";
import type { PickerOption } from "./commands.ts";

export interface TuiReplOptions {
  /** Injected TUI for tests; defaults to a ProcessTerminal + TuiAltScreen (fullscreen) pair. */
  ui?: TUI;
  onSubmit: (line: string) => Promise<void>;
  onExit: () => void;
}

/** Agent that owns output when no explicit label is passed. */
const DEFAULT_AGENT = "supervisor";

/** Wraps text in an OSC 8 hyperlink so TuiAltScreen click detection can resolve the url. */
function link(url: string, text: string): string {
  return `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;
}

/** Counts opening code fences so blocks inside ``` pairs stay together. */
function countFences(text: string): number {
  return (text.match(/^[ \t]{0,3}(```|~~~)/gm) ?? []).length;
}

/**
 * Splits a streaming markdown buffer into blocks that are safe to render now
 * (closed code fences, ended by a blank line) plus the incomplete remainder.
 */
export function splitMarkdownBlocks(buffer: string): { blocks: string[]; rest: string } {
  const blocks: string[] = [];
  let rest = buffer;
  const blankLine = /\n[ \t]*\n/g;
  let searchFrom = 0;
  while (rest.length > 0) {
    blankLine.lastIndex = searchFrom;
    const match = blankLine.exec(rest);
    if (!match) break;
    const candidate = rest.slice(0, match.index);
    if (countFences(candidate) % 2 === 1) {
      // blank line inside an open code fence: not a block boundary
      searchFrom = match.index + 1;
      continue;
    }
    blocks.push(candidate);
    rest = rest.slice(match.index + match[0].length);
    searchFrom = 0;
  }
  return { blocks: blocks.map((block) => block.trim()).filter((block) => block.length > 0), rest };
}

/** Per-agent transcript state: the chat window mounts only the active one. */
interface AgentTranscript {
  name: string;
  /** Mounted in the chat window while active; holds log + stream containers. */
  container: Container;
  log: Container;
  stream: Container;
  /** Kind of the live tail: text or thinking; undefined when nothing streams. */
  streamKind?: "text" | "thinking";
  thinkingBuffer: string;
  partialBlock: string;
  unread: boolean;
}

/** Render-time snapshot of one tab for the tab bar. */
interface AgentTabState {
  name: string;
  active: boolean;
  unread: boolean;
}

/** Single-line, right-aligned row of agent tabs; each tab is a pi-swarm://agent link. */
class AgentTabBar {
  public constructor(private readonly snapshot: () => readonly AgentTabState[]) {}

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

  public invalidate(): void {}
}

/**
 * One thinking entry in a transcript: a dim one-line summary that expands to
 * the full dim (width-wrapped) text when clicked, and collapses on click again.
 */
class CollapsibleReasoning {
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

/** Preferred arg keys for the one-line tool summary, in priority order. */
const TOOL_SUMMARY_KEYS = ["command", "path", "file_path", "url", "pattern", "query", "name", "skill", "agent"];

/** Flattens whitespace and truncates to a single short line. */
function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 80 ? `${flat.slice(0, 79)}…` : flat;
}

/**
 * One-line human summary of a tool call's arguments: the first meaningful
 * string among known keys (command, path, …), else the first string value.
 */
export function summarizeToolArgs(args: unknown): string {
  if (args == null) return "";
  if (typeof args !== "object") return oneLine(String(args));
  const record = args as Record<string, unknown>;
  for (const key of TOOL_SUMMARY_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return oneLine(value);
  }
  for (const value of Object.values(record)) {
    if (typeof value === "string" && value.trim()) return oneLine(value);
  }
  return "";
}

/**
 * One tool call in a transcript: a dim running line that mutates in place into
 * ✔/✘ when the call finishes (pi-tui re-renders components each frame).
 */
class ToolCallLine {
  private state: "running" | "ok" | "error" = "running";

  public constructor(
    private readonly toolName: string,
    private readonly summary: string
  ) {}

  public finish(isError: boolean): void {
    this.state = isError ? "error" : "ok";
  }

  public render(_width: number): string[] {
    const label = `${this.toolName}${this.summary ? ` ${this.summary}` : ""}`;
    if (this.state === "running") return [dim(`⏳ ${label} …`)];
    const mark = this.state === "ok" ? dim("✔") : "\x1b[31m✘\x1b[0m";
    return [`${mark}${dim(` ${label}`)}`];
  }

  public invalidate(): void {}
}

/** Overlay picker: title, type-to-filter input, fuzzy-filtered select list. */
class PickerComponent<T> extends Container {
  private readonly searchInput = new Input();
  private list: SelectList;
  private readonly listIndex: number;

  private readonly entries: { option: PickerOption<T>; searchable: string }[];

  public constructor(
    title: string,
    entries: readonly { option: PickerOption<T>; searchable: string }[],
    private readonly settle: (value: T | undefined) => void
  ) {
    super();
    this.entries = [...entries];
    this.addChild(new Text(title, 0, 0));
    this.list = this.buildList(this.entries);
    this.listIndex = this.children.length - 1;
    this.addChild(new Text(dim("输入过滤 · Enter 确认 · Esc 取消"), 0, 0));
  }

  private buildList(entries: readonly { option: PickerOption<T>; searchable: string }[]): SelectList {
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

/**
 * Interactive REPL built on pi-tui: one append-only transcript per agent (log
 * lines + streamed markdown blocks + collapsible thinking entries), a streaming
 * tail for in-progress output, a right-aligned agent tab bar overlay, a
 * multiline editor with history, and overlay pickers.
 */
export class TuiRepl {
  private readonly owned?: { terminal: ProcessTerminal; ui: TuiAltScreen };
  private readonly ui: TUI;
  private readonly inputArea = new Container();
  private readonly editor: Editor;
  private readonly markdownTheme: MarkdownTheme;
  private readonly tabs = new Map<string, AgentTranscript>();
  private activeAgent = DEFAULT_AGENT;
  private thinkSeq = 0;
  private readonly collapsibles = new Map<number, CollapsibleReasoning>();
  /** Live tool calls by "agent/toolCallId"; removed when the call finishes. */
  private readonly toolLines = new Map<string, ToolCallLine>();
  private readonly tabBar: AgentTabBar;
  private readonly tabBarOverlay?: OverlayHandle;
  private pendingAnswer?: (answer: string) => void;

  public constructor(private readonly options: TuiReplOptions) {
    initTheme();
    this.markdownTheme = getMarkdownTheme();
    if (options.ui) {
      this.ui = options.ui;
    } else {
      const terminal = new ProcessTerminal();
      // Fullscreen (alternate-screen) mode: app owns the whole viewport with a
      // scrollable document that follows new output; screen is restored on stop.
      // OSC 8 links (agent tabs, thinking folds) route back into handleLink.
      const ui = new TuiAltScreen(terminal, true, undefined, { openUrl: (url) => this.handleLink(url) });
      this.owned = { terminal, ui };
      this.ui = ui;
    }
    this.editor = new Editor(this.ui, { borderColor: (text) => text, selectList: getSelectListTheme() });
    this.editor.onSubmit = (text) => {
      if (this.pendingAnswer) {
        const settle = this.pendingAnswer;
        this.pendingAnswer = undefined;
        this.setBusy(true);
        settle(text);
        return;
      }
      void this.handleSubmit(text);
    };
    this.inputArea.addChild(this.editor);
    // Chat window mounts only the active transcript's container; the editor
    // stays the last document child so the view follows new output.
    this.ui.addChild(this.inputArea);
    this.registerAgent(DEFAULT_AGENT);
    this.tabBar = new AgentTabBar(() => this.tabStates());
    this.tabBarOverlay = this.ui.showOverlay(this.tabBar, { anchor: "top-right", nonCapturing: true });
    this.ui.addInputListener((data) => {
      if (matchesKey(data, "ctrl+c")) {
        this.options.onExit();
        return { consume: true };
      }
      return undefined;
    });
  }

  public start(): void {
    this.ui.start();
    this.ui.setFocus(this.editor);
  }

  public stop(): void {
    this.owned?.ui.stop();
  }

  /** Registers a tab for an agent (idempotent); the first one becomes active. */
  public registerAgent(name: string): void {
    if (this.tabs.has(name)) return;
    const log = new Container();
    const stream = new Container();
    const container = new Container();
    container.addChild(log);
    container.addChild(stream);
    this.tabs.set(name, {
      name,
      container,
      log,
      stream,
      thinkingBuffer: "",
      partialBlock: "",
      unread: false
    });
    if (this.tabs.size === 1) {
      this.activeAgent = name;
      const index = this.ui.children.indexOf(this.inputArea);
      this.ui.children.splice(index >= 0 ? index : this.ui.children.length, 0, container);
    }
    this.ui.requestRender();
  }

  /** Switches the mounted transcript to the given agent and clears its unread flag. */
  public setActiveAgent(name: string): void {
    const tab = this.tabs.get(name);
    if (!tab || name === this.activeAgent) return;
    const current = this.activeTab();
    const index = this.ui.children.indexOf(current.container);
    if (index >= 0) this.ui.children[index] = tab.container;
    this.activeAgent = name;
    tab.unread = false;
    this.refreshStreamArea();
    this.ui.requestRender();
  }

  /** Handles pi-swarm:// links (agent tabs, thinking folds) from OSC 8 clicks. */
  public handleLink(url: string): void {
    const agentPrefix = "pi-swarm://agent/";
    const thinkPrefix = "pi-swarm://think/";
    if (url.startsWith(agentPrefix)) {
      this.setActiveAgent(decodeURIComponent(url.slice(agentPrefix.length)));
      return;
    }
    if (url.startsWith(thinkPrefix)) {
      const component = this.collapsibles.get(Number(url.slice(thinkPrefix.length)));
      if (component) {
        component.toggle();
        this.ui.requestRender();
      }
    }
  }

  public appendLine(line: string, agent: string = DEFAULT_AGENT): void {
    const tab = this.tabFor(agent);
    // A log line between stream chunks is later content: commit the live tail
    // first so the transcript order matches arrival order.
    this.flushStream(tab);
    tab.log.addChild(new Text(line, 0, 0));
    this.markUnread(tab, agent);
    this.ui.requestRender();
  }

  public streamThinking(delta: string, agent: string = DEFAULT_AGENT): void {
    const tab = this.tabFor(agent);
    // Text → thinking switch: the pending text tail is finished content, commit
    // it so the transcript keeps the model's real interleaved order.
    if (tab.streamKind === "text") this.flushStream(tab);
    tab.streamKind = "thinking";
    tab.thinkingBuffer += delta;
    this.markUnread(tab, agent);
    this.refreshStreamArea();
  }

  public streamText(delta: string, agent: string = DEFAULT_AGENT): void {
    const tab = this.tabFor(agent);
    // Thinking → text switch: fold the thinking run into the transcript, collapsed.
    if (tab.streamKind === "thinking") this.flushStream(tab);
    tab.streamKind = "text";
    const { blocks, rest } = splitMarkdownBlocks(tab.partialBlock + delta);
    for (const block of blocks) this.addMarkdown(tab, block);
    tab.partialBlock = rest;
    this.markUnread(tab, agent);
    this.refreshStreamArea();
  }

  public endStream(agent: string = DEFAULT_AGENT): void {
    const tab = this.tabFor(agent);
    this.flushStream(tab);
    // Safety net: calls still marked running (e.g. after an abort without an
    // end event) are shown as interrupted instead of spinning forever.
    for (const [key, line] of this.toolLines) {
      if (key.startsWith(`${agent}/`)) {
        line.finish(true);
        this.toolLines.delete(key);
      }
    }
    this.markUnread(tab, agent);
    this.refreshStreamArea();
  }

  /** A tool call started: commits the pending stream tail, shows a running line. */
  public toolStart(agent: string, toolCallId: string, toolName: string, args: unknown): void {
    const tab = this.tabFor(agent);
    // Tools run between text segments: commit the live tail first so the
    // transcript order matches what the model actually did.
    this.flushStream(tab);
    this.toolLines.set(`${agent}/${toolCallId}`, new ToolCallLine(toolName, summarizeToolArgs(args)));
    tab.log.addChild(this.toolLines.get(`${agent}/${toolCallId}`)!);
    this.markUnread(tab, agent);
    this.ui.requestRender();
  }

  /** A tool call finished: flip its line to ✔/✘ in place. */
  public toolEnd(agent: string, toolCallId: string, isError: boolean): void {
    this.toolLines.get(`${agent}/${toolCallId}`)?.finish(isError);
    this.toolLines.delete(`${agent}/${toolCallId}`);
    const tab = this.tabs.get(agent);
    if (tab) {
      this.markUnread(tab, agent);
      this.ui.requestRender();
    }
  }

  public async pick<T>(title: string, options: readonly PickerOption<T>[]): Promise<T | undefined> {
    if (options.length === 0) return undefined;
    const entries = options.map((option) => ({
      option,
      searchable: [option.label, option.hint, option.keywords].filter(Boolean).join(" ")
    }));
    return await new Promise<T | undefined>((resolve) => {
      let settled = false;
      const component = new PickerComponent(title, entries, (value) => {
        if (settled) return;
        settled = true;
        handle.hide();
        this.ui.setFocus(this.editor);
        resolve(value);
      });
      const handle = this.ui.showOverlay(component, { anchor: "center" });
    });
  }

  /**
   * Asks the user one question mid-task: the question lands in the log, the
   * input line comes back for one answer line, then busy mode resumes.
   */
  public askQuestion(question: string): Promise<string> {
    return new Promise<string>((resolve) => {
      this.appendLine(question);
      this.setBusy(false);
      this.pendingAnswer = resolve;
    });
  }

  public appendMarkdown(markdown: string, agent: string = DEFAULT_AGENT): void {
    if (!markdown.trim()) return;
    const tab = this.tabFor(agent);
    this.flushStream(tab);
    this.addMarkdown(tab, markdown);
  }

  /** Commits the live tail (thinking run or partial text) into the log. */
  private flushStream(tab: AgentTranscript): void {
    if (tab.streamKind === "thinking") {
      if (tab.thinkingBuffer.trim()) tab.log.addChild(this.newReasoning(tab.thinkingBuffer));
      tab.thinkingBuffer = "";
    } else if (tab.streamKind === "text") {
      this.addMarkdown(tab, tab.partialBlock);
      tab.partialBlock = "";
    }
    tab.streamKind = undefined;
  }

  /** Adds one finalized markdown block to the transcript (no stream flush). */
  private addMarkdown(tab: AgentTranscript, markdown: string): void {
    if (!markdown.trim()) return;
    tab.log.addChild(new Markdown(markdown, 0, 0, this.markdownTheme));
    this.markUnread(tab, tab.name);
    this.ui.requestRender();
  }

  private activeTab(): AgentTranscript {
    return this.tabs.get(this.activeAgent)!;
  }

  /** Returns the agent's transcript, registering a tab on first use. */
  private tabFor(agent: string): AgentTranscript {
    let tab = this.tabs.get(agent);
    if (!tab) {
      this.registerAgent(agent);
      tab = this.tabs.get(agent)!;
    }
    return tab;
  }

  private markUnread(tab: AgentTranscript, agent: string): void {
    if (agent !== this.activeAgent) tab.unread = true;
  }

  private newReasoning(buffer: string): CollapsibleReasoning {
    const id = ++this.thinkSeq;
    const component = new CollapsibleReasoning(id, buffer.trim());
    this.collapsibles.set(id, component);
    return component;
  }

  private tabStates(): readonly AgentTabState[] {
    return [...this.tabs.values()].map((tab) => ({
      name: tab.name,
      active: tab.name === this.activeAgent,
      unread: tab.unread
    }));
  }

  private refreshStreamArea(): void {
    const tab = this.activeTab();
    tab.stream.clear();
    const shown = tab.thinkingBuffer
      ? dim(`▸ 思考（${[...tab.thinkingBuffer.trim()].length} 字）…`)
      : tab.partialBlock;
    if (shown.trim().length > 0) tab.stream.addChild(new Text(shown, 0, 0));
    this.ui.requestRender();
  }

  private setBusy(busy: boolean): void {
    this.inputArea.clear();
    this.inputArea.addChild(busy ? new Text(dim("⏳ 任务执行中（Ctrl+C 退出）…"), 0, 0) : this.editor);
    this.ui.requestRender();
    if (!busy) this.ui.setFocus(this.editor);
  }

  private async handleSubmit(text: string): Promise<void> {
    this.setBusy(true);
    try {
      await this.options.onSubmit(text);
    } finally {
      this.setBusy(false);
    }
  }
}
