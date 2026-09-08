import { copyToClipboard } from "@earendil-works/pi-coding-agent";
import { sliceByColumn, stripTerminalSequences, TuiAltScreen, visibleWidth, type Terminal } from "@earendil-works/pi-tui";
import { SESSION_SIDEBAR_WIDTH } from "./components.ts";

/** pi-tui 内部的 SGR 鼠标事件结构（只取用到的字段）。 */
interface MousePressEvent {
  release?: boolean;
  button: number;
  x: number;
  y: number;
}

/** pi-tui 内部选区端点结构（只取用到的字段）。 */
interface SelectionPoint {
  row: number;
  col: number;
  scrollView?: unknown;
}

/** 聊天列起点：侧栏 22 列 + 1 列 gap。 */
const CHAT_LEFT = SESSION_SIDEBAR_WIDTH + 1;

/** SwarmAltScreen 依赖的 pi-tui 内部成员（d.ts 均为 private，经断言访问）。 */
interface TuiInternals {
  hasOverlay?: () => boolean;
  handleSelectionMouseEvent?: (event: MousePressEvent) => void;
  handleRightClickPaste?: (event: MousePressEvent) => boolean;
  getActiveSelectionText?: () => string | undefined;
  getSelectionBounds(): { start: SelectionPoint; end: SelectionPoint } | undefined;
  previousScreen: string[];
  selectionAnchor?: SelectionPoint;
  selectionFocus?: SelectionPoint;
  selectionGranularity?: string;
  selectionInitialRange?: unknown;
  selectionDragged?: boolean;
  selectionPressActive?: boolean;
  pressedUrl?: unknown;
  lastClick?: unknown;
  requestRender(): void;
}

/**
 * pi-tui 全屏 TUI 的 pi-swarm 定制：
 *
 * - **组件内选择**：恢复 pi-tui 的滚动区锚定（见构造函数），拖选永远属于
 *   落点所在的滚动区组件（聊天/侧栏各自独立）——高亮被钳制在组件框内，
 *   文本提取自组件自己的内容行，跨面板拖动不会混入另一面板的内容。
 * - **右键复制选区**：pi-tui 内建的同名钩子只在 Windows 放行且语义是
 *   「读系统剪贴板粘贴」，这里覆盖为跨平台的「右键 = 复制活动选区」，
 *   复制后取消选区。
 * - **复制走验证过的原生剪贴板**：copyToClipboard 优先本地剪贴板
 *   （pbcopy/clip.exe/wl-copy/xclip/termux），SSH 等远程会话回退 OSC 52，
 *   成功与否有真实回报，"Copied!"/"Copy failed" 闪现提示由 pi-tui 负责。
 * - **关闭选中即复制**：交互改为「拖选 → 右键复制」的显式两步。
 */
export class SwarmAltScreen extends TuiAltScreen {
  public constructor(terminal: Terminal, showHardwareCursor?: boolean, logDirectory?: string) {
    super(terminal, showHardwareCursor, logDirectory, {
      copyOnSelect: false,
      copySelection: async (text) => {
        try {
          await copyToClipboard(text);
          return true;
        } catch {
          return false;
        }
      }
    });

    // 以下钩子在基类 d.ts 中均为 private，子类无法重新声明，只能在构造函数
    // 里装自身属性遮蔽原型方法（运行时动态派发，基类内部调用同样命中）。
    const internal = this as unknown as TuiInternals;
    const prototype = TuiAltScreen.prototype as unknown as {
      handleSelectionMouseEvent: (event: MousePressEvent) => void;
      getActiveSelectionText: () => string | undefined;
    };

    // 1) 组件内选择：pi-swarm 常驻 tab 栏 overlay 令 hasOverlay() 恒真，基类
    //    在左键按下时因此跳过 getScrollViewsAt，选区退化成整屏网格（高亮跨
    //    面板、中间行文本混入侧栏）。这里仅在左键按下期间屏蔽 hasOverlay，
    //    恢复「锚定到落点所在滚动区」的正常路径；落点不在任何滚动区（编辑器/
    //    状态栏/边框）时丢弃这次按下，不发起跨面板的网格选区。
    const originalHandleSelection = prototype.handleSelectionMouseEvent;
    internal.handleSelectionMouseEvent = (event) => {
      // 普通左键按下（release 排除；拖动 motion 的 button 带位 32，非 0）。
      const isPress = !event.release && event.button === 0;
      if (!isPress) {
        originalHandleSelection.call(this, event);
        return;
      }
      internal.hasOverlay = () => false;
      try {
        originalHandleSelection.call(this, event);
        if (internal.selectionAnchor && !internal.selectionAnchor.scrollView) {
          internal.selectionPressActive = false;
          internal.pressedUrl = undefined;
          internal.selectionDragged = false;
          internal.selectionAnchor = undefined;
          internal.selectionFocus = undefined;
          internal.selectionGranularity = "character";
          internal.selectionInitialRange = undefined;
          internal.lastClick = undefined;
          internal.requestRender();
        }
      } finally {
        delete internal.hasOverlay;
      }
    };

    // 2) 右键复制：仅响应右键按下 —— 有选区则复制并取消选区，无选区提示用法。
    //    （基类版本被 `process.platform !== "win32"` 短路且语义是粘贴。）
    internal.handleRightClickPaste = (event) => {
      if (event.release || event.button !== 2) return false;
      if (!this.hasActiveSelection()) {
        this.flash("先用左键拖选，再右键复制");
        return false;
      }
      // copyActiveSelectionToClipboard 是 async 函数：选区文本在首个 await 前
      // 同步提取完成，随后立刻取消选区是安全的。
      void this.copyActiveSelectionToClipboard();
      this.clearSelection();
      return true;
    };

    // 3) 选区文本提取：滚动区锚定的选区直接用基类实现（内容行天然不混其他
    //    面板）；网格兜底路径（理论上已不可达，防御性保留）把列窗口钳制到
    //    聊天列，避免中间行整宽提取混入侧栏。
    const originalGetActiveSelectionText = prototype.getActiveSelectionText;
    internal.getActiveSelectionText = () => {
      if (internal.selectionAnchor?.scrollView) return originalGetActiveSelectionText.call(this);
      const bounds = internal.getSelectionBounds();
      if (!bounds) return undefined;
      if (Math.max(bounds.start.col, bounds.end.col) <= CHAT_LEFT) return undefined;
      const lines: string[] = [];
      for (let row = bounds.start.row; row <= bounds.end.row; row++) {
        const line = internal.previousScreen[row] ?? "";
        let start = CHAT_LEFT;
        let end = visibleWidth(line);
        if (row === bounds.start.row) start = Math.max(CHAT_LEFT, bounds.start.col);
        if (row === bounds.end.row) end = Math.min(end, Math.max(CHAT_LEFT, bounds.end.col));
        lines.push(stripTerminalSequences(sliceByColumn(line, start, Math.max(0, end - start), true)).trimEnd());
      }
      const text = lines.join("\n");
      return text.length === 0 ? undefined : text;
    };
  }

  /** 取消选区并重绘（pi-tui 无公开清除方法，与基类 FOCUS_OUT 分支同款清理）。 */
  private clearSelection(): void {
    const selection = this as unknown as {
      selectionAnchor?: unknown;
      selectionFocus?: unknown;
      selectionGranularity?: string;
      selectionInitialRange?: unknown;
      selectionDragged?: boolean;
      requestRender(): void;
    };
    selection.selectionAnchor = undefined;
    selection.selectionFocus = undefined;
    selection.selectionGranularity = "character";
    selection.selectionInitialRange = undefined;
    selection.selectionDragged = false;
    selection.requestRender();
  }
}
