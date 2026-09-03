import {
  Container,
  Editor,
  fuzzyFilter,
  Input,
  type MarkdownTheme,
  Markdown,
  matchesKey,
  ProcessTerminal,
  SelectList,
  type SelectItem,
  Text,
  TuiAltScreen,
  type TUI
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
 * Interactive REPL built on pi-tui: append-only log (plain lines + streamed
 * markdown blocks), a streaming tail for in-progress output, a multiline
 * editor with history, and overlay pickers — replacing the former Ink stack.
 */
export class TuiRepl {
  private readonly owned?: { terminal: ProcessTerminal; ui: TuiAltScreen };
  private readonly ui: TUI;
  private readonly logContainer = new Container();
  private readonly streamArea = new Container();
  private readonly inputArea = new Container();
  private readonly editor: Editor;
  private readonly markdownTheme: MarkdownTheme;
  private thinkingBuffer = "";
  private partialBlock = "";
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
      const ui = new TuiAltScreen(terminal, true);
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
    this.ui.addChild(this.logContainer);
    this.ui.addChild(this.streamArea);
    this.ui.addChild(this.inputArea);
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

  public appendLine(line: string): void {
    this.logContainer.addChild(new Text(line, 0, 0));
    this.ui.requestRender();
  }

  public streamThinking(delta: string): void {
    this.thinkingBuffer += delta;
    this.refreshStreamArea();
  }

  public streamText(delta: string): void {
    if (this.thinkingBuffer) {
      // thinking that arrived before the answer belongs to the log, dimmed
      this.logContainer.addChild(new Text(dim(this.thinkingBuffer.trim()), 0, 0));
      this.thinkingBuffer = "";
    }
    const { blocks, rest } = splitMarkdownBlocks(this.partialBlock + delta);
    for (const block of blocks) this.appendMarkdown(block);
    this.partialBlock = rest;
    this.refreshStreamArea();
  }

  public endStream(): void {
    if (this.thinkingBuffer.trim()) {
      this.logContainer.addChild(new Text(dim(this.thinkingBuffer.trim()), 0, 0));
    }
    this.appendMarkdown(this.partialBlock);
    this.partialBlock = "";
    this.thinkingBuffer = "";
    this.refreshStreamArea();
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

  public appendMarkdown(markdown: string): void {
    if (!markdown.trim()) return;
    this.logContainer.addChild(new Markdown(markdown, 0, 0, this.markdownTheme));
    this.ui.requestRender();
  }

  private refreshStreamArea(): void {
    this.streamArea.clear();
    const shown = this.thinkingBuffer ? dim(this.thinkingBuffer) : this.partialBlock;
    if (shown.trim().length > 0) this.streamArea.addChild(new Text(shown, 0, 0));
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
