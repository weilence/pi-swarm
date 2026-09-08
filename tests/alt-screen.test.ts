import assert from "node:assert/strict";
import { test } from "node:test";
import { TuiAltScreen, type Terminal } from "@earendil-works/pi-tui";
import { SwarmAltScreen } from "../src/cli/alt-screen.ts";

/** 构造期不启动终端，只需满足类型；start() 前不会触碰真实终端能力。 */
const fakeTerminal = {
  write: () => undefined,
  get columns() {
    return 120;
  },
  get rows() {
    return 30;
  }
} as unknown as Terminal;

/** handleRightClickPaste 在 d.ts 中为 private，运行时是普通方法；测试走断言访问。 */
type RightClick = (event: { release?: boolean; button: number }) => boolean;
const rightClickOf = (ui: SwarmAltScreen): RightClick =>
  (ui as unknown as { handleRightClickPaste: RightClick }).handleRightClickPaste;

function makeScreen() {
  const ui = new SwarmAltScreen(fakeTerminal);
  const calls = { copies: [] as string[], flashes: [] as string[] };
  // 选区状态由 pi-tui 内部私有字段维护，测试直接桩掉这两个公开方法。
  (ui as unknown as { hasActiveSelection(): boolean }).hasActiveSelection = () => true;
  (ui as unknown as { copyActiveSelectionToClipboard(): Promise<boolean> }).copyActiveSelectionToClipboard =
    async () => {
      calls.copies.push("selection");
      return true;
    };
  (ui as unknown as { flash(message: string): void }).flash = (message: string) => {
    calls.flashes.push(message);
  };
  return { ui, calls };
}

test("right-click press copies the active selection", async () => {
  const { ui, calls } = makeScreen();
  const rightClick = rightClickOf(ui);
  assert.equal(rightClick({ release: false, button: 2 }), true, "right press is consumed");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls.copies.length, 1, "copy runs once per right-click");
  assert.equal(rightClick({ release: false, button: 2 }), true, "re-copy on the next right-click");
  assert.equal(calls.copies.length, 2, "selection stays active after copying");
});

test("right-click without a selection flashes a usage hint instead", () => {
  const { ui, calls } = makeScreen();
  (ui as unknown as { hasActiveSelection(): boolean }).hasActiveSelection = () => false;
  assert.equal(rightClickOf(ui)({ release: false, button: 2 }), false, "not consumed");
  assert.equal(calls.copies.length, 0);
  assert.ok(calls.flashes.some((message) => message.includes("拖选")), "hint tells the user how to select first");
});

test("release events and non-right buttons fall through to selection handling", () => {
  const { ui, calls } = makeScreen();
  const rightClick = rightClickOf(ui);
  assert.equal(rightClick({ release: true, button: 2 }), false, "release is ignored");
  assert.equal(rightClick({ release: false, button: 0 }), false, "left press is ignored");
  assert.equal(calls.copies.length, 0);
});

test("copy failures surface as Copy failed via the injected path", async () => {
  const ui = new SwarmAltScreen(fakeTerminal);
  const flashes: string[] = [];
  (ui as unknown as { flash(message: string): void }).flash = (message: string) => {
    flashes.push(message);
  };
  // 桩掉注入的复制路径：返回 false 时 pi-tui 应闪现 Copy failed，而不是
  // 假装成功（这是 OSC 52 裸写不可验证的痛点，也是接原生路径的意义）。
  (ui as unknown as { copySelection: (text: string) => Promise<boolean> }).copySelection = async () => false;
  const ok = await (ui as unknown as { copyTextToClipboard(text: string): Promise<boolean> }).copyTextToClipboard(
    "文本"
  );
  assert.equal(ok, false);
  assert.ok(flashes.includes("Copy failed"), "injected path returning false surfaces as Copy failed");
});

test("selection text is clipped to the chat column and never includes the sidebar", () => {
  const ui = new SwarmAltScreen(fakeTerminal);
  const sidebar = "s".repeat(22);
  const row = (chat: string): string => `${sidebar} ${chat}`; // 侧栏 22 列 + 1 列 gap
  (ui as unknown as { previousScreen: string[] }).previousScreen = [
    row("alpha first"), // alpha first 占列 23..33
    row("beta second"),
    row("gamma third")
  ];
  (ui as unknown as {
    getSelectionBounds(): { start: { row: number; col: number }; end: { row: number; col: number } } | undefined;
  }).getSelectionBounds = () => ({ start: { row: 0, col: 23 }, end: { row: 2, col: 28 } });

  // 首行列 23..，中间行钳到聊天窗口，末行 23..28（"gamma"）。
  const extract = (ui as unknown as { getActiveSelectionText(): string | undefined }).getActiveSelectionText.bind(ui);
  assert.equal(extract(), ["alpha first", "beta second", "gamma"].join("\n"));

  // 起点落在侧栏内（列 < 23）：钳制后为空 → 视为无选区。
  (ui as unknown as {
    getSelectionBounds(): { start: { row: number; col: number }; end: { row: number; col: number } } | undefined;
  }).getSelectionBounds = () => ({ start: { row: 0, col: 5 }, end: { row: 1, col: 10 } });
  assert.equal(extract(), undefined, "sidebar-only selection copies nothing");
});

test("right-click copy clears the selection and requests a redraw", async () => {
  const { ui, calls } = makeScreen();
  const state = ui as unknown as { selectionAnchor?: unknown; selectionFocus?: unknown; requestRender(): void };
  let renders = 0;
  state.selectionAnchor = { row: 1, col: 2 };
  state.selectionFocus = { row: 3, col: 4 };
  state.requestRender = () => {
    renders++;
  };

  assert.equal(rightClickOf(ui)({ release: false, button: 2 }), true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls.copies.length, 1, "copy happened");
  assert.equal(state.selectionAnchor, undefined, "anchor cleared");
  assert.equal(state.selectionFocus, undefined, "focus cleared");
  assert.ok(renders > 0, "a redraw is requested so the highlight disappears");
});

interface PressEvent {
  release?: boolean;
  button: number;
  x: number;
  y: number;
}

/** 在构造前替换原型钩子（构造时被捕获为“原始实现”），finally 恢复。 */
function withPrototypeHook(name: "handleSelectionMouseEvent" | "getActiveSelectionText", replacement: unknown, run: () => void): void {
  const proto = TuiAltScreen.prototype as unknown as Record<string, unknown>;
  const original = proto[name];
  proto[name] = replacement;
  try {
    run();
  } finally {
    proto[name] = original;
  }
}

test("left press anchoring neutralizes hasOverlay so selections stay scroll-view scoped", () => {
  const seen: boolean[] = [];
  withPrototypeHook(
    "handleSelectionMouseEvent",
    function (this: { hasOverlay(): boolean }) {
      seen.push(this.hasOverlay());
    },
    () => {
      const ui = new SwarmAltScreen(fakeTerminal);
      const internal = ui as unknown as {
        hasOverlay?: () => boolean;
        handleSelectionMouseEvent: (event: PressEvent) => void;
      };
      internal.hasOverlay = () => true; // 模拟常驻 tab 栏 overlay 令 hasOverlay 恒真
      // 先 release（不走锚定，hasOverlay 保持真实返回），再 press（被临时屏蔽）。
      internal.handleSelectionMouseEvent({ release: true, button: 0, x: 40, y: 5 });
      internal.handleSelectionMouseEvent({ release: false, button: 0, x: 40, y: 5 });
      assert.deepEqual(seen, [true, false], "press anchors with hasOverlay neutralized, release does not");
    }
  );
});

test("presses outside any scroll view never start a grid selection", () => {
  withPrototypeHook(
    "handleSelectionMouseEvent",
    function (this: Record<string, unknown>) {
      // 模拟基类在无滚动区落点时的网格锚定（anchor 无 scrollView）。
      this.selectionAnchor = { row: 0, col: 5 };
      this.selectionFocus = { row: 2, col: 9 };
      this.selectionPressActive = true;
      this.selectionDragged = false;
    },
    () => {
      const ui = new SwarmAltScreen(fakeTerminal);
      const internal = ui as unknown as {
        hasOverlay?: () => boolean;
        handleSelectionMouseEvent: (event: PressEvent) => void;
        selectionAnchor?: unknown;
        selectionPressActive?: boolean;
        requestRender(): void;
      };
      internal.hasOverlay = () => true;
      let renders = 0;
      internal.requestRender = () => {
        renders++;
      };
      internal.handleSelectionMouseEvent({ release: false, button: 0, x: 40, y: 20 });
      assert.equal(internal.selectionAnchor, undefined, "grid anchor is dropped");
      assert.equal(internal.selectionPressActive, false, "press state is reset");
      assert.ok(renders > 0, "highlight is cleared with a redraw");
    }
  );
});

test("scroll-anchored selection text delegates to pi-tui's content-line extraction", () => {
  withPrototypeHook("getActiveSelectionText", () => "FROM-CONTENT-LINES", () => {
    const ui = new SwarmAltScreen(fakeTerminal);
    const internal = ui as unknown as {
      selectionAnchor?: { row: number; col: number; scrollView?: unknown };
      getActiveSelectionText?: () => string | undefined;
      getSelectionBounds(): unknown;
    };
    const extract = internal.getActiveSelectionText!;
    // 滚动区锚定：委托基类，从聊天内容行提取。
    internal.selectionAnchor = { row: 1, col: 2, scrollView: {} };
    assert.equal(extract.call(ui), "FROM-CONTENT-LINES");
    // 无滚动区锚定：走网格兜底（此时无 bounds → undefined）。
    delete internal.selectionAnchor;
    assert.equal(extract.call(ui), undefined);
  });
});
