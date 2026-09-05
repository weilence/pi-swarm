import {
  Container,
  Editor,
  HStack,
  type MarkdownTheme,
  Markdown,
  matchesKey,
  type OverlayHandle,
  ProcessTerminal,
  ScrollView,
  Text,
  TuiAltScreen,
  type ViewportTUI,
  visibleWidth,
  VStack
} from "@earendil-works/pi-tui";
import { getMarkdownTheme, getSelectListTheme, initTheme } from "@earendil-works/pi-coding-agent";
import type { SessionSummary } from "../core/session/session-types.ts";
import { summarizeToolArgs } from "../core/tool-summary.ts";
import type { CommandOutcome, PickerOption } from "./commands.ts";
import {
  AgentTabBar,
  AgentTabState,
  CollapsibleReasoning,
  PickerComponent,
  SESSION_SIDEBAR_WIDTH,
  SessionContextMenu,
  SessionEntryState,
  SessionSidebar,
  SidebarBorderLine,
  ThinkingTail,
  ToolCallLine,
  UserMessage
} from "./components.ts";
import { LinkDispatcher } from "./link-dispatcher.ts";
import { interceptRightClick } from "./right-click.ts";

export { summarizeToolArgs };

export interface TuiReplOptions {
  /** Injected viewport TUI for tests; defaults to a ProcessTerminal + TuiAltScreen (fullscreen) pair. */
  ui?: ViewportTUI;
  /** Returns "exit" to end the process (e.g. the /exit command). */
  onSubmit: (line: string) => Promise<CommandOutcome | void>;
  onExit: () => void;
  /** A sessions-bar entry was clicked; "draft" means the ＋ 新建/草稿 entry. */
  onSessionClick?: (sessionId: string) => void | Promise<void>;
  /** A session was picked for deletion from the sidebar's right-click menu. */
  onDeleteSession?: (sessionId: string) => void | Promise<void>;
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

/**
 * Interactive REPL built on pi-tui: one append-only transcript per agent (log
 * lines + streamed markdown blocks + collapsible thinking entries), a streaming
 * tail for in-progress output, a right-aligned agent tab bar overlay, a
 * multiline editor with history, and overlay pickers.
 *
 * Interaction routing: pi-tui hands every OSC 8 hyperlink click to one global
 * callback (handleLink here) and swallows mouse events, so the components own
 * their link schemes — each registers its prefix (plus its actions and hit
 * geometry) with `links` at construction — while this class stays the
 * composition root: layout, transcripts, overlays, and the transient
 * context-menu plumbing.
 */
export class TuiRepl {
  private readonly owned?: { terminal: ProcessTerminal; ui: TuiAltScreen };
  private readonly ui: ViewportTUI;
  /** Prefix registry: activated links fan out to the component that rendered them. */
  private readonly links = new LinkDispatcher();
  private readonly inputArea = new Container();
  /** Holds the active transcript; lives inside the scroll view. */
  private readonly scrollBody = new Container();
  /** Scrollable chat area that fills the space above the pinned editor. */
  private readonly scrollView: ScrollView;
  private readonly editor: Editor;
  private readonly markdownTheme: MarkdownTheme;
  private readonly tabs = new Map<string, AgentTranscript>();
  private activeAgent = DEFAULT_AGENT;
  private thinkSeq = 0;
  /** Live tool calls by "agent/toolCallId"; removed when the call finishes. */
  private readonly toolLines = new Map<string, ToolCallLine>();
  private readonly tabBar: AgentTabBar;
  private readonly tabBarOverlay?: OverlayHandle;
  /** Sessions sidebar rows; mounted inside sidebarScroll. */
  private readonly sidebar: SessionSidebar;
  /** Viewport that scrolls the sidebar rows; fills the terminal height. */
  private readonly sidebarScroll: ScrollView;
  /** Sessions snapshot pushed by main.ts; rendered by the sidebar. */
  private sessionList: readonly SessionEntryState[] = [];
  /** True while the unsaved draft (新建未发送) is the active view. */
  private draftMode = false;
  /** Currently open right-click menu: item links + dismissal live on the component. */
  private openMenu?: { menu: SessionContextMenu; close(): void };
  private menuHandle?: OverlayHandle;
  private pendingAnswer?: (answer: string) => void;
  /** True while a submitted task is running; Enter is swallowed, text is kept. */
  private busy = false;

  public constructor(private readonly options: TuiReplOptions) {
    initTheme();
    this.markdownTheme = getMarkdownTheme();
    if (options.ui) {
      this.ui = options.ui;
    } else {
      const terminal = new ProcessTerminal();
      // Fullscreen (alternate-screen) mode: app owns the whole viewport with a
      // scrollable document that follows new output; screen is restored on stop.
      // OSC 8 link clicks route through handleLink into the dispatcher; the
      // terminal is wrapped so right-clicks reach the sidebar context menu
      // before pi-tui consumes the mouse sequence (it never re-emits them).
      const ui = new TuiAltScreen(
        interceptRightClick(terminal, (x, y) => this.handleSidebarRightClick(x, y)),
        true,
        undefined,
        { openUrl: (url) => this.handleLink(url) }
      );
      this.owned = { terminal, ui };
      this.ui = ui;
    }
    this.editor = new Editor(this.ui, { borderColor: (text) => text, selectList: getSelectListTheme() });
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

    // Layout: a full-height sessions sidebar sits on the left edge of the
    // whole app — borders stay fixed while a ScrollView scrolls the rows.
    // The sidebar's scrollbar is transient ("auto"): an always-on thumb here
    // would paint a permanent gray column right next to the chat gap (and a
    // full-height one whenever sessions fit the viewport). It still appears
    // whenever an overflowing list is actually scrolled. A one-column gap
    // separates sidebar from the chat column, which fills the rest with its
    // own auto-visible scrollbar above the pinned editor.
    this.scrollView = new ScrollView(this.scrollBody, { follow: "end", primary: true, scrollbar: "auto" });
    this.sidebar = new SessionSidebar(
      () => ({ entries: this.sessionList, draft: this.draftMode }),
      this.links,
      (id) => void this.options.onSessionClick?.(id),
      (id) => void this.options.onDeleteSession?.(id)
    );
    this.sidebarScroll = new ScrollView(this.sidebar, { scrollbar: "auto", overscroll: "contain" });

    const sidebarColumn = new VStack();
    sidebarColumn.addChild(new SidebarBorderLine(true), { shrink: 0 });
    sidebarColumn.addChild(this.sidebarScroll, { grow: 1 });
    sidebarColumn.addChild(new SidebarBorderLine(false), { shrink: 0 });

    const chatColumn = new VStack();
    chatColumn.addChild(this.scrollView, { grow: 1 });
    chatColumn.addChild(this.inputArea, { shrink: 0 });

    this.registerAgent(DEFAULT_AGENT);
    this.tabBar = new AgentTabBar(() => this.tabStates(), this.links, (name) => this.setActiveAgent(name));
    this.tabBarOverlay = this.ui.showOverlay(this.tabBar, { anchor: "top-right", nonCapturing: true });
    this.ui.addInputListener((data) => {
      if (matchesKey(data, "ctrl+c")) {
        this.options.onExit();
        return { consume: true };
      }
      return undefined;
    });


    const root = new HStack([], { gap: 1 });
    root.addChild(sidebarColumn, { basis: SESSION_SIDEBAR_WIDTH, grow: 0, shrink: 0 });
    root.addChild(chatColumn, { grow: 1 });

    this.ui.setLayoutRoot(root);
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
      this.mountTranscript(container);
    }
    this.ui.requestRender();
  }

  /** Replaces the sidebar snapshot (already updatedAt-desc from the manager). */
  public setSessions(list: readonly SessionSummary[]): void {
    this.sessionList = list.map((session) => ({
      id: session.id,
      name: session.name,
      current: session.current,
      closed: session.status === "closed"
    }));
    this.ui.requestRender();
  }

  /** Switches the mounted transcript to the given agent and clears its unread flag. */
  public setActiveAgent(name: string): void {
    const tab = this.tabs.get(name);
    if (!tab || name === this.activeAgent) return;
    this.mountTranscript(tab.container);
    this.activeAgent = name;
    tab.unread = false;
    this.refreshStreamArea();
    this.ui.requestRender();
  }

  /** Shows the given transcript in the chat viewport and follows its latest output. */
  private mountTranscript(container: Container): void {
    this.scrollBody.clear();
    this.scrollBody.addChild(container);
    this.scrollView.scrollToEnd();
  }

  /** Toggles the draft entry (✎ 草稿) at the top of the sessions sidebar. */
  public setDraftMode(active: boolean): void {
    if (this.draftMode === active) return;
    this.draftMode = active;
    this.ui.requestRender();
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
    this.ui.requestRender();
  }

  /**
   * Entry point for activated OSC 8 links (pi-tui's single openUrl callback):
   * an open context menu consumes its own item links, any other link dismisses
   * it first, and everything else fans out through the dispatcher to the
   * component that rendered the link.
   */
  public handleLink(url: string): void {
    if (this.openMenu) {
      if (this.openMenu.menu.handleLink(url)) return;
      this.openMenu.close();
    }
    this.links.dispatch(url);
  }

  /** Opens the context menu for the sidebar session under (x, y), if any. */
  private handleSidebarRightClick(x: number, y: number): void {
    if (this.openMenu) this.openMenu.close();
    const entry = this.sidebar.entryAt(x, y, this.sidebarScroll.scrollTop);
    if (!entry) return;
    const actions = this.sidebar.menuActions(entry);
    const close = (): void => {
      this.menuHandle?.hide();
      this.menuHandle = undefined;
      this.openMenu = undefined;
      this.ui.setFocus(this.editor);
    };
    const menu = new SessionContextMenu(entry.name, actions, close, () => this.ui.requestRender());
    this.openMenu = { menu, close };
    // pi-tui renders overlays at min(80, terminal width) unless told otherwise;
    // size the menu to its widest line so the highlight hugs the content.
    const width = Math.min(
      30,
      Math.max(14, visibleWidth(entry.name) + 4, ...actions.map((action) => visibleWidth(action.label) + 4))
    );
    this.menuHandle = this.ui.showOverlay(
      menu,
      // pi-tui clamps absolute positions to stay on screen.
      { col: x + 1, row: y + 1, width }
    );
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

  /** A finished tool-call row from history replay; renders like a settled live row. */
  public appendToolCall(toolName: string, summary: string, isError: boolean, agent: string = DEFAULT_AGENT): void {
    const line = new ToolCallLine(toolName, summary);
    line.finish(isError);
    this.tabFor(agent).log.addChild(line);
    this.ui.requestRender();
  }

  /** One finished thinking entry (collapsible), as the live stream would leave it. */
  public appendThinking(text: string, agent: string = DEFAULT_AGENT): void {
    const tab = this.tabFor(agent);
    this.flushStream(tab);
    if (text.trim()) tab.log.addChild(this.newReasoning(text.trim()));
    this.ui.requestRender();
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

  /** Echoes a submitted user message as a right-aligned bubble in the active tab. */
  public appendUserMessage(message: string): void {
    if (!message.trim()) return;
    const tab = this.activeTab();
    this.flushStream(tab);
    tab.log.addChild(new UserMessage(message));
    this.ui.requestRender();
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
    // Per-REPL ids: the think/{id} link registration is owned by the component.
    return new CollapsibleReasoning(++this.thinkSeq, buffer, this.links, () => this.ui.requestRender());
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
    if (tab.thinkingBuffer.trim()) {
      tab.stream.addChild(new ThinkingTail(tab.thinkingBuffer));
    } else if (tab.partialBlock.trim().length > 0) {
      tab.stream.addChild(new Text(tab.partialBlock, 0, 0));
    }
    this.ui.requestRender();
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    // The editor stays mounted and focused; Enter is ignored while busy so the
    // queued text survives until the running task finishes.
    this.editor.disableSubmit = busy;
    this.ui.requestRender();
    if (!busy) this.ui.setFocus(this.editor);
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
