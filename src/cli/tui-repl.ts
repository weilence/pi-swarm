import { getKeybindings, type AutocompleteProvider, HStack, isKeyRelease, matchesKey, type OverlayHandle, ProcessTerminal, ScrollView, type ViewportTUI, visibleWidth, VStack } from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { SwarmAltScreen } from "./alt-screen.ts";
import type { SessionSummary } from "../core/session/session-types.ts";
import { macAltKeyHint } from "./alt-key-hint.ts";
import { summarizeToolArgs } from "../core/tool-summary.ts";
import type { CommandOutcome, PickerOption } from "./commands.ts";
import { ChatPanel } from "./chat-panel.ts";
import {
  AgentTabBar,
  PickerComponent,
  SESSION_SIDEBAR_WIDTH,
  SessionContextMenu,
  SessionEntryState,
  SessionSidebar,
  SidebarBorderLine,
  StatusBar,
  type ToastLevel
} from "./components.ts";
import type { AgentStatusSnapshot } from "../pi/agent.ts";
import { writeClipboard } from "./clipboard.ts";

export { summarizeToolArgs };

export interface TuiReplOptions {
  /** Injected viewport TUI for tests; defaults to a ProcessTerminal + SwarmAltScreen (fullscreen) pair. */
  ui?: ViewportTUI;
  /** Returns "exit" to end the process (e.g. the /exit command). */
  onSubmit: (line: string) => Promise<CommandOutcome | void>;
  onExit: () => void;
  /** A sidebar session was activated (Enter/n); "draft" means the ＋ 新建/草稿 entry. */
  onSessionClick?: (sessionId: string) => void | Promise<void>;
  /** A session delete was confirmed from the sidebar's keyboard menu. */
  onDeleteSession?: (sessionId: string) => void | Promise<void>;
  /** 模型输出中（busy）；双击 Esc 中止的第一下判断。 */
  isBusy?: () => boolean;
  /** 双击 Esc 确认后调用：中止当前输出。 */
  onAbort?: () => void | Promise<void>;
  /** 双击 Esc 的判定窗口（毫秒）；默认 2000。 */
  doubleEscWindowMs?: number;
  /** 注入文件补全引擎（测试 mock / 未来扩展）；缺省按 fd 探测 PATH。 */
  autocompleteEngine?: AutocompleteProvider | null;
}

/** The three focus regions; the editor is the home base. */
type FocusMode = "editor" | "sidebar" | "transcript";

/**
 * Interactive REPL: the composition root around a {@link ChatPanel}.
 *
 * This class owns the chrome and the policies — the sessions sidebar, the
 * agent tab bar overlay, pickers, the delete-confirmation menu, terminal
 * setup — and, above all, the keyboard focus model. Interaction is fully
 * keyboard-driven. Input routing relies on pi-tui's ordering — registered
 * input listeners run before the focused component — so one global listener
 * here owns the model:
 *   Alt+S / Alt+T focus the sessions sidebar / transcript browse mode (press
 *   again to return), Alt+↑/↓ cycle agent tabs, and while the sidebar or
 *   transcript is focused, Tab hops between the two panels, Esc returns to
 *   the editor, and any printable character falls through to the editor.
 *   PageUp / PageDown / Home / End / Ctrl+↑↓ scroll the transcript via
 *   pi-tui's own bindings.
 *
 * Transcripts, streaming, and the input editor live in the ChatPanel; output
 * methods here are thin facades so callers (main, commands, history replay)
 * keep one entry point.
 */
export class TuiRepl {
  private readonly owned?: { terminal: ProcessTerminal; ui: SwarmAltScreen };
  private readonly ui: ViewportTUI;
  /** Chat content + input box: transcripts, streaming, editor, submit gating. */
  private readonly chat: ChatPanel;
  /** Sessions sidebar rows; mounted inside sidebarScroll. */
  private readonly sidebar: SessionSidebar;
  /** Viewport that scrolls the sidebar rows; fills the terminal height. */
  private readonly sidebarScroll: ScrollView;
  /** Sessions snapshot pushed by main.ts; rendered by the sidebar. */
  private sessionList: readonly SessionEntryState[] = [];
  /** True while the unsaved draft (新建未发送) is the active view. */
  private draftMode = false;
  /** Which region owns the keyboard right now. */
  private focus: FocusMode = "editor";
  private readonly tabBar: AgentTabBar;
  private readonly tabBarOverlay?: OverlayHandle;
  /** One-line agent status (model / context / cache), below the editor. */
  private readonly statusBar = new StatusBar();
  /** Currently open delete-confirmation menu: keyboard-driven, self-contained. */
  private openMenu?: { menu: SessionContextMenu; close(): void };
  private menuHandle?: OverlayHandle;
  /** 第一次 Esc（busy 中）的时刻；窗口内再按一次则中止输出。 */
  private escapedArmedAt?: number;

  public constructor(private readonly options: TuiReplOptions) {
    initTheme();
    if (options.ui) {
      this.ui = options.ui;
    } else {
      const terminal = new ProcessTerminal();
      // Fullscreen (alternate-screen) mode: app owns the whole viewport with a
      // scrollable document that follows new output; screen is restored on stop.
      // SwarmAltScreen：鼠标拖选 + 右键复制选区（见 alt-screen.ts）。
      const ui = new SwarmAltScreen(terminal, true, undefined);
      this.owned = { terminal, ui };
      this.ui = ui;
    }
    // Home/End 让给编辑器光标移动：pi-tui 默认把它们绑在 alt-screen 视口跳顶/底
    // 上并在输入监听阶段抢先消费，编辑器永远收不到。改绑到 shift 组合键后，
    // 视口跳转仍可用（转录模式下 shift+home/end），Home/End 落到下方路由。
    getKeybindings().setUserBindings({
      "tui.altScreen.top": "shift+home",
      "tui.altScreen.bottom": "shift+end"
    });

    this.chat = new ChatPanel({
      ui: this.ui,
      onSubmit: options.onSubmit,
      onExit: options.onExit,
      isInputFocused: () => this.focus === "editor",
      autocompleteEngine: options.autocompleteEngine,
      // Don't steal focus from an open menu when a task finishes.
      onIdle: () => {
        if (!this.openMenu) this.setFocusMode("editor");
      },
      // 浮层补全定位：chat 列起点在侧栏（22 列）+ 1 列 gap 之后；编辑器
      // 之下还有一行状态栏，浮层（框上方）计算时需扣除。
      editorPlacement: {
        col: SESSION_SIDEBAR_WIDTH + 1,
        bottomRows: () => this.statusBar.render(this.ui.terminal.columns).length
      }
    });

    // Layout: a full-height sessions sidebar sits on the left edge of the
    // whole app — borders stay fixed while a ScrollView scrolls the rows.
    // The sidebar's scrollbar is transient ("auto"): an always-on thumb here
    // would paint a permanent gray column right next to the chat gap (and a
    // full-height one whenever sessions fit the viewport). It still appears
    // whenever an overflowing list is actually scrolled. A one-column gap
    // separates sidebar from the chat column, which fills the rest with its
    // own auto-visible scrollbar above the pinned editor.
    this.sidebar = new SessionSidebar(
      () => ({ entries: this.sessionList, draft: this.draftMode }),
      {
        onActivate: (id) => void this.options.onSessionClick?.(id),
        onDeleteRequest: (entry) => this.confirmDelete(entry),
        onLeave: () => this.setFocusMode("editor"),
        onSwitchPanel: () => this.setFocusMode("transcript")
      }
    );
    this.sidebarScroll = new ScrollView(this.sidebar, { scrollbar: "auto", overscroll: "contain" });

    const sidebarColumn = new VStack();
    sidebarColumn.addChild(new SidebarBorderLine(true), { shrink: 0 });
    sidebarColumn.addChild(this.sidebarScroll, { grow: 1 });
    sidebarColumn.addChild(new SidebarBorderLine(false, () => this.focus === "sidebar"), { shrink: 0 });

    this.tabBar = new AgentTabBar(() => this.chat.tabStates());
    this.tabBarOverlay = this.ui.showOverlay(this.tabBar, { anchor: "top-right", nonCapturing: true });
    this.ui.addInputListener((data) => this.handleGlobalInput(data));

    const root = new HStack([], { gap: 1 });
    root.addChild(sidebarColumn, { basis: SESSION_SIDEBAR_WIDTH, grow: 0, shrink: 0 });
    // Chat column: the panel fills the space above the pinned editor, and a
    // one-line status bar (model / context / cache) sits below the editor.
    const chatColumn = new VStack();
    chatColumn.addChild(this.chat, { grow: 1 });
    chatColumn.addChild(this.statusBar, { shrink: 0 });
    root.addChild(chatColumn, { grow: 1 });

    this.ui.setLayoutRoot(root);
  }

  public start(): void {
    this.ui.start();
    this.ui.setFocus(this.chat.editor);
    this.scheduleAltKeyHint();
  }

  /**
   * macOS 一次性兼容性提示：Option 键默认输入特殊字符而非 Alt 修饰键，
   * 不支持 Kitty 键盘协议的终端（如 Terminal.app）永远发不出 alt+s/t。
   * ProcessTerminal 启动时已自动做协议握手，握手成功的终端能正确上报
   * 修饰键，无需提示。延迟 600ms 是给握手回复留的窗口（本地通常几十
   * 毫秒）；只在自有终端时检查——注入 ui 的测试环境不提示。
   */
  private scheduleAltKeyHint(): void {
    const owned = this.owned;
    if (!owned || process.platform !== "darwin") return;
    const timer = setTimeout(() => {
      if (owned.terminal.kittyProtocolActive) return;
      const hint = macAltKeyHint({
        platform: process.platform,
        env: process.env,
        kittyProtocolActive: owned.terminal.kittyProtocolActive
      });
      if (hint) this.notify(hint, "warning", 15_000);
    }, 600);
    timer.unref?.();
  }

  public stop(): void {
    // Drop pending toast timers and status-line animations before teardown.
    this.chat.clearToasts();
    this.chat.stopStatuses();
    // preserveScreen：退出时只离开备用屏缓冲，完整还原进入前的终端内容，
    // 不把最后一屏文档转存到主屏（默认行为会留下全屏残留）。
    this.owned?.ui.stop({ preserveScreen: true });
  }

  // ---- ChatPanel facades: output, streaming, transcripts, asking ----

  /** Registers a tab for an agent (idempotent); the first one becomes active. */
  public registerAgent(name: string): void {
    this.chat.registerAgent(name);
  }

  /** Switches the mounted transcript to the given agent and clears its unread flag. */
  public setActiveAgent(name: string): void {
    this.chat.setActiveAgent(name);
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

  /** Toggles the draft entry (✎ 草稿) at the top of the sessions sidebar. */
  public setDraftMode(active: boolean): void {
    if (this.draftMode === active) return;
    this.draftMode = active;
    this.ui.requestRender();
  }

  /** See {@link ChatPanel.clearTranscript}. */
  public clearTranscript(agent?: string): void {
    this.chat.clearTranscript(agent);
  }

  /** See {@link ChatPanel.appendLine}. */
  public appendLine(line: string, agent?: string): void {
    this.chat.appendLine(line, agent);
  }

  /** See {@link ChatPanel.streamThinking}. */
  public streamThinking(delta: string, agent?: string): void {
    this.chat.streamThinking(delta, agent);
  }

  /** See {@link ChatPanel.streamText}. */
  public streamText(delta: string, agent?: string): void {
    this.chat.streamText(delta, agent);
  }

  /** See {@link ChatPanel.endStream}. */
  public endStream(agent?: string): void {
    this.chat.endStream(agent);
  }

  /** See {@link ChatPanel.toolStart}. */
  public toolStart(agent: string, toolCallId: string, toolName: string, args: unknown): void {
    this.chat.toolStart(agent, toolCallId, toolName, args);
  }

  /** See {@link ChatPanel.toolEnd}. */
  public toolEnd(agent: string, toolCallId: string, isError: boolean): void {
    this.chat.toolEnd(agent, toolCallId, isError);
  }

  /** See {@link ChatPanel.appendToolCall}. */
  public appendToolCall(toolName: string, summary: string, isError: boolean, agent?: string): void {
    this.chat.appendToolCall(toolName, summary, isError, agent);
  }

  /** See {@link ChatPanel.appendThinking}. */
  public appendThinking(text: string, agent?: string): void {
    this.chat.appendThinking(text, agent);
  }

  /** See {@link ChatPanel.appendUserMessage}. */
  public appendUserMessage(message: string): void {
    this.chat.appendUserMessage(message);
  }

  /** See {@link ChatPanel.beginStatus}: spinner line for long-running commands. */
  public beginStatus(label: string): number {
    return this.chat.beginStatus(label);
  }

  /** See {@link ChatPanel.endStatus}. */
  public endStatus(id: number, isError: boolean): void {
    this.chat.endStatus(id, isError);
  }

  /** See {@link ChatPanel.notify}: transient hints above the editor. */
  public notify(message: string, level: ToastLevel = "info", ttlMs?: number): void {
    this.chat.notify(message, level, ttlMs);
  }

  /** See {@link ChatPanel.appendMarkdown}. */
  public appendMarkdown(markdown: string, agent?: string): void {
    this.chat.appendMarkdown(markdown, agent);
  }

  /** See {@link ChatPanel.askQuestion}. */
  public askQuestion(question: string): Promise<string> {
    return this.chat.askQuestion(question);
  }

  /** Pushes a structured agent snapshot to the status bar below the editor. */
  public setStatus(snapshot: AgentStatusSnapshot): void {
    this.statusBar.set(snapshot);
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
        this.setFocusMode("editor");
        resolve(value);
      });
      const handle = this.ui.showOverlay(component, { anchor: "center" });
    });
  }

  // ---- Focus model and global keyboard routing ----

  /**
   * The keyboard focus model. Sidebar and transcript modes release the
   * pi-tui focus (null) — the global input listener routes their keys — while
   * the editor mode restores the real editor focus and its cursor.
   */
  private setFocusMode(mode: FocusMode): void {
    if (this.openMenu && mode !== "editor") return;
    this.focus = mode;
    this.sidebar.setFocused(mode === "sidebar");
    if (mode === "editor") this.ui.setFocus(this.chat.editor);
    else this.ui.setFocus(null);
    if (mode === "transcript") this.notify("转录浏览：↑↓ 滚动 · y 复制可见 · a 复制全部 · f 展开思考 · Tab 侧栏 · Esc 返回输入");
    this.ui.requestRender();
  }

  /**
   * Global keyboard routing. Runs before the focused component (pi-tui runs
   * input listeners first), so panel keys never collide with editor bindings.
   * While a menu overlay is open it owns the keyboard (except Ctrl+C).
   */
  private handleGlobalInput(data: string): { consume: boolean } | undefined {
    // Kitty 键盘协议（flag 2）会把一次按键拆成按下/释放两个事件，且
    // matchesKey 对两者都返回同一个键位（释放事件长成 \x1b[<code>;3:3u）。
    // 全局绑定若不过滤释放，按一次 ⌥S 会切到边栏又立刻切回来；双击 Esc
    // 的中止判定也会被 Esc 的释放误触成立即中止。与 pi-tui 自身约定一致：
    // 只响应按下，释放事件直接消费丢弃（长按重复仍照常处理）。
    if (isKeyRelease(data)) return { consume: true };
    if (matchesKey(data, "ctrl+c")) {
      this.options.onExit();
      return { consume: true };
    }
    // Ctrl+O：把输入框当前内容复制到系统剪贴板（OSC 52）。终端原生选择对
    // 折行编辑器内容只能按字符网格框选，应用端复制才能拿到完整逻辑文本。
    if (this.focus === "editor" && matchesKey(data, "ctrl+o")) {
      this.copyToClipboard(this.chat.editor.getExpandedText(), "输入框内容");
      return { consume: true };
    }
    if (this.openMenu) return undefined;
    // Typing can change the editor's height; keep the toast overlay above it
    // (no-op while no toasts are visible).
    this.chat.syncToastOverlay();
    // 双击 Esc 停止输出：第一下提示，窗口内再按一下才真的中止（防误触）。
    // 只在编辑器焦点 + busy 时接管 Esc，不影响侧栏/转录模式的 Esc 导航。
    if (
      this.focus === "editor" &&
      matchesKey(data, "escape") &&
      this.options.isBusy?.()
    ) {
      const now = Date.now();
      const window = this.options.doubleEscWindowMs ?? 2000;
      if (this.escapedArmedAt !== undefined && now - this.escapedArmedAt <= window) {
        this.escapedArmedAt = undefined;
        this.notify("已请求停止输出", "warning");
        void this.options.onAbort?.();
      } else {
        this.escapedArmedAt = now;
        this.notify("再按一次 Esc 停止输出");
      }
      return { consume: true };
    }
    // Home/End → 编辑器光标行首/行尾：转发给编辑器自身的键位处理（视口跳转
    // 已重绑到 shift 组合键，见构造函数），不再被 alt-screen 滚动抢先消费。
    // 注意：正常按键由 TUI 在焦点组件处理后自动触发重绘，而从监听器直接转发
    // 不会有这一步，必须显式请求一帧，否则光标位置变了但显示不刷新。
    if (this.focus === "editor" && (matchesKey(data, "home") || matchesKey(data, "end"))) {
      this.chat.editor.handleInput(data);
      this.ui.requestRender();
      return { consume: true };
    }
    if (matchesKey(data, "alt+s")) {
      this.setFocusMode(this.focus === "sidebar" ? "editor" : "sidebar");
      return { consume: true };
    }
    if (matchesKey(data, "alt+t")) {
      this.setFocusMode(this.focus === "transcript" ? "editor" : "transcript");
      return { consume: true };
    }
    if (matchesKey(data, "alt+up")) {
      this.chat.cycleAgent(-1);
      return { consume: true };
    }
    if (matchesKey(data, "alt+down")) {
      this.chat.cycleAgent(1);
      return { consume: true };
    }
    if (this.focus === "sidebar") {
      if (this.sidebar.handleInput(data)) {
        this.followSidebarSelection();
        this.ui.requestRender();
        return { consume: true };
      }
      // Printable input means the user wants to type: hand focus (and the
      // pending keystroke) back to the editor.
      if (!data.startsWith("\x1b")) {
        this.setFocusMode("editor");
        return undefined;
      }
      return { consume: true };
    }
    if (this.focus === "transcript") {
      if (matchesKey(data, "up")) {
        this.chat.scrollTranscript(-1);
        return { consume: true };
      }
      if (matchesKey(data, "down")) {
        this.chat.scrollTranscript(1);
        return { consume: true };
      }
      if (matchesKey(data, "f")) {
        this.chat.toggleAllFolds();
        return { consume: true };
      }
      // y/a：应用端复制（OSC 52 写系统剪贴板）。终端原生选择只作用于字符
      // 网格，跨屏行、跨分栏的选择无法按 UI 逻辑块进行；这里由应用提供。
      if (matchesKey(data, "y")) {
        this.copyToClipboard(this.chat.visibleText(), "可见区域");
        return { consume: true };
      }
      if (matchesKey(data, "a")) {
        this.copyToClipboard(this.chat.transcriptText(), "整个转录");
        return { consume: true };
      }
      if (matchesKey(data, "escape")) {
        this.setFocusMode("editor");
        return { consume: true };
      }
      if (matchesKey(data, "tab")) {
        this.setFocusMode("sidebar");
        return { consume: true };
      }
      if (!data.startsWith("\x1b")) {
        this.setFocusMode("editor");
        return undefined;
      }
      return { consume: true };
    }
    return undefined;
  }

  /**
   * 应用端复制：OSC 52 写系统剪贴板 + toast 反馈。终端若不支持（或未放行）
   * OSC 52，剪贴板不会有变化，这里只能提示失败原因。
   */
  private copyToClipboard(text: string, label: string): void {
    const trimmed = text.trim();
    if (!trimmed) {
      this.notify(`${label}没有可复制的内容`);
      return;
    }
    if (writeClipboard(trimmed)) this.notify(`${label}已复制：${trimmed.split("\n").length} 行`);
    else this.notify(`${label}复制失败：终端不支持 OSC 52 或内容过大`, "warning");
  }

  /** Keeps the sidebar selection inside the rows viewport after navigation. */
  private followSidebarSelection(): void {
    const row = this.sidebar.selectedRowIndex();
    const top = this.sidebarScroll.scrollTop;
    const height = this.sidebarScroll.viewportHeight;
    if (row < top) this.sidebarScroll.scrollTo(row);
    else if (height > 0 && row >= top + height) this.sidebarScroll.scrollTo(row - height + 1);
  }

  /**
   * Opens the keyboard-driven delete confirmation for a sidebar entry, next to
   * its row. Enter confirms (runs onDeleteSession), Esc cancels; focus returns
   * to the sidebar either way.
   */
  private confirmDelete(entry: SessionEntryState): void {
    if (this.openMenu) this.openMenu.close();
    const actions = [
      { label: "删除会话（含记录文件）", run: () => void this.options.onDeleteSession?.(entry.id) },
      { label: "取消", run: () => undefined }
    ];
    const close = (): void => {
      this.menuHandle?.hide();
      this.menuHandle = undefined;
      this.openMenu = undefined;
      this.setFocusMode("sidebar");
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
      // Next to the selected row; pi-tui clamps absolute positions on screen.
      { col: 2, row: this.sidebar.screenRowOfSelected(this.sidebarScroll.scrollTop), width }
    );
  }
}
