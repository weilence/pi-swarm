import { getSelectListTheme } from "@earendil-works/pi-coding-agent";
import { Editor, SelectList, visibleWidth, type Component, type EditorTheme, type OverlayHandle, type ViewportTUI } from "@earendil-works/pi-tui";

/** 浮层补全的定位信息（由宿主布局提供：只有它知道编辑器在屏幕上的位置）。 */
export interface FloatingCompletionPlacement {
  /** 浮层左缘的屏幕列（编辑器所在列的起点，即编辑器左边框所在列）。 */
  col: number;
  /** 编辑器之下、屏幕底部之间预留的行数（如状态栏）；每次渲染时求值。 */
  bottomRows: () => number;
}

export interface FloatingEditorOptions extends EditorTheme {
  /** 提供后补全下拉以浮层呈现（VSCode 式，不推挤布局）；缺省时保持内嵌。 */
  placement?: FloatingCompletionPlacement;
}

/** Editor 私有补全状态的最小读取面（子类也无法访问 TS private 字段）。 */
interface AutocompleteInternals {
  autocompleteState: string | null;
  autocompleteList?: SelectList;
}

/** 补全浮层面板的最小宽度（列）：过窄会随候选长度抖动。 */
const POPUP_MIN_WIDTH = 20;

/**
 * 补全浮层面板：给 SelectList 套一层圆角边框 + 内边距，让它飘在 transcript
 * 上时有独立的“面板感”，与聊天内容明显区分（VSCode 式）。边框默认取主题
 * accent 色（焦点色），比编辑器普通边框醒目。
 */
export class CompletionPopup implements Component {
  public constructor(
    private readonly list: SelectList,
    /** 边框配色；默认取主题 accent 色（焦点面板用 accent 边框是通行做法）。 */
    private readonly border: (text: string) => string = getSelectListTheme().selectedText
  ) { }

  public render(width: number): string[] {
    const inner = Math.max(1, width - 4); // │ + 空格 + 内容 + 空格 + │
    const rows = this.list.render(inner);
    const body = rows.map((row) => {
      const pad = " ".repeat(Math.max(0, inner - visibleWidth(row)));
      return `${this.border("│")} ${row}${pad} ${this.border("│")}`;
    });
    const edge = this.border("─".repeat(width - 2));
    return [this.border(`╭${edge}╮`), ...body, this.border(`╰${edge}╯`)];
  }

  /** Component 接口要求；列表自身的缓存由它自己的 invalidate 管理。 */
  public invalidate(): void {
    this.list.invalidate();
  }
}

/**
 * 带浮层补全的编辑器：完全复用 pi-tui Editor 的补全触发、过滤与键位
 * （Editor 依然“认为”自己渲染了内嵌列表），只在渲染层做两件事：
 *
 *  1. 剥离 —— Editor.render 把补全列表追加在底边框之后（paddingX 为 0 时
 *     contentWidth 恰为 width），把这段尾部行从输出中裁掉，编辑器框保持
 *     恒定高度，transcript 不被推挤；
 *  2. 浮层 —— 把同一个 SelectList 实例挂到 screen-level overlay（与 toast
 *     同机制，nonCapturing 不抢键盘），定位在编辑器框正上方：上缘贴着
 *     「屏幕底部 − 预留行 − 编辑器框高 − 列表高」。同一 SelectList 实例
 *     意味着高亮选中、滚动状态只有一份，交互逻辑零改动。
 *
 * 未提供 placement 时退化为标准内嵌行为（单测与无布局宿主使用）。
 */
export class FloatingEditor extends Editor {
  private readonly placement?: FloatingCompletionPlacement;
  private readonly ui: ViewportTUI;
  /** 当前补全浮层；补全关闭或几何/列表实例变化时销毁/重建。 */
  private completionOverlay?: OverlayHandle;
  private overlayKey?: string;
  private overlayList?: SelectList;

  public constructor(tui: ViewportTUI, options: FloatingEditorOptions) {
    super(tui, { borderColor: options.borderColor, selectList: options.selectList });
    this.ui = tui;
    this.placement = options.placement;
  }

  /**
   * 应用候选后的继续下钻：pi-tui Editor 应用补全（Enter/Tab）后一律取消
   * 补全且不重新触发，选中目录（插入 @dir/）后必须再敲一个字符才会列出
   * 目录内容。这里在应用发生且光标前仍是完整 @ 词元时主动重新触发，行为
   * 等同用户手动键入这些字符。纯取消（Esc，文本未变）不重新弹出。
   */
  public handleInput(data: string): void {
    const internals = this as unknown as AutocompleteInternals;
    const popupWasOpen = internals.autocompleteState !== null;
    const textBefore = this.getText();
    super.handleInput(data);
    if (!popupWasOpen) return;
    if (internals.autocompleteState !== null) return; // 列表内导航等，补全仍开着
    if (this.getText() === textBefore) return; // 纯取消（如 Esc）：文本未变
    const cursor = (this as unknown as { state?: { lines: string[]; cursorLine: number; cursorCol: number } }).state;
    const line = cursor?.lines[cursor.cursorLine] ?? "";
    const beforeCursor = line.slice(0, cursor?.cursorCol ?? 0);
    if (/(?:^|\s)@[^\s]*$/.test(beforeCursor)) {
      (this as unknown as { tryTriggerAutocomplete(): void }).tryTriggerAutocomplete();
    }
  }

  public render(width: number): string[] {
    const lines = super.render(width);
    const placement = this.placement;
    if (!placement) return lines;

    const internals = this as unknown as AutocompleteInternals;
    const list = internals.autocompleteList;
    if (!internals.autocompleteState || !list) {
      this.hideCompletionOverlay();
      return lines;
    }
    // 与 Editor.render 相同的列表渲染（paddingX=0 ⇒ contentWidth=width），
    // 其行数即编辑器输出尾部的列表行数。
    const listRows = list.render(width);
    const boxRows = lines.length - listRows.length;
    // 结构守卫：剥离后至少要剩顶边框 + 输入行 + 底边框，否则保持内嵌。
    if (boxRows < 3) return lines;
    this.syncCompletionOverlay(placement, list, { boxRows, listRows: listRows.length, width });
    return lines.slice(0, boxRows);
  }

  /** 按几何键同步浮层：无列表时销毁；几何变化时原位重建。 */
  private syncCompletionOverlay(
    placement: FloatingCompletionPlacement,
    list: SelectList,
    geometry: { boxRows: number; listRows: number; width: number }
  ): void {
    // 面板 = 列表行 + 上下边框
    const popupRows = geometry.listRows + 2;
    // 宽度自适应：用探针宽度渲染一次（SelectList 行只截断不填充），
    // 取最宽行 + 6（边框/内边距 4 列 + SelectList 描述截断的内部 -2 安全
    // 边距，补偿后窄宽度下描述不会被多截）；下限 POPUP_MIN_WIDTH 避免抖动，
    // 上限为可用宽度（不越过终端右缘）。
    const probe = list.render(this.ui.terminal.columns);
    const natural = probe.reduce((max, line) => Math.max(max, visibleWidth(line)), 0);
    const maxWidth = Math.max(1, Math.min(geometry.width, this.ui.terminal.columns - placement.col));
    const popupWidth = Math.max(Math.min(natural + 6, maxWidth), Math.min(POPUP_MIN_WIDTH, maxWidth));
    const row = Math.max(0, this.ui.terminal.rows - placement.bottomRows() - geometry.boxRows - popupRows);
    const key = `${row}:${placement.col}:${popupWidth}:${geometry.listRows}`;
    // 候选每次刷新都是新 SelectList 实例：实例变化时也必须重建浮层。
    if (this.completionOverlay && this.overlayKey === key && this.overlayList === list) return;
    this.completionOverlay?.hide();
    this.completionOverlay = this.ui.showOverlay(new CompletionPopup(list), {
      col: placement.col,
      row,
      width: popupWidth,
      nonCapturing: true
    });
    this.overlayKey = key;
    this.overlayList = list;
    this.ui.requestRender();
  }

  private hideCompletionOverlay(): void {
    if (!this.completionOverlay) return;
    this.completionOverlay.hide();
    this.completionOverlay = undefined;
    this.overlayKey = undefined;
    this.overlayList = undefined;
  }
}
