import { Container, Markdown, stripTerminalSequences, type AutocompleteProvider, type MarkdownTheme, type OverlayHandle, ScrollView, Text, VStack, type ViewportTUI } from "@earendil-works/pi-tui";
import { getMarkdownTheme, getSelectListTheme } from "@earendil-works/pi-coding-agent";
import { dim } from "../core/ansi.ts";
import { fdInstallHint, readOsRelease } from "../core/install-hint.ts";
import { summarizeToolArgs } from "../core/tool-summary.ts";
import type { CommandOutcome } from "./commands.ts";
import { ChatAutocompleteProvider } from "./chat-autocomplete.ts";
import { FloatingEditor, type FloatingCompletionPlacement } from "./floating-editor.ts";
import { AgentTabState, BlankLine, CollapsibleReasoning, SESSION_SIDEBAR_WIDTH, StatusLine, ThinkingTail, ToastStack, ToolCallLine, UserMessage, type ToastLevel } from "./components.ts";

export interface ChatPanelOptions {
  ui: ViewportTUI;
  /** Returns "exit" to end the process (e.g. the /exit command); session 是提交时刻的会话命名空间。 */
  onSubmit: (line: string, session: string) => Promise<CommandOutcome | void>;
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
/** 草稿态的会话命名空间（未物化的新会话视图）；与会话 id 空间隔离（uuid 不会撞）。 */
export const DRAFT_SESSION = "draft";

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
  /** 归属的会话命名空间（并行会话各自一套转录缓冲，切回即补放）。 */
  session: string;
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
  /** 转录纯文本（逻辑行，未按屏宽折行）；transcriptText / 复制的数据源。 */
  plain: string[];
}

/** 转录缓冲的双键：会话命名空间 + agent 标签。 */
function tabKey(session: string, agent: string): string {
  return `${session}/${agent}`;
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
  /** 转录缓冲，按 `session/agent` 双键：会话是并行单位，agent 是会话内的标签。 */
  private readonly tabs = new Map<string, AgentTranscript>();
  private activeAgent = DEFAULT_AGENT;
  /** 当前展示的会话命名空间；后台会话的流持续写入自己的缓冲（切回即补放）。 */
  private activeSession = DRAFT_SESSION;
  /** 各会话的提交中任务（提交时刻的会话）；编辑器只被聚焦会话的 busy 锁住。 */
  private readonly busySessions = new Set<string>();
  /** 后台期间有过输出的会话（侧栏 • 标记；切回该会话即清除）。 */
  private readonly unreadSessions = new Set<string>();
  private thinkSeq = 0;
  /** Live tool calls by "agent/toolCallId"; removed when the call finishes. */
  private readonly toolLines = new Map<string, ToolCallLine>();
  /** 长命令状态行（/compact 等）：spinner 动画，完成后原地变 ✔/✘。 */
  private readonly statusLines = new Map<number, StatusLine>();
  private statusSeq = 0;
  private pendingAnswer?: (answer: string) => void;
  /** 运行中的工具行 → 纯文本下标；结束时把 ⏳ 行原地改写为 ✔/✘。 */
  private readonly pendingPlain = new Map<string, { tab: AgentTranscript; index: number; toolName: string }>();

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
        this.setSessionBusy(this.activeSession, true);
        this.appendUserMessage(text);
        settle(text);
        return;
      }
      if (this.busySessions.has(this.activeSession)) return;
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
  public registerAgent(name: string, session: string = this.activeSession): void {
    const key = tabKey(session, name);
    if (this.tabs.has(key)) return;
    const log = new Container();
    const stream = new Container();
    const container = new Container();
    container.addChild(log);
    container.addChild(stream);
    this.tabs.set(key, {
      name,
      session,
      container,
      log,
      stream,
      thinkingBuffer: "",
      partialBlock: "",
      streamBlankPending: false,
      unread: false,
      reasonings: [],
      plain: []
    });
    if (session === this.activeSession && this.sessionTabs(this.activeSession).length === 1) {
      this.mountTranscript(container);
    }
    this.options.ui.requestRender();
  }

  /** Switches the mounted transcript to the given agent and clears its unread flag. */
  public setActiveAgent(name: string): void {
    const tab = this.tabs.get(tabKey(this.activeSession, name));
    if (!tab || name === this.activeAgent) return;
    this.mountTranscript(tab.container);
    this.activeAgent = name;
    tab.unread = false;
    this.refreshStreamArea();
    this.options.ui.requestRender();
  }

  /**
   * 切换展示的会话命名空间：挂载目标会话的转录缓冲（O(1) 换引用，后台期间
   * 的增量已在缓冲里，切回即完整补放），并清掉该会话的未读标记。
   */
  public setActiveSession(session: string): void {
    if (session === this.activeSession) return;
    this.activeSession = session;
    const tab = this.tabFor(this.activeAgent, session);
    this.mountTranscript(tab.container);
    tab.unread = false;
    this.unreadSessions.delete(session);
    // 编辑器的提交锁跟随聚焦会话：后台会话再忙也不锁当前输入框。
    this.editor.disableSubmit = this.busySessions.has(session);
    this.refreshStreamArea();
    this.options.ui.requestRender();
  }

  /** 当前展示的会话命名空间。 */
  public get session(): string {
    return this.activeSession;
  }

  /** 某会话是否已有落盘在缓冲里的内容（未读过 JSONL 历史 → false，需要回放）。 */
  public isPopulated(session: string): boolean {
    return this.sessionTabs(session).some((tab) => tab.plain.length > 0);
  }

  /** 某会话是否存在未读输出（切回该会话时清除；agent 级未读仍由标签栏展示）。 */
  public sessionUnread(session: string): boolean {
    return this.unreadSessions.has(session);
  }

  /** 某会话的标签（按注册序，即 tabStates 的展示序）。 */
  private sessionTabs(session: string): AgentTranscript[] {
    return [...this.tabs.values()].filter((tab) => tab.session === session);
  }

  /** Cycles the active agent tab (Alt+↑/↓), wrapping around. */
  public cycleAgent(delta: number): void {
    const names = this.sessionTabs(this.activeSession).map((tab) => tab.name);
    if (names.length < 2) return;
    const index = names.indexOf(this.activeAgent);
    this.setActiveAgent(names[(index + delta + names.length) % names.length]);
  }

  /** Render-time tab states for the owner's tab bar. */
  public tabStates(): readonly AgentTabState[] {
    return this.sessionTabs(this.activeSession).map((tab) => ({
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
  public clearTranscript(agent: string = this.activeAgent, session: string = this.activeSession): void {
    const tab = this.tabs.get(tabKey(session, agent));
    if (!tab) return;
    this.flushStream(tab);
    tab.log.clear();
    tab.stream.clear();
    tab.reasonings.length = 0;
    tab.plain.length = 0;
    for (const [key, pending] of this.pendingPlain) if (pending.tab === tab) this.pendingPlain.delete(key);
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

  public appendLine(line: string, agent: string = DEFAULT_AGENT, session: string = this.activeSession): void {
    const tab = this.tabFor(agent, session);
    // A log line between stream chunks is later content: commit the live tail
    // first so the transcript order matches arrival order.
    this.flushStream(tab);
    tab.log.addChild(new Text(line, 0, 0));
    tab.plain.push(stripTerminalSequences(line));
    this.markUnread(tab);
    this.options.ui.requestRender();
  }

  public streamThinking(delta: string, agent: string = DEFAULT_AGENT, session: string = this.activeSession): void {
    const tab = this.tabFor(agent, session);
    // Text → thinking switch: the pending text tail is finished content, commit
    // it so the transcript keeps the model's real interleaved order.
    if (tab.streamKind === "text") this.flushStream(tab);
    tab.streamKind = "thinking";
    tab.thinkingBuffer += delta;
    this.markUnread(tab);
    this.refreshStreamArea();
  }

  public streamText(delta: string, agent: string = DEFAULT_AGENT, session: string = this.activeSession): void {
    const tab = this.tabFor(agent, session);
    // Thinking → text switch: fold the thinking run into the transcript, collapsed.
    if (tab.streamKind === "thinking") this.flushStream(tab);
    tab.streamKind = "text";
    const { blocks, rest } = splitMarkdownBlocks(tab.partialBlock + delta);
    for (const block of blocks) this.addStreamMarkdown(tab, block);
    tab.partialBlock = rest;
    this.markUnread(tab);
    this.refreshStreamArea();
  }

  public endStream(agent: string = DEFAULT_AGENT, session: string = this.activeSession): void {
    const tab = this.tabFor(agent, session);
    this.flushStream(tab);
    // Safety net: calls still marked running (e.g. after an abort without an
    // end event) are shown as interrupted instead of spinning forever.
    const keyPrefix = `${tabKey(session, agent)}/`;
    for (const key of [...this.toolLines.keys()]) {
      if (!key.startsWith(keyPrefix)) continue;
      this.toolLines.get(key)!.finish(true);
      this.toolLines.delete(key);
      const pending = this.pendingPlain.get(key);
      if (pending) {
        pending.tab.plain[pending.index] = `✘ ${pending.toolName}`;
        this.pendingPlain.delete(key);
      }
    }
    this.markUnread(tab);
    this.refreshStreamArea();
  }

  /** A tool call started: commits the pending stream tail, shows a running line. */
  public toolStart(agent: string, toolCallId: string, toolName: string, args: unknown, session: string = this.activeSession): void {
    const tab = this.tabFor(agent, session);
    // Tools run between text segments: commit the live tail first so the
    // transcript order matches what the model actually did.
    this.flushStream(tab);
    const summary = summarizeToolArgs(args);
    const key = `${tabKey(session, agent)}/${toolCallId}`;
    this.toolLines.set(key, new ToolCallLine(toolName, summary));
    tab.log.addChild(this.toolLines.get(key)!);
    const label = `${toolName}${summary ? ` ${summary}` : ""}`;
    this.pendingPlain.set(key, { tab, index: tab.plain.push(`⏳ ${label}`) - 1, toolName: label });
    this.markUnread(tab);
    this.options.ui.requestRender();
  }

  /** A tool call finished: flip its line to ✔/✘ in place. */
  public toolEnd(agent: string, toolCallId: string, isError: boolean, session: string = this.activeSession): void {
    const key = `${tabKey(session, agent)}/${toolCallId}`;
    this.toolLines.get(key)?.finish(isError);
    this.toolLines.delete(key);
    const pending = this.pendingPlain.get(key);
    if (pending) {
      pending.tab.plain[pending.index] = `${isError ? "✘" : "✔"} ${pending.toolName}`;
      this.pendingPlain.delete(key);
    }
    const tab = this.tabs.get(tabKey(session, agent));
    if (tab) {
      this.markUnread(tab);
      this.options.ui.requestRender();
    }
  }

  /** A finished tool-call row from history replay; renders like a settled live row. */
  public appendToolCall(toolName: string, summary: string, isError: boolean, agent: string = DEFAULT_AGENT, session: string = this.activeSession): void {
    const line = new ToolCallLine(toolName, summary);
    line.finish(isError);
    const tab = this.tabFor(agent, session);
    tab.log.addChild(line);
    tab.plain.push(`${isError ? "✘" : "✔"} ${toolName}${summary ? ` ${summary}` : ""}`);
    this.options.ui.requestRender();
  }

  /** One finished thinking entry (collapsible), as the live stream would leave it. */
  public appendThinking(text: string, agent: string = DEFAULT_AGENT, session: string = this.activeSession): void {
    const tab = this.tabFor(agent, session);
    this.flushStream(tab);
    if (text.trim()) tab.log.addChild(this.newReasoning(text.trim(), tab));
    this.options.ui.requestRender();
  }

  /** Echoes a submitted user message as a right-aligned bubble in the given session's tab. */
  public appendUserMessage(message: string, session: string = this.activeSession): void {
    if (!message.trim()) return;
    const tab = this.tabFor(DEFAULT_AGENT, session);
    this.flushStream(tab);
    tab.log.addChild(new UserMessage(message));
    tab.plain.push(message);
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

  public appendMarkdown(markdown: string, agent: string = DEFAULT_AGENT, session: string = this.activeSession): void {
    if (!markdown.trim()) return;
    const tab = this.tabFor(agent, session);
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
      this.setSessionBusy(this.activeSession, false);
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
    tab.plain.push(markdown);
    this.markUnread(tab);
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
    if (tab.streamBlankPending) {
      tab.log.addChild(new BlankLine());
      tab.plain.push("");
    }
    tab.streamBlankPending = true;
    this.addMarkdown(tab, markdown);
  }

  /**
   * 当前 agent 转录的纯文本：每条逻辑行一项（markdown 源码、完整思考、
   * 用户消息、工具行），不按屏宽折行、无样式与边框 —— 整个转录复制的数据源。
   * 流式尾部（未提交块）不含在内。
   */
  public transcriptText(): string {
    return this.activeTab().plain.join("\n");
  }

  /**
   * 当前聊天视口可见内容的纯文本（所见即所得）：按布局同款宽度渲染转录、
   * 按 scrollTop 截取视口行，再去掉 ANSI 样式。绕开了终端原生选择只能按
   * 字符网格框选的限制 —— 跨屏行/折行内容仍按逻辑行完整复制。
   */
  public visibleText(): string {
    const width = Math.max(20, this.options.ui.terminal.columns - SESSION_SIDEBAR_WIDTH - 1);
    const body = this.scrollBody.children[0];
    const lines = body ? body.render(this.scrollView.getContentWidth(width)) : [];
    const top = Math.max(0, Math.min(Math.floor(this.scrollView.scrollTop), lines.length));
    const height = Math.max(0, this.scrollView.viewportHeight);
    return lines
      .slice(top, top + height)
      .map(stripTerminalSequences)
      .join("\n")
      .replace(/[ \n]+$/, "");
  }

  private activeTab(): AgentTranscript {
    return this.tabs.get(tabKey(this.activeSession, this.activeAgent))!;
  }

  /** Returns the agent's transcript, registering a tab on first use. */
  private tabFor(agent: string, session: string = this.activeSession): AgentTranscript {
    const key = tabKey(session, agent);
    let tab = this.tabs.get(key);
    if (!tab) {
      this.registerAgent(agent, session);
      tab = this.tabs.get(key)!;
    }
    return tab;
  }

  /** 非当前展示标签（其他 agent 或后台会话）的输出都算未读。 */
  private markUnread(tab: AgentTranscript): void {
    if (tab.session !== this.activeSession) {
      this.unreadSessions.add(tab.session);
      tab.unread = true;
    } else if (tab.name !== this.activeAgent) {
      tab.unread = true;
    }
  }

  private newReasoning(buffer: string, tab: AgentTranscript): CollapsibleReasoning {
    const reasoning = new CollapsibleReasoning(++this.thinkSeq, buffer);
    tab.reasonings.push(reasoning);
    tab.plain.push(buffer.trim());
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

  /**
   * 会话级提交锁：只有聚焦会话的任务锁住编辑器；后台会话的 busy 不影响
   * 当前输入。任务结束时若该会话正是聚焦会话，才触发 onIdle 焦点策略。
   */
  private setSessionBusy(session: string, busy: boolean): void {
    if (busy) this.busySessions.add(session);
    else this.busySessions.delete(session);
    this.editor.disableSubmit = this.busySessions.has(this.activeSession);
    this.options.ui.requestRender();
    if (!busy && session === this.activeSession) this.options.onIdle();
  }

  private async handleSubmit(text: string): Promise<void> {
    // 斜杠命令是 UI 操作且可能含密钥（/apikey），不作为聊天气泡回显。
    // 提交时刻锁住的是提交时的会话：期间用户切走，编辑器不背旧会话的锁。
    const session = this.activeSession;
    if (!text.startsWith("/")) this.appendUserMessage(text);
    this.setSessionBusy(session, true);
    try {
      const outcome = await this.options.onSubmit(text, session);
      if (outcome === "exit") this.options.onExit();
    } finally {
      this.setSessionBusy(session, false);
    }
  }
}
