import assert from "node:assert/strict";
import { test } from "node:test";
import type { AutocompleteItem, AutocompleteProvider, Component, ViewportTUI } from "@earendil-works/pi-tui";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { ChatAutocompleteProvider } from "../src/cli/chat-autocomplete.ts";
import { CompletionPopup } from "../src/cli/floating-editor.ts";
import { SLASH_COMMANDS } from "../src/cli/commands.ts";
import { TuiRepl } from "../src/cli/tui-repl.ts";

// ---- 单元测试：斜杠命令（不依赖 fd） ----

test("provider：空编辑器键入 / 返回全部命令，前缀为整个 / 前缀", async () => {
  const provider = new ChatAutocompleteProvider();
  const suggestions = await provider.getSuggestions(["/"], 0, 1);
  assert.ok(suggestions);
  assert.equal(suggestions.prefix, "/");
  const names = suggestions.items.map((item) => item.value);
  for (const command of SLASH_COMMANDS) assert.ok(names.includes(command.name), `缺少命令 ${command.name}`);
  // 描述列包含参数提示（argumentHint — description）
  const model = suggestions.items.find((item) => item.value === "model");
  assert.match(model?.description ?? "", /\[provider\/\]model/);
});

test("provider：/ 后继续输入按命令名模糊过滤", async () => {
  const provider = new ChatAutocompleteProvider();
  const suggestions = await provider.getSuggestions(["/mo"], 0, 3);
  assert.ok(suggestions);
  const names = suggestions.items.map((item) => item.value);
  assert.ok(names.includes("model"), "应命中 /model");
  assert.ok(!names.includes("exit"), "不应命中无关命令");
});

test("provider：非斜杠且非 @ 上下文一律不提示（不做裸路径补全）", async () => {
  const provider = new ChatAutocompleteProvider();
  assert.equal(await provider.getSuggestions(["hello"], 0, 5), null, "普通文本不补全");
  assert.equal(await provider.getSuggestions(["hi /mo"], 0, 6), null, "行中间的 / 不补全");
  assert.equal(await provider.getSuggestions(["a", "/mo"], 1, 3), null, "斜杠仅第一行补全");
  assert.equal(await provider.getSuggestions(["src/cli"], 0, 7), null, "裸路径不补全");
});

test("provider：命令名后接空格时走参数补全（/context re → reset）", async () => {
  const provider = new ChatAutocompleteProvider();
  const suggestions = await provider.getSuggestions(["/context re"], 0, 11);
  assert.ok(suggestions);
  assert.equal(suggestions.prefix, "re");
  assert.deepEqual(suggestions.items.map((item) => item.value), ["reset"]);
  // 未声明参数候选的命令不提示
  assert.equal(await provider.getSuggestions(["/model "], 0, 7), null);
});

test("provider：applyCompletion 命令名补全替换 / 前缀并追加空格", async () => {
  const provider = new ChatAutocompleteProvider();
  const result = provider.applyCompletion(["/mo"], 0, 3, { value: "model", label: "model" }, "/mo");
  assert.deepEqual(result, { lines: ["/model "], cursorLine: 0, cursorCol: 7 });
});

test("provider：applyCompletion 参数补全只替换参数前缀", async () => {
  const provider = new ChatAutocompleteProvider();
  const result = provider.applyCompletion(["/context re"], 0, 11, { value: "reset", label: "reset" }, "re");
  assert.deepEqual(result, { lines: ["/context reset"], cursorLine: 0, cursorCol: 14 });
});

// ---- 单元测试：@ 文件补全（注入 mock 引擎，不调用真实 fd 进程） ----

interface MockEngine extends AutocompleteProvider {
  /** 每次 getSuggestions 收到的词元（光标前行首/词首到光标）。 */
  calls: string[];
}

/** 文件补全引擎 mock：返回固定候选并记录调用；applyCompletion 返回哨兵值以验证委托。 */
function mockEngine(items: AutocompleteItem[] = [], prefix = "@"): MockEngine {
  const calls: string[] = [];
  return {
    calls,
    async getSuggestions(lines, cursorLine, cursorCol) {
      calls.push((lines[cursorLine] ?? "").slice(0, cursorCol));
      return items.length > 0 ? { items, prefix } : null;
    },
    applyCompletion() {
      return { lines: ["MOCK"], cursorLine: 9, cursorCol: 9 };
    }
  };
}

test("provider：@ 上下文委托注入的引擎并透传候选", async () => {
  const engine = mockEngine([{ value: "@README.md", label: "README.md" }], "@");
  const provider = new ChatAutocompleteProvider({ fdEngine: engine });
  const suggestions = await provider.getSuggestions(["@"], 0, 1);
  assert.ok(suggestions);
  assert.equal(suggestions.prefix, "@");
  assert.deepEqual(suggestions.items.map((item) => item.value), ["@README.md"]);
  assert.deepEqual(engine.calls, ["@"], "引擎应收到 @ 词元");
});

test("provider：非 @ 上下文不调用引擎（含邮箱词元边界）", async () => {
  const engine = mockEngine([{ value: "@README.md", label: "README.md" }]);
  const provider = new ChatAutocompleteProvider({ fdEngine: engine });
  assert.equal(await provider.getSuggestions(["hello"], 0, 5), null, "普通文本不补全");
  assert.equal(await provider.getSuggestions(["mail@test"], 0, 9), null, "邮箱中的 @ 不补全");
  assert.equal(await provider.getSuggestions(["a", "b@outer"], 1, 7), null, "任意行都要求词元边界");
  assert.deepEqual(engine.calls, [], "不应有引擎调用");
});

test("provider：空白后的 @ 与多行非首行的 @ 都委托引擎", async () => {
  const engine = mockEngine([{ value: "@README.md", label: "README.md" }]);
  const provider = new ChatAutocompleteProvider({ fdEngine: engine });
  assert.ok(await provider.getSuggestions(["see @outer"], 0, 10), "空白后的 @ 应触发");
  assert.ok(await provider.getSuggestions(["hello", "see @outer"], 1, 10), "非首行的 @ 应可用");
  assert.equal(engine.calls.length, 2);
});

test("provider：fdEngine 为 null 等同 fd 缺失（空结果 + 一次性提示）", async () => {
  let calls = 0;
  const provider = new ChatAutocompleteProvider({ fdEngine: null, onFdMissing: () => (calls += 1) });
  assert.equal(await provider.getSuggestions(["@"], 0, 1), null, "fd 缺失时不返回任何候选");
  assert.equal(await provider.getSuggestions(["@alp"], 0, 4), null, "fd 缺失时不返回任何候选");
  assert.equal(calls, 1, "onFdMissing 只应触发一次");
});

test("provider：fdPath 为 null 同样缺失且不调用注入外的引擎", async () => {
  let calls = 0;
  const provider = new ChatAutocompleteProvider({ fdPath: null, onFdMissing: () => (calls += 1) });
  assert.equal(await provider.getSuggestions(["@"], 0, 1), null);
  assert.equal(calls, 1);
});

test("provider：applyCompletion 的 @ 补全整段委托给引擎", async () => {
  const engine = mockEngine([{ value: "@outer.txt", label: "outer.txt" }]);
  const provider = new ChatAutocompleteProvider({ fdEngine: engine });
  // 真实流程：先 getSuggestions（引擎随之就绪），再对选中候选 applyCompletion。
  await provider.getSuggestions(["@outer"], 0, 6);
  const result = provider.applyCompletion(["@outer"], 0, 6, { value: "@outer.txt", label: "outer.txt" }, "@outer");
  assert.deepEqual(result, { lines: ["MOCK"], cursorLine: 9, cursorCol: 9 }, "@ 前缀应委托给注入的引擎");
  // 斜杠前缀仍走 provider 自身的通用逻辑（不委托文件引擎）
  const slash = provider.applyCompletion(["/mo"], 0, 3, { value: "model", label: "model" }, "/mo");
  assert.deepEqual(slash, { lines: ["/model "], cursorLine: 0, cursorCol: 7 });
});

// ---- 集成测试：经 TuiRepl 驱动真实 Editor（补全下拉的弹出/关闭/应用/提交） ----

interface FakeOverlay {
  component: Component;
  options?: Record<string, unknown>;
  hidden: boolean;
  handle: { hide(): void; setHidden(hidden: boolean): void; isHidden(): boolean };
}

function makeFakeUi() {
  const children: Component[] = [];
  const overlays: FakeOverlay[] = [];
  const inputListeners: ((data: string) => { consume?: boolean } | undefined)[] = [];
  const ui = {
    terminal: { rows: 30, columns: 120 },
    children,
    overlays,
    inputListeners,
    layoutRoot: undefined as Component | undefined,
    setLayoutRoot: (component: Component) => {
      ui.layoutRoot = component;
    },
    addChild: (component: Component) => {
      children.push(component);
    },
    removeChild: (component: Component) => {
      const index = children.indexOf(component);
      if (index >= 0) children.splice(index, 1);
    },
    clear: () => children.splice(0, children.length),
    requestRender: () => undefined,
    start: () => undefined,
    stop: () => undefined,
    setFocus: () => undefined,
    addInputListener: (listener: (data: string) => { consume?: boolean } | undefined) => {
      inputListeners.push(listener);
      return () => {
        const index = inputListeners.indexOf(listener);
        if (index >= 0) inputListeners.splice(index, 1);
      };
    },
    showOverlay: (component: Component, options?: Record<string, unknown>) => {
      const entry: FakeOverlay = {
        component,
        options,
        hidden: false,
        handle: {
          hide: () => {
            const index = overlays.indexOf(entry);
            if (index >= 0) overlays.splice(index, 1);
          },
          setHidden: (hidden: boolean) => {
            entry.hidden = hidden;
          },
          isHidden: () => entry.hidden
        }
      };
      overlays.push(entry);
      return entry.handle;
    },
    hideOverlay: () => undefined,
    hasOverlay: () => overlays.length > 0
  };
  return ui;
}

type EditorAccess = {
  handleInput(data: string): void;
  getText(): string;
  render(width: number): string[];
  isShowingAutocomplete(): boolean;
};

function editorOf(repl: TuiRepl): EditorAccess {
  return (repl as unknown as { chat: { editor: EditorAccess } }).chat.editor;
}

function makeRepl(
  onSubmit: (line: string) => Promise<"continue" | "exit" | void> = async () => "continue",
  autocompleteEngine?: AutocompleteProvider | null
) {
  const ui = makeFakeUi();
  const repl = new TuiRepl({ ui: ui as unknown as ViewportTUI, onSubmit, onExit: () => undefined, autocompleteEngine });
  repl.start();
  return { repl, editor: editorOf(repl), ui };
}

/** TuiRepl 底部状态栏的行数（浮层定位的底部预留）。 */
function statusBarRows(repl: TuiRepl): number {
  const statusBar = (repl as unknown as { statusBar: { render(width: number): string[] } }).statusBar;
  return statusBar.render(120).length;
}

/** Editor 的补全请求是异步的（防抖 + provider 异步应答）：轮询直至出现/超时。 */
async function waitFor(predicate: () => boolean, message: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) assert.ok(false, `${message}（轮询超时）`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// 浮层补全布局常量：编辑器渲染宽度 = 120 列 - 侧栏 22 - gap 1。
const EDITOR_WIDTH = 97;

function completionOverlaysOf(ui: ReturnType<typeof makeFakeUi>): FakeOverlay[] {
  return ui.overlays.filter((overlay) => overlay.component instanceof CompletionPopup);
}

/** 触发一次编辑器渲染：浮层的挂载/剥离发生在渲染时。 */
function renderEditor(repl: TuiRepl): string[] {
  const editor = editorOf(repl);
  const bottomRows = 1 + statusBarRows(repl);
  return editor.render(EDITOR_WIDTH).slice(0, -bottomRows);
}

test("editor：空编辑器键入 / 弹出浮层命令补全，框体高度不变", async () => {
  const { repl, editor, ui } = makeRepl();
  const bare = renderEditor(repl).length;
  editor.handleInput("/");
  await waitFor(() => editor.isShowingAutocomplete(), "键入 / 后应出现补全");
  renderEditor(repl);
  const overlays = completionOverlaysOf(ui);
  assert.equal(overlays.length, 1, "补全列表应挂为浮层");
  assert.equal(overlays[0].options?.nonCapturing, true, "浮层不捕获键盘");
  assert.equal(overlays[0].options?.col, 23, "浮层对齐 chat 列起点（22 + 1 gap）");
  // 宽度自适应：不占满整行，下限 20 列，上限可用宽度
  const popupWidth = overlays[0].options?.width as number;
  assert.ok(popupWidth >= 20, "面板宽度下限 20 列");
  assert.ok(popupWidth < EDITOR_WIDTH, "面板宽度应自适应内容而非占满整行");
  const box = renderEditor(repl);
  assert.equal(box.length, bare, "框体高度不应被下拉撑高");
  const listText = stripTerminalSequences((overlays[0].component as unknown as CompletionPopup).render(popupWidth).join("\n"));
  assert.match(listText, /\bmodel\b/, "下拉中应列出 model 命令");
  assert.match(listText, /\bexit\b/, "下拉中应列出 exit 命令");
  // 面板样式：圆角边框与聊天内容明显区分
  assert.match(listText, /╭─+╮/, "顶部应有圆角边框");
});

test("editor：Esc 关闭补全浮层；继续输入过滤候选", async () => {
  const { repl, editor, ui } = makeRepl();
  editor.handleInput("/");
  await waitFor(() => editor.isShowingAutocomplete(), "键入 / 后应出现补全");
  editor.handleInput("se");
  await waitFor(
    () => {
      renderEditor(repl);
      const current = completionOverlaysOf(ui);
      return current.length === 1 && stripTerminalSequences((current[0].component as unknown as CompletionPopup).render(current[0].options?.width as number).join("\n")).includes("sessions");
    },
    "过滤后应包含 sessions 命令"
  );
  renderEditor(repl);
  const overlays = completionOverlaysOf(ui);
  assert.equal(overlays.length, 1, "过滤中浮层应存在");
  const listText = stripTerminalSequences((overlays[0].component as unknown as CompletionPopup).render(overlays[0].options?.width as number).join("\n"));
  assert.match(listText, /\bsessions\b/, "过滤后应包含 sessions 命令");
  assert.doesNotMatch(listText, /\bexit\b/, "过滤后不应再包含 exit 命令");
  editor.handleInput("\x1b");
  assert.ok(!editor.isShowingAutocomplete(), "Esc 应关闭补全");
  renderEditor(repl);
  assert.equal(completionOverlaysOf(ui).length, 0, "Esc 后浮层应销毁");
});

test("editor：空白后键入 @ 弹出文件补全浮层（mock 引擎）；Esc 关闭；普通文本不触发", async () => {
  const engine = mockEngine([{ value: "@README.md", label: "README.md" }], "@");
  const { repl, editor, ui } = makeRepl(undefined, engine);
  editor.handleInput("@");
  await waitFor(() => editor.isShowingAutocomplete(), "键入 @ 后应出现文件补全");
  renderEditor(repl);
  assert.equal(completionOverlaysOf(ui).length, 1, "文件补全应挂为浮层");

  editor.handleInput("RE");
  await waitFor(() => editor.isShowingAutocomplete(), "过滤中浮层应保持");
  renderEditor(repl);
  const overlays = completionOverlaysOf(ui);
  assert.equal(overlays.length, 1, "过滤中浮层应存在");
  const listText = stripTerminalSequences((overlays[0].component as unknown as CompletionPopup).render(overlays[0].options?.width as number).join("\n"));
  assert.match(listText, /README\.md/, "候选应来自注入的 mock 引擎");

  editor.handleInput("\x1b");
  renderEditor(repl);
  assert.ok(!editor.isShowingAutocomplete(), "Esc 应关闭补全");
  assert.equal(completionOverlaysOf(ui).length, 0, "Esc 后浮层应销毁");

  editor.handleInput("hello world ");
  renderEditor(repl);
  assert.ok(!editor.isShowingAutocomplete(), "普通文本不应触发补全");
});

test("editor：Tab 应用选中候选：/mo → /model（带尾随空格）", async () => {
  const { editor } = makeRepl();
  editor.handleInput("/mo");
  await waitFor(() => editor.isShowingAutocomplete(), "键入 /mo 后应出现补全");
  editor.handleInput("\t");
  assert.equal(editor.getText(), "/model ", "Tab 应把候选写回编辑器并补空格");
  assert.ok(!editor.isShowingAutocomplete(), "应用后下拉关闭");
});

test("editor：补全下拉打开时 Enter 仍可提交命令", async () => {
  const calls: string[] = [];
  const { editor } = makeRepl(async (line) => {
    calls.push(line);
    return "continue";
  });
  editor.handleInput("/status");
  await waitFor(() => editor.isShowingAutocomplete(), "键入 /status 后应出现补全");
  editor.handleInput("\r");
  await waitFor(() => calls.length === 1, "Enter 应提交一次");
  assert.equal(calls[0].trim(), "/status");
});
