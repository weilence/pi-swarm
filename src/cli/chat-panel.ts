import { Container, Markdown, type AutocompleteProvider, type MarkdownTheme, type OverlayHandle, ScrollView, Text, VStack, type ViewportTUI } from "@earendil-works/pi-tui";
import { getMarkdownTheme, getSelectListTheme } from "@earendil-works/pi-coding-agent";
import { dim } from "../core/ansi.ts";
import { fdInstallHint, readOsRelease } from "../core/install-hint.ts";
import { summarizeToolArgs } from "../core/tool-summary.ts";
import type { CommandOutcome } from "./commands.ts";
import { ChatAutocompleteProvider } from "./chat-autocomplete.ts";
import { FloatingEditor, type FloatingCompletionPlacement } from "./floating-editor.ts";
import { AgentTabState, BlankLine, CollapsibleReasoning, StatusLine, ThinkingTail, ToastStack, ToolCallLine, UserMessage, type ToastLevel } from "./components.ts";

export interface ChatPanelOptions {
  ui: ViewportTUI;
  /** Returns "exit" to end the process (e.g. the /exit command). */
  onSubmit: (line: string) => Promise<CommandOutcome | void>;
  onExit: () => void;
  /** True while the editor owns the keyboard; drives the dimmed-border cue. */
  isInputFocused: () => boolean;
  /** A submitted task finished (or input is wanted again); the owner applies its focus policy. */
  onIdle: () => void;
  /** VSCode 式浮层补全的定位；缺省时补全下拉内嵌在编辑器框内。 */
  editorPlacement?: FloatingCompletionPlacement;
  /** 注入文件补全引擎（测试 mock / 未来扩展）；缺省按 fd 探测 PATH。 */
  autocompleteEngine?: AutocompleteProvider | null;
}

/** Agent that owns output when no explicit label is passed. */
const DEFAULT_AGENT = "supervisor";

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

/** Per-agent transcript state: the panel mounts only the active one. */
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
  /** 同一条流式文本内，上个已提交块后面需补一个空行（与回放渲染一致）。 */
  streamBlankPending: boolean;
  unread: boolean;
  /** Collapsible reasoning entries in arrival order (transcript-mode f key). */
  reasonings: CollapsibleReasoning[];
}

/**
 * The chat half of the REPL: a scrollable transcript area (one append-only
 * transcript per agent — log lines + streamed markdown blocks + collapsible
 * thinking entries + live tool rows) above a pinned multiline editor with
 * history, submit gating (busy mode), and mid-task questions.
 *
 * The panel is layout-ready (a VStack of [transcript scroll, editor] that
 * grows to fill its slot) but owns no focus policy and no chrome beyond its
 * own borders: the surrounding REPL decides when the editor has focus
 * (isInputFocused drives the dimmed-border cue) and what happens when a task
 * finishes (onIdle).
 */
export class ChatPanel extends VStack {
  public readonly editor: FloatingEditor;
  /** Holds the active transcript; lives inside the scroll view. */
  private readonly scrollBody = new Container();
  /** Scrollable chat area that fills the space above the pinned editor. */
  private readonly scrollView: ScrollView;
  private readonly inputArea = new Container();
  /** Transient hints, mounted as a screen-level overlay above the editor. */
  private toasts!: ToastStack;
  private toastOverlay?: OverlayHandle;
  private toastLayout?: { editorRows: number; pillWidth: number };
  private readonly markdownTheme: MarkdownTheme;
  private readonly tabs = new Map<string, AgentTranscript>();
  private activeAgent = DEFAULT_AGENT;
  private thinkSeq = 0;
  /** Live tool calls by "agent/toolCallId"; removed when the call finishes. */
  private readonly toolLines = new Map<string, ToolCallLine>();
  /** 长命令状态行（/compact 等）：spinner 动画，完成后原地变 ✔/✘。 */
  private readonly statusLines = new Map<number, StatusLine>();
  private statusSeq = 0;
  private pendingAnswer?: (answer: string) => void;
  /** True while a submitted task is running; Enter is swallowed, text is kept. */
  private busy = false;

  public constructor(private readonly options: ChatPanelOptions) {
    super();
    this.markdownTheme = getMarkdownTheme();
    // The dimmed border is the visual cue that keystrokes go elsewhere.
    // 浮层补全：编辑器框高度恒定，下拉列表浮动在框上方（VSCode 式）。
    // 未提供 placement（如单测）时退化为 pi-tui 原生内嵌渲染。
    this.editor = new FloatingEditor(options.ui, {
      borderColor: (text) => (options.isInputFocused() ? text : dim(text)),
      selectList: getSelectListTheme(),
      placement: options.editorPlacement
    });
    // 补全：空编辑器键入 / 弹出命令下拉，空白后键入 @ 弹出文件引用
    // （触发与键位由 pi-tui Editor 内建，这里只提供候选来源）。@ 补全
    // 以 fd 为唯一引擎，缺失时提示一次，不做降级兜底。
    this.editor.setAutocompleteProvider(
      new ChatAutocompleteProvider({
        fdEngine: options.autocompleteEngine,
        onFdMissing: () =>
          this.notify(
            `未找到 fd 命令，@ 文件补全不可用；安装：${fdInstallHint(process.platform, readOsRelease())}（重启生效）`,
            "warning"
          )
      })
    );
    this.editor.onSubmit = (text) => {
      if (this.pendingAnswer) {
        const settle = this.pendingAnswer;
        this.pendingAnswer = undefined;
        this.setBusy(true);
        this.appendUserMessage(text);
        settle(text);
        return;
      }
      if (this.busy) return;
      void this.handleSubmit(text);
    };
    this.inputArea.addChild(this.editor);

    // The transcript scroll follows new output and fills the space above the
    // editor, which stays pinned at the bottom with a transient scrollbar.
    // Toasts are NOT a layout child: they mount as a screen-level overlay
    // (syncToastOverlay) so hints cover chat content instead of pushing it up.
    this.scrollView = new ScrollView(this.scrollBody, { follow: "end", primary: true, scrollbar: "auto" });
    this.toasts = new ToastStack(
      () => this.options.ui.requestRender(),
      () => this.syncToastOverlay()
    );
    this.addChild(this.scrollView, { grow: 1 });
    this.addChild(this.inputArea, { shrink: 0 });

    this.registerAgent(DEFAULT_AGENT);
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
      streamBlankPending: false,
      unread: false,
      reasonings: []
    });
    if (this.tabs.size === 1) {
      this.activeAgent = name;
      this.mountTranscript(container);
    }
    this.options.ui.requestRender();
  }

  /** Switches the mounted transcript to the given agent and clears its unread flag. */
  public setActiveAgent(name: string): void {
    const tab = this.tabs.get(name);
    if (!tab || name === this.activeAgent) return;
    this.mountTranscript(tab.container);
    this.activeAgent = name;
    tab.unread = false;
    this.refreshStreamArea();
    this.options.ui.requestRender();
  }

  /** Cycles the active agent tab (Alt+↑/↓), wrapping around. */
  public cycleAgent(delta: number): void {
    const names = [...this.tabs.keys()];
    if (names.length < 2) return;
    const index = names.indexOf(this.activeAgent);
    this.setActiveAgent(names[(index + delta + names.length) % names.length]);
  }

  /** Render-time tab states for the owner's tab bar. */
  public tabStates(): readonly AgentTabState[] {
    return [...this.tabs.values()].map((tab) => ({
      name: tab.name,
      active: tab.name === this.activeAgent,
      unread: tab.unread
    }));
  }

  /**
   * Empties one agent's transcript (log + live tail): used when entering the
   * draft view so 「新建」 starts from a clean slate instead of appending to
   * the previous session's output.
   */
  public clearTranscript(agent: string = this.activeAgent): void {
    const tab = this.tabs.get(agent);
    if (!tab) return;
    this.flushStream(tab);
    tab.log.clear();
    tab.stream.clear();
    tab.reasonings.length = 0;
    this.options.ui.requestRender();
  }

  /**
   * Transcript browse mode: expands every reasoning entry when any is folded,
   * collapses all otherwise.
   */
  public toggleAllFolds(): void {
    const tab = this.activeTab();
    const expand = tab.reasonings.some((reasoning) => !reasoning.isExpanded());
    for (const reasoning of tab.reasonings) reasoning.setExpanded(expand);
    this.options.ui.requestRender();
  }

  /** Transcript browse mode: scrolls the chat line by line. */
  public scrollTranscript(lines: number): void {
    this.scrollView.scrollBy(lines);
  }

  public appendLine(line: string, agent: string = DEFAULT_AGENT): void {
    const tab = this.tabFor(agent);
    // A log line between stream chunks is later content: commit the live tail
    // first so the transcript order matches arrival order.
    this.flushStream(tab);
    tab.log.addChild(new Text(line, 0, 0));
    this.markUnread(tab, agent);
    this.options.ui.requestRender();
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
    for (const block of blocks) this.addStreamMarkdown(tab, block);
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
    this.options.ui.requestRender();
  }

  /** A tool call finished: flip its line to ✔/✘ in place. */
  public toolEnd(agent: string, toolCallId: string, isError: boolean): void {
    this.toolLines.get(`${agent}/${toolCallId}`)?.finish(isError);
    this.toolLines.delete(`${agent}/${toolCallId}`);
    const tab = this.tabs.get(agent);
    if (tab) {
      this.markUnread(tab, agent);
      this.options.ui.requestRender();
    }
  }

  /** A finished tool-call row from history replay; renders like a settled live row. */
  public appendToolCall(toolName: string, summary: string, isError: boolean, agent: string = DEFAULT_AGENT): void {
    const line = new ToolCallLine(toolName, summary);
    line.finish(isError);
    this.tabFor(agent).log.addChild(line);
    this.options.ui.requestRender();
  }

  /** One finished thinking entry (collapsible), as the live stream would leave it. */
  public appendThinking(text: string, agent: string = DEFAULT_AGENT): void {
    const tab = this.tabFor(agent);
    this.flushStream(tab);
    if (text.trim()) tab.log.addChild(this.newReasoning(text.trim(), tab));
    this.options.ui.requestRender();
  }

  /** Echoes a submitted user message as a right-aligned bubble in the active tab. */
  public appendUserMessage(message: string): void {
    if (!message.trim()) return;
    const tab = this.activeTab();
    this.flushStream(tab);
    tab.log.addChild(new UserMessage(message));
    this.options.ui.requestRender();
  }

  /**
   * Shows/hides/repositions the toast overlay. Toasts live at the screen
   * level: a non-capturing overlay the TUI composites over the rendered
   * frame every pass, pinned bottom-right and lifted above the editor block
   * (offsetY = -editorRows), sized exactly to the pill block so chat text
   * left of the pills stays visible. Handles cannot be repositioned, so the
   * overlay is replaced only when the layout (editor height / pill width)
   * changes; it is hidden while the stack is empty. Note the layout engine
   * never calls ChatPanel.render (VStack is a layout node) — which is why
   * toasts mount here at the overlay level instead of in render().
   */
  public syncToastOverlay(): void {
    const ui = this.options.ui;
    if (this.toasts.isEmpty()) {
      if (this.toastOverlay && !this.toastOverlay.isHidden()) {
        this.toastOverlay.setHidden(true);
        ui.requestRender();
      }
      return;
    }
    const columns = ui.terminal.columns;
    const layout = { editorRows: this.editor.render(columns).length, pillWidth: this.toasts.measureWidth(columns) };
    const stale =
      !this.toastOverlay ||
      !this.toastLayout ||
      this.toastLayout.editorRows !== layout.editorRows ||
      this.toastLayout.pillWidth !== layout.pillWidth;
    if (stale) {
      this.toastOverlay?.hide();
      this.toastOverlay = ui.showOverlay(this.toasts, {
        anchor: "bottom-right",
        offsetY: -layout.editorRows,
        width: layout.pillWidth,
        nonCapturing: true
      });
      this.toastLayout = layout;
    } else if (this.toastOverlay?.isHidden()) {
      this.toastOverlay.setHidden(false);
    }
    ui.requestRender();
  }

  /**
   * 转录中插入一条运行中的状态行（spinner 动画）；返回 id 供 endStatus 收尾。
   * 与工具行同源：插入前先提交流式尾部，保持到达顺序。
   */
  public beginStatus(label: string): number {
    const id = ++this.statusSeq;
    const line = new StatusLine(label, () => this.options.ui.requestRender());
    this.statusLines.set(id, line);
    const tab = this.activeTab();
    this.flushStream(tab);
    tab.log.addChild(line);
    this.options.ui.requestRender();
    return id;
  }

  /** 收尾状态行：原地变 ✔/✘，保留在转录中作为记录。 */
  public endStatus(id: number, isError: boolean): void {
    const line = this.statusLines.get(id);
    if (!line) return;
    this.statusLines.delete(id);
    line.finish(isError);
    this.options.ui.requestRender();
  }

  /** 停止所有状态行动画（REPL 关闭时的兕底；正常路径由 endStatus 收尾）。 */
  public stopStatuses(): void {
    for (const line of this.statusLines.values()) line.stop();
    this.statusLines.clear();
  }

  /**
   * Shows a transient hint above the editor (auto-dismissing toast); hints
   * never enter the transcript. Overlay mounting is handled by the stack's
   * onChange callback → syncToastOverlay.
   */
  public notify(message: string, level: ToastLevel = "info", ttlMs?: number): void {
    this.toasts.notify(message, level, ttlMs);
  }

  /** Drops all toasts; used when the REPL stops. */
  public clearToasts(): void {
    this.toasts.clear();
  }

  public appendMarkdown(markdown: string, agent: string = DEFAULT_AGENT): void {
    if (!markdown.trim()) return;
    const tab = this.tabFor(agent);
    this.flushStream(tab);
    this.addMarkdown(tab, markdown);
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

  /** Shows the given transcript in the chat viewport and follows its latest output. */
  private mountTranscript(container: Container): void {
    this.scrollBody.clear();
    this.scrollBody.addChild(container);
    this.scrollView.scrollToEnd();
  }

  /** Commits the live tail (thinking run or partial text) into the log. */
  private flushStream(tab: AgentTranscript): void {
    if (tab.streamKind === "thinking") {
      if (tab.thinkingBuffer.trim()) tab.log.addChild(this.newReasoning(tab.thinkingBuffer, tab));
      tab.thinkingBuffer = "";
    } else if (tab.streamKind === "text") {
      this.addStreamMarkdown(tab, tab.partialBlock);
      tab.partialBlock = "";
    }
    tab.streamKind = undefined;
    tab.streamBlankPending = false;
    // The committed tail must leave the stream area at the same time, or the
    // raw copy lingers below the newly added line (tool row/log entry) and the
    // content shows twice until the next stream event rebuilds the area.
    tab.stream.clear();
  }

  /** Adds one finalized markdown block to the transcript (no stream flush). */
  private addMarkdown(tab: AgentTranscript, markdown: string): void {
    if (!markdown.trim()) return;
    tab.log.addChild(new Markdown(markdown, 0, 0, this.markdownTheme));
    this.markUnread(tab, tab.name);
    this.options.ui.requestRender();
  }

  /**
   * Commits one streamed text block: blank-line-separated blocks of the SAME
   * stream keep a spacer line between them (pi-tui's Container joins children
   * without separation), matching how a reload renders the whole message as
   * one Markdown with internal paragraph spacing.
   */
  private addStreamMarkdown(tab: AgentTranscript, markdown: string): void {
    if (!markdown.trim()) return;
    // 注意：分隔符必须是含一个空格的 Text —— pi-tui 的 Text 对纯空文本渲染
    // 零行，Text("") 作为空行是无效的（曾导致流式空行全部丢失）。
    if (tab.streamBlankPending) tab.log.addChild(new BlankLine());
    tab.streamBlankPending = true;
    this.addMarkdown(tab, markdown);
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

  private newReasoning(buffer: string, tab: AgentTranscript): CollapsibleReasoning {
    const reasoning = new CollapsibleReasoning(++this.thinkSeq, buffer);
    tab.reasonings.push(reasoning);
    return reasoning;
  }

  private refreshStreamArea(): void {
    const tab = this.activeTab();
    tab.stream.clear();
    if (tab.thinkingBuffer.trim()) {
      tab.stream.addChild(new ThinkingTail(tab.thinkingBuffer));
    } else if (tab.partialBlock.trim().length > 0) {
      // 已提交块与流式尾部之间的接缝补空行（否则正在输出的段落与上一段
      // 粘在一起，直到提交才被 addStreamMarkdown 纠正，与回放渲染不一致）。
      // 同 addStreamMarkdown：空行必须用 Text(" ")，纯空文本渲染零行。
      if (tab.streamBlankPending) tab.stream.addChild(new BlankLine());
      tab.stream.addChild(new Text(tab.partialBlock, 0, 0));
    }
    this.options.ui.requestRender();
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    // The editor stays mounted and focused; Enter is ignored while busy so the
    // queued text survives until the running task finishes.
    this.editor.disableSubmit = busy;
    this.options.ui.requestRender();
    if (!busy) this.options.onIdle();
  }

  private async handleSubmit(text: string): Promise<void> {
    // 斜杠命令是 UI 操作且可能含密钥（/apikey），不作为聊天气泡回显。
    if (!text.startsWith("/")) this.appendUserMessage(text);
    this.setBusy(true);
    try {
      const outcome = await this.options.onSubmit(text);
      if (outcome === "exit") this.options.onExit();
    } finally {
      this.setBusy(false);
    }
  }
}
