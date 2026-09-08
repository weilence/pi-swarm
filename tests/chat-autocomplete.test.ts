import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Component, ViewportTUI } from "@earendil-works/pi-tui";
import { SelectList, stripTerminalSequences } from "@earendil-works/pi-tui";
import { ChatAutocompleteProvider } from "../src/cli/chat-autocomplete.ts";
import { CompletionPopup } from "../src/cli/floating-editor.ts";
import { SLASH_COMMANDS } from "../src/cli/commands.ts";
import { TuiRepl } from "../src/cli/tui-repl.ts";

/** 机器上是否装了 fd：@ 补全以 fd 为唯一引擎（无兜底），相关用例按此门控。 */
const hasFd = spawnSync("fd", ["--version"], { stdio: "ignore" }).status === 0;
const testIfFd = hasFd ? test : test.skip;

interface Fixture {
  root: string;
  cleanup: () => Promise<void>;
}

/**
 * 嵌套 git 仓库 fixture：root 本身不是 git 仓库，nested/ 是（含空 .git 标记），
 * 且 nested 与 nested/sub 两级各有 .gitignore —— 用来验证 fd 对嵌套仓库与
 * 多层 ignore 规则的处理。
 */
async function makeFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "pi-swarm-ac-"));
  // root 层：非 git 仓库区域，不应有任何 ignore 规则生效
  await writeFile(join(root, "outer.txt"), "o");
  await writeFile(join(root, "outer-junk.log"), "j");
  // nested 层：git 仓库，顶层 .gitignore 隐藏 top-ignored.txt
  await mkdir(join(root, "nested", ".git"), { recursive: true });
  await writeFile(join(root, "nested", ".gitignore"), "top-ignored.txt\n");
  await writeFile(join(root, "nested", "top-ignored.txt"), "t");
  await writeFile(join(root, "nested", "nested-keep.txt"), "n");
  // sub 层：更深的 .gitignore 隐藏 deeper-ignored.txt
  await mkdir(join(root, "nested", "sub"));
  await writeFile(join(root, "nested", "sub", ".gitignore"), "deeper-ignored.txt\n");
  await writeFile(join(root, "nested", "sub", "deeper-ignored.txt"), "d");
  await writeFile(join(root, "nested", "sub", "deeper-keep.txt"), "k");
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

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

// ---- 单元测试：@ 文件补全（fd 缺失 → 空结果 + 一次性提示，无兜底） ----

test("provider：fd 缺失时 @ 不做兜底，返回空并只提示一次", async () => {
  let calls = 0;
  const provider = new ChatAutocompleteProvider({ fdPath: null, onFdMissing: () => (calls += 1) });
  assert.equal(await provider.getSuggestions(["@"], 0, 1), null, "fd 缺失时不返回任何候选");
  assert.equal(await provider.getSuggestions(["@alp"], 0, 4), null, "fd 缺失时不返回任何候选");
  assert.equal(calls, 1, "onFdMissing 只应触发一次");
});

// ---- 单元测试：@ 文件补全（真实 fd 路径） ----

testIfFd("provider：@ 列出文件与目录，目录带 / 可下钻", async (t) => {
  const { root, cleanup } = await makeFixture();
  t.after(cleanup);
  const provider = new ChatAutocompleteProvider({ basePath: root });
  const suggestions = await provider.getSuggestions(["@"], 0, 1);
  assert.ok(suggestions);
  assert.equal(suggestions.prefix, "@");
  const values = suggestions.items.map((item) => item.value);
  assert.ok(values.includes("@outer.txt"), `应含 @outer.txt：${values.join(", ")}`);
  assert.ok(values.includes("@nested/"), "目录应带 / 以便继续下钻");
  assert.ok(suggestions.items.length <= 20, "结果应截断 Top 20");
});

testIfFd("provider：@ 词元过滤（子串检索，含 @outer.txt）", async (t) => {
  const { root, cleanup } = await makeFixture();
  t.after(cleanup);
  const provider = new ChatAutocompleteProvider({ basePath: root });
  const suggestions = await provider.getSuggestions(["@outer"], 0, 6);
  assert.ok(suggestions);
  assert.equal(suggestions.prefix, "@outer");
  const values = suggestions.items.map((item) => item.value);
  assert.ok(values.includes("@outer.txt"), `应含 @outer.txt：${values.join(", ")}`);
  assert.ok(!values.includes("@nested/nested-keep.txt"), "不应包含无关文件");
});

testIfFd("provider：@ 目录下钻（@nested/ 列出目录内容）", async (t) => {
  const { root, cleanup } = await makeFixture();
  t.after(cleanup);
  const provider = new ChatAutocompleteProvider({ basePath: root });
  const suggestions = await provider.getSuggestions(["@nested/"], 0, 8);
  assert.ok(suggestions);
  const values = suggestions.items.map((item) => item.value);
  assert.ok(values.includes("@nested/nested-keep.txt"), `应含保留文件：${values.join(", ")}`);
  assert.ok(values.includes("@nested/sub/"), "应含子目录");
  assert.ok(!values.includes("@nested/top-ignored.txt"), "被 .gitignore 隐藏的不应出现");
});

testIfFd("provider：@ 必须在词元边界（行首或空白后）才生效", async (t) => {
  const { root, cleanup } = await makeFixture();
  t.after(cleanup);
  const provider = new ChatAutocompleteProvider({ basePath: root });
  // 行中、@ 前是空白：生效
  const inline = await provider.getSuggestions(["see @outer"], 0, 10);
  assert.ok(inline, "空白后的 @ 应触发");
  assert.ok(inline.items.some((item) => item.value === "@outer.txt"));
  // @ 前是普通字符（邮箱场景）：不触发
  assert.equal(await provider.getSuggestions(["mail@test"], 0, 9), null, "邮箱中的 @ 不补全");
  assert.equal(await provider.getSuggestions(["a", "b@outer"], 1, 7), null, "任意行都要求词元边界");
});

testIfFd("provider：多行输入中 @ 在非首行也可用", async (t) => {
  const { root, cleanup } = await makeFixture();
  t.after(cleanup);
  const provider = new ChatAutocompleteProvider({ basePath: root });
  const suggestions = await provider.getSuggestions(["hello", "see @outer"], 1, 10);
  assert.ok(suggestions, "非首行的 @ 应可用");
  assert.ok(suggestions.items.some((item) => item.value === "@outer.txt"));
});

testIfFd("provider：applyCompletion @ 文件补空格、目录不补（可继续下钻）", async () => {
  const provider = new ChatAutocompleteProvider({ basePath: "." });
  const file = provider.applyCompletion(["@outer"], 0, 6, { value: "@outer.txt", label: "outer.txt" }, "@outer");
  assert.deepEqual(file, { lines: ["@outer.txt "], cursorLine: 0, cursorCol: 11 });
  const dir = provider.applyCompletion(["@n"], 0, 2, { value: "@nested/", label: "nested/" }, "@n");
  assert.deepEqual(dir, { lines: ["@nested/"], cursorLine: 0, cursorCol: 8 });
});

/**
 * 嵌套仓库 + 多层 .gitignore：root 非 git 仓库、nested/ 是 git 仓库，两级
 * .gitignore。fd（ignore crate）按子树判定 git 仓库：nested 内部规则生效，
 * root 层无 ignore 规则（非仓库区域全部可见）。
 */
testIfFd("provider：fd 正确处理嵌套 git 仓库与多层 .gitignore", async (t) => {
  const { root, cleanup } = await makeFixture();
  t.after(cleanup);
  const provider = new ChatAutocompleteProvider({ basePath: root });
  const suggestions = await provider.getSuggestions(["@"], 0, 1);
  assert.ok(suggestions);
  const values = suggestions.items.map((item) => item.value);
  // root 层（非仓库）：没有 ignore 规则生效，junk 也可见
  assert.ok(values.includes("@outer-junk.log"), "非仓库区域不受 ignore 影响");
  // nested 顶层 .gitignore 生效
  assert.ok(values.includes("@nested/nested-keep.txt"), "保留文件应可见");
  assert.ok(!values.includes("@nested/top-ignored.txt"), "nested/.gitignore 应隐藏其规则文件");
  // sub 层更深的 .gitignore 生效
  assert.ok(values.includes("@nested/sub/deeper-keep.txt"), "深层保留文件应可见");
  assert.ok(!values.includes("@nested/sub/deeper-ignored.txt"), "sub/.gitignore 应隐藏其规则文件");
  // .git 目录本身不进结果
  assert.ok(!values.some((value) => value.includes("/.git/") || value === "@.git"), ".git 不应出现在候选中");
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

function makeRepl(onSubmit: (line: string) => Promise<"continue" | "exit" | void> = async () => "continue") {
  const ui = makeFakeUi();
  const repl = new TuiRepl({ ui: ui as unknown as ViewportTUI, onSubmit, onExit: () => undefined });
  repl.start();
  return { repl, editor: editorOf(repl), ui };
}

/** TuiRepl 底部状态栏的行数（浮层定位的底部预留）。 */
function statusBarRows(repl: TuiRepl): number {
  const statusBar = (repl as unknown as { statusBar: { render(width: number): string[] } }).statusBar;
  return statusBar.render(120).length;
}

/** Editor 的补全请求是异步的（含首次 fd 探测）：留一个宏任务余量再断言。 */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50));

// 浮层补全布局常量：编辑器渲染宽度 = 120 列 - 侧栏 22 - gap 1。
const EDITOR_WIDTH = 97;

interface FakeOverlay {
  component: Component;
  options?: Record<string, unknown>;
  hidden: boolean;
  handle: { hide(): void; setHidden(hidden: boolean): void; isHidden(): boolean };
}

function completionOverlaysOf(ui: ReturnType<typeof makeFakeUi>): FakeOverlay[] {
  return ui.overlays.filter((overlay) => overlay.component instanceof CompletionPopup);
}

/** 触发一次编辑器渲染：浮层的挂载/剥离发生在渲染时。 */
function renderEditor(repl: TuiRepl): string[] {
  return editorOf(repl).render(EDITOR_WIDTH);
}

test("editor 为空时键入 / 弹出浮层命令补全，框体高度不变", async () => {
  const { repl, editor, ui } = makeRepl();
  const bare = renderEditor(repl).length;
  editor.handleInput("/");
  await flush();
  assert.ok(editor.isShowingAutocomplete(), "键入 / 后应出现补全");
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
  assert.match(listText, /╰─+╯/, "底部应有圆角边框");
  assert.match(listText, /│\s+model/, "内容应有边框与内边距");
  // 定位：浮层底缘贴编辑器框顶（屏幕高 - 状态栏 - 框高 - 列表高）
  const bottomRows = statusBarRows(repl);
  const expectedRow = 30 - bottomRows - box.length - overlays[0].component.render(popupWidth).length;
  assert.equal(overlays[0].options?.row, expectedRow);
});

test("Esc 关闭补全浮层；继续输入过滤候选", async () => {
  const { repl, editor, ui } = makeRepl();
  editor.handleInput("/");
  await flush();
  editor.handleInput("se");
  await flush();
  assert.ok(editor.isShowingAutocomplete());
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

testIfFd("空白后键入 @ 弹出文件补全浮层；输入过滤；普通文本不弹", async () => {
  const { repl, editor, ui } = makeRepl();
  editor.handleInput("@");
  await flush();
  assert.ok(editor.isShowingAutocomplete(), "键入 @ 后应出现文件补全");
  renderEditor(repl);
  editor.handleInput("RE");
  await flush();
  renderEditor(repl);
  const overlays = completionOverlaysOf(ui);
  assert.equal(overlays.length, 1, "过滤中浮层应存在");
  const listText = stripTerminalSequences((overlays[0].component as unknown as CompletionPopup).render(overlays[0].options?.width as number).join("\n"));
  assert.match(listText, /README\.md/, "过滤后应列出 README.md");
  editor.handleInput("\x1b");
  renderEditor(repl);
  assert.ok(!editor.isShowingAutocomplete(), "Esc 应关闭补全");
  assert.equal(completionOverlaysOf(ui).length, 0, "Esc 后浮层应销毁");
  editor.handleInput("hello world ");
  renderEditor(repl);
  assert.ok(!editor.isShowingAutocomplete(), "普通文本不应触发补全");
});

test("Tab 应用选中候选：/mo → /model（带尾随空格）", async () => {
  const { editor } = makeRepl();
  editor.handleInput("/mo");
  await flush();
  editor.handleInput("\t");
  assert.equal(editor.getText(), "/model ", "Tab 应把候选写回编辑器并补空格");
  assert.ok(!editor.isShowingAutocomplete(), "应用后下拉关闭");
});

test("补全下拉打开时 Enter 仍可提交命令", async () => {
  const calls: string[] = [];
  const { editor } = makeRepl(async (line) => {
    calls.push(line);
    return "continue";
  });
  editor.handleInput("/status");
  await flush();
  editor.handleInput("\r");
  await flush();
  assert.equal(calls.length, 1, "Enter 应提交一次");
  assert.equal(calls[0].trim(), "/status");
});
