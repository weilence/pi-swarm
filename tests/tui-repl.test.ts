import assert from "node:assert/strict";
import { test } from "node:test";
import type { Component } from "@earendil-works/pi-tui";
import { Container, Markdown, stripTerminalSequences, TuiAltScreen, Text, visibleWidth } from "@earendil-works/pi-tui";
import { splitMarkdownBlocks, type ChatPanel } from "../src/cli/chat-panel.ts";
import { summarizeToolArgs, TuiRepl } from "../src/cli/tui-repl.ts";
import { PickerComponent, StatusBar, StatusLine, ToastStack } from "../src/cli/components.ts";
import type { SessionSummary } from "../src/core/session/session-types.ts";

test("splitMarkdownBlocks cuts on blank lines outside code fences", () => {
  assert.deepEqual(splitMarkdownBlocks("para1\n\npara2"), { blocks: ["para1"], rest: "para2" });
  assert.deepEqual(splitMarkdownBlocks("```js\ncode\n```\n\nafter"), {
    blocks: ["```js\ncode\n```"],
    rest: "after"
  });
  assert.deepEqual(splitMarkdownBlocks("a"), { blocks: [], rest: "a" });
});

test("splitMarkdownBlocks keeps blank lines inside open fences in the remainder", () => {
  const open = "```js\nconst a = 1;\n\nconst b = 2;";
  assert.deepEqual(splitMarkdownBlocks(open), { blocks: [], rest: open });
  assert.deepEqual(splitMarkdownBlocks(`${open}\n\ntail`), { blocks: [], rest: `${open}\n\ntail` });

  const closed = open + "\n```";
  assert.deepEqual(splitMarkdownBlocks(`${closed}\n\ntail`), { blocks: [closed], rest: "tail" });
});

interface FakeOverlay {
  component: Component;
  options?: Record<string, unknown>;
  hidden: boolean;
  handle: { hide(): void; setHidden(hidden: boolean): void; isHidden(): boolean };
}

// pi-tui marks viewport TUIs with a registry symbol that is not re-exported as a value.
const VIEWPORT_TUI = Symbol.for("@earendil-works/pi-tui/viewport");

function makeFakeUi() {
  const children: Component[] = [];
  const overlays: FakeOverlay[] = [];
  const inputListeners: ((data: string) => { consume?: boolean } | undefined)[] = [];
  const focusTargets: unknown[] = [];
  const ui = {
    terminal: { rows: 30, columns: 120 },
    children,
    overlays,
    inputListeners,
    focusTargets,
    [VIEWPORT_TUI]: true,
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
    setFocus: (component: unknown) => {
      focusTargets.push(component);
    },
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

/** Feeds a keystroke through the registered input listeners, TuiBase-style. */
function press(ui: ReturnType<typeof makeFakeUi>, data: string): boolean {
  for (const listener of ui.inputListeners) {
    if (listener(data)?.consume) return true;
  }
  return false;
}

/** The chat panel's editor, reached through the REPL for input simulation. */
function editorOf(repl: TuiRepl): { handleInput(data: string): void; disableSubmit: boolean } {
  return (repl as unknown as { chat: { editor: { handleInput(data: string): void; disableSubmit: boolean } } }).chat.editor;
}

/** The chat half of the layout: layoutRoot → HStack[sidebar, VStack[ChatPanel, statusBar]]. */
function chatPanelOf(ui: ReturnType<typeof makeFakeUi>): ChatPanel {
  const root = ui.layoutRoot! as Container;
  const [, chatColumn] = root.children as [Container, Container];
  const [chat] = chatColumn.children as [Container];
  return chat as ChatPanel;
}

/** The toast overlay entry in the fake ui (tab bar overlay is separate). */
function toastOverlayOf(ui: ReturnType<typeof makeFakeUi>): FakeOverlay {
  const entry = ui.overlays.find((overlay) => overlay.component instanceof ToastStack);
  assert.ok(entry, "toast overlay is mounted");
  return entry;
}

/** The toast stack held by the chat panel (private, tests only). */
function toastsOf(ui: ReturnType<typeof makeFakeUi>): ToastStack {
  return (chatPanelOf(ui) as unknown as { toasts: ToastStack }).toasts;
}

/** The active transcript container: layoutRoot → HStack[sidebar, VStack[ChatPanel(VStack[ScrollView → scrollBody → transcript([log, stream]), inputArea]), statusBar]]. */
function mountedChat(ui: ReturnType<typeof makeFakeUi>): Container {
  const root = ui.layoutRoot! as Container;
  const [, chatColumn] = root.children as [Container, Container];
  const [chat] = chatColumn.children as [Container];
  const [scrollView] = chat.children as [Container];
  const [scrollBody] = scrollView.children as [Container];
  const [transcript] = scrollBody.children as [Container];
  return transcript;
}

function makeRepl(): {
  repl: TuiRepl;
  ui: ReturnType<typeof makeFakeUi>;
  log: Container;
  stream: Container;
  overlays: FakeOverlay[];
} {
  const ui = makeFakeUi();
  const repl = new TuiRepl({ ui: ui as never, onSubmit: async () => undefined, onExit: () => undefined });
  const [log, stream] = mountedChat(ui).children as [Container, Container];
  return { repl, ui, log, stream, overlays: ui.overlays };
}

test("streamText flushes completed markdown blocks and keeps the partial in the tail", () => {
  const { repl, log, stream } = makeRepl();
  repl.streamText("### 计划\n\n");
  assert.equal(log.children.length, 1);
  assert.ok(log.children[0] instanceof Markdown, "completed blocks render as markdown");
  assert.ok(log.children[0].render(80).join("\n").includes("计划"));

  repl.streamText("- 步骤一");
  assert.equal(log.children.length, 1, "partial block stays out of the log");
  assert.equal(stream.children.length, 2, "seam spacer + live tail");
  assert.ok(stream.children[1] instanceof Text);
  assert.equal((stream.children[0] as Text).render(80).join("\n").trim(), "", "seam blank line before the tail");
  assert.ok((stream.children[1] as Text).render(80).join("\n").includes("步骤一"));
});

test("streamThinking shows an expanded live tail and folds into the log as collapsible reasoning", () => {
  const { repl, log, stream } = makeRepl();
  repl.streamThinking("让我想想…");
  assert.ok(stream.children.length > 0, "thinking tail is visible while streaming");
  const live = stripTerminalSequences(stream.children[0].render(80).join("\n"));
  assert.ok(live.includes("让我想想…"), "thinking content is expanded, not a collapsed summary");
  assert.ok(live.includes("▸"), "tail keeps the thinking marker");

  repl.streamText("答案");
  assert.equal(log.children.length, 1, "thinking folds into the log as a collapsible entry");
  assert.ok(!(log.children[0] instanceof Markdown));
  assert.ok(log.children[0].render(80).join("\n").includes("思考（"), "folded entry keeps its summary label");
});

test("live thinking tail shows at most 3 lines and keeps the latest content", () => {
  const { repl, stream } = makeRepl();
  repl.streamThinking("第一行\n第二行\n第三行\n第四行\n第五行");
  const lines = stripTerminalSequences(stream.children[0].render(80).join("\n")).split("\n");
  assert.equal(lines.length, 3, "rendered tail is capped at 3 lines");
  assert.ok(lines[0].includes("第三行"), "older lines beyond the cap are dropped");
  assert.ok(lines[2].includes("第五行"), "the latest thinking line is visible");
});

test("endStream flushes the remaining partial block as markdown", () => {
  const { repl, log, stream } = makeRepl();
  repl.streamText("尾段内容");
  repl.endStream();
  assert.equal(log.children.length, 1);
  assert.ok(log.children[0] instanceof Markdown);
  assert.equal(stream.children.length, 0, "tail clears after the stream ends");
});

test("interleaved text and thinking commits in arrival order", () => {
  const { repl, log, stream } = makeRepl();
  repl.streamText("答案一");
  repl.streamThinking("推理一");
  repl.streamText("答案二");
  repl.streamThinking("推理二");
  repl.endStream();

  assert.equal(log.children.length, 4, "text1, thinking1, text2, thinking2 all landed");
  assert.ok(log.children[0] instanceof Markdown, "first text run is plain markdown");
  assert.ok((log.children[0] as Markdown).render(80).join("\n").includes("答案一"));
  assert.ok(!(log.children[1] instanceof Markdown), "first thinking run is collapsible");
  assert.ok(log.children[1].render(80).join("\n").includes("思考（"));
  assert.ok(log.children[2] instanceof Markdown, "second text run is plain markdown");
  assert.ok((log.children[2] as Markdown).render(80).join("\n").includes("答案二"));
  assert.ok(!(log.children[3] instanceof Markdown), "second thinking run is collapsible");
  assert.ok(log.children[3].render(80).join("\n").includes("思考（"));
  assert.equal(stream.children.length, 0, "tail clears after the stream ends");
});

test("notify mounts toasts as a bottom-right overlay above the editor, outside the layout flow", () => {
  const { repl, ui, log } = makeRepl();
  repl.streamText("转录里的聊天内容");
  repl.endStream();
  const chat = chatPanelOf(ui);
  const before = chat.render(80);

  repl.notify("已切换会话");
  const after = chat.render(80);
  assert.equal(after.length, before.length, "toast covers rows instead of pushing the transcript up");
  assert.ok(after.join("\n").includes("转录里的聊天内容"), "transcript render output is unchanged by toasts");

  assert.equal(ui.overlays.length, 2, "tab bar plus the toast overlay");
  const entry = toastOverlayOf(ui);
  assert.equal(entry.options?.anchor, "bottom-right", "pinned bottom-right");
  assert.equal(entry.options?.nonCapturing, true, "toast never takes focus");
  const editorRows = (chat as unknown as { editor: { render(w: number): string[] } }).editor.render(ui.terminal.columns).length;
  assert.equal(entry.options?.offsetY, -editorRows, "overlay is lifted above the editor block");

  const pill = entry.component.render(Number(entry.options?.width));
  assert.ok(stripTerminalSequences(pill.join("\n")).includes("已切换会话"), "toast text renders");
  assert.ok(pill.join("\n").includes("\x1b[48;5;236m"), "pill has a solid background, clearly distinct from chat");
  assert.equal(entry.options?.width, toastsOf(ui).measureWidth(ui.terminal.columns), "overlay is sized to the pill block");

  assert.equal(log.children.length, 1, "only the streamed text is in the transcript log");
  assert.ok(!stripTerminalSequences(log.children[0].render(80).join("\n")).includes("已切换会话"), "toast text never lands in the transcript");
});

test("toast levels differ in icon and error/warning outlive info", async () => {
  const { repl, ui } = makeRepl();
  const toasts = toastsOf(ui);
  repl.notify("出错了", "error");
  repl.notify("注意一下", "warning");
  // ttl 只有组件层暴露：REPL 门面用默认时长，测试直接驱动栈来验证过期。
  toasts.notify("短暂提示", "info", 5);
  const entry = toastOverlayOf(ui);
  const pill = stripTerminalSequences(entry.component.render(Number(entry.options?.width)).join("\n"));
  assert.match(pill, /✘/);
  assert.match(pill, /出错了/);
  assert.match(pill, /⚠/);
  assert.match(pill, /注意一下/);
  assert.match(pill, /短暂提示/);

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(entry.component.render(Number(entry.options?.width)).length, 2, "expired info toast disappears");
});

test("toast stack caps at 4 entries, repeats extend instead of stacking, and empty stack hides the overlay", () => {
  const { repl, ui } = makeRepl();
  const toasts = toastsOf(ui);
  for (const index of [0, 1, 2, 3]) repl.notify(`提示 ${index}`);
  repl.notify("提示 5");
  assert.equal(toasts.render(80).length, 4, "oldest toast is dropped beyond the cap");
  const lines = stripTerminalSequences(toasts.render(80).join("\n"));
  assert.ok(!lines.includes("提示 0"), "the oldest entry is the one dropped");
  assert.ok(lines.includes("提示 5"));

  repl.notify("提示 5");
  assert.equal(toasts.render(80).length, 4, "a repeat does not stack a second copy");
  toasts.clear();
  assert.equal(toasts.render(80).length, 0, "clear drops everything");
  assert.ok(toastOverlayOf(ui).handle.isHidden(), "empty stack hides the toast overlay");
});

test("status bar below the editor renders model, context, and cache hit rate", () => {
  const { repl, ui } = makeRepl();
  const root = ui.layoutRoot! as Container;
  const [, chatColumn] = root.children as [Container, Container];
  const [chat, statusBar] = chatColumn.children as [Container, Container];
  assert.equal(chatColumn.children.length, 2, "chat panel first, status bar below");
  assert.ok(statusBar instanceof StatusBar, "the bar is the last chat-column child (below the editor)");

  repl.setStatus({
    model: "openai/gpt-4o",
    thinkingLevel: "high",
    contextTokens: 12000,
    contextWindow: 128000,
    contextPercent: 9.4,
    inputTokens: 100,
    outputTokens: 4500,
    cacheRead: 800,
    cacheWrite: 100,
    cost: 0.1234
  });
  const line = stripTerminalSequences(statusBar.render(160).join("\n"));
  assert.match(line, /模型 openai\/gpt-4o/);
  assert.match(line, /thinking high/);
  assert.match(line, /上下文 12\.0k\/128\.0k（9\.4%）/);
  assert.match(line, /缓存命中 80\.0%/, "cache hit = cacheRead / (cacheRead + cacheWrite + input)");
  assert.match(line, /\$0\.12/);
  assert.ok(!line.includes("输出 "), "raw output token count is not shown (speed instead)");
  assert.ok(!line.includes("任务执行中"), "idle state shows no busy flag");

  repl.setStatus({ model: "openai/gpt-4o", busy: true });
  assert.match(stripTerminalSequences(statusBar.render(160).join("\n")), /任务执行中/);
});

test("status bar without a model shows a placeholder and skips unknown segments", () => {
  const { repl } = makeRepl();
  repl.setStatus({});
  const root = (repl as unknown as { ui: { layoutRoot: Container } }).ui.layoutRoot!;
  const [, chatColumn] = root.children as [Container, Container];
  const [, statusBar] = chatColumn.children as [Container, Container];
  const line = stripTerminalSequences(statusBar.render(160).join("\n"));
  assert.match(line, /模型 未选择/);
  assert.ok(!line.includes("上下文"), "no context segment without data");
  assert.ok(!line.includes("缓存命中"), "no cache segment without data");
});

test("status bar shows TTFT and the task-average output speed from the snapshot", () => {
  const bar = new StatusBar();
  const line = (): string => stripTerminalSequences(bar.render(200).join("\n"));

  bar.set({ model: "openai/gpt-4o", busy: true });
  assert.ok(!line().includes("tok/s"), "no speed before the first streamed token");
  assert.ok(!line().includes("首字"), "no TTFT before the first streamed token");
  assert.match(line(), /任务执行中/);

  bar.set({ model: "openai/gpt-4o", busy: true, ttftMs: 800, avgOutputSpeed: 50 });
  assert.match(line(), /首字 0\.8s/);
  assert.match(line(), /速度 50\.0 tok\/s/);

  bar.set({ model: "openai/gpt-4o", busy: false, ttftMs: 800, avgOutputSpeed: 62.5 });
  assert.match(line(), /首字 0\.8s/, "final TTFT stays visible after the task ends");
  assert.match(line(), /速度 62\.5 tok\/s/, "final task average stays visible after the task ends");

  // 下一任务首字符到达前，agent 继续推送上一任务的定格指标 → 原样展示。
  bar.set({ model: "openai/gpt-4o", busy: true, ttftMs: 800, avgOutputSpeed: 62.5 });
  assert.match(line(), /首字 0\.8s/, "carry-over TTFT stays until the new task's first token");
  assert.match(line(), /速度 62\.5 tok\/s/, "carry-over average stays until the new task's first token");

  // 新任务首字符一到即刷新为本任务的值。
  bar.set({ model: "openai/gpt-4o", busy: true, ttftMs: 420, avgOutputSpeed: 48 });
  assert.match(line(), /首字 0\.4s/);
  assert.match(line(), /速度 48\.0 tok\/s/);
});

test("editor Home/End jump to line start/end through the global key routing", () => {
  const { repl, ui } = makeRepl();
  const editor = editorOf(repl) as unknown as { handleInput(data: string): void; getCursor(): { line: number; col: number } };
  editor.handleInput("你好世界 second");
  assert.equal(editor.getCursor().col, 11, "cursor starts at the end of the input");

  // 从监听器转发时 TUI 不会自动重绘，必须显式请求一帧（否则位置变了显示不刷）。
  let renders = 0;
  (ui as unknown as { requestRender: () => void }).requestRender = () => {
    renders += 1;
  };

  // 关键路径：Home/End 必须穿过全局监听（不再被 alt-screen 视口滚动抢先消费）。
  for (const home of ["\x1b[H", "\x1b[1~", "\x1bOH"]) {
    const before = renders;
    assert.equal(press(ui, home), true, `Home via ${JSON.stringify(home)} is consumed`);
    assert.equal(editor.getCursor().col, 0, `Home via ${JSON.stringify(home)} jumps to column 0`);
    assert.ok(renders > before, `Home via ${JSON.stringify(home)} requests a repaint`);
  }
  for (const end of ["\x1b[F", "\x1b[4~", "\x1bOF"]) {
    const before = renders;
    assert.equal(press(ui, end), true, `End via ${JSON.stringify(end)} is consumed`);
    assert.equal(editor.getCursor().col, 11, `End via ${JSON.stringify(end)} jumps back to the end`);
    assert.ok(renders > before, `End via ${JSON.stringify(end)} requests a repaint`);
  }
});

test("stop({ preserveScreen: true }) leaves the alt screen without dumping content", () => {
  const writes: string[] = [];
  const terminal = {
    write: (chunk: string) => writes.push(chunk),
    columns: 80,
    rows: 24,
    start: () => undefined,
    showCursor: () => undefined,
    hideCursor: () => undefined,
    stop: () => undefined
  };
  const ui = new TuiAltScreen(terminal as never, true, undefined);
  ui.start();
  writes.length = 0;
  ui.stop({ preserveScreen: true });
  const out = writes.join("");
  assert.ok(out.includes("\x1b[?1049l"), "leaves the alternate screen buffer");
  assert.ok(out.includes("\x1b[?25h"), "shows the cursor again");
  assert.ok(!out.includes("\r\n\r\n"), "no document dump is written to the main screen");
});

test("double Esc while busy aborts; single Esc only hints, and the window expires", async () => {
  const ui = makeFakeUi();
  const busy = { value: true };
  const aborted: number[] = [];
  const repl = new TuiRepl({
    ui: ui as never,
    onSubmit: async () => undefined,
    onExit: () => undefined,
    isBusy: () => busy.value,
    onAbort: () => {
      aborted.push(1);
    },
    doubleEscWindowMs: 50
  });
  repl.registerAgent("supervisor");
  const toastText = (): string => {
    const entry = ui.overlays.find((overlay) => overlay.component instanceof ToastStack);
    return entry ? stripTerminalSequences((entry.component as ToastStack).render(120).join("\n")) : "";
  };

  assert.equal(press(ui, "\x1b"), true, "first Esc is consumed while busy");
  assert.match(toastText(), /再按一次 Esc 停止输出/, "first Esc shows the hint toast");
  assert.equal(aborted.length, 0, "no abort on the first press");

  press(ui, "\x1b");
  assert.equal(aborted.length, 1, "second Esc inside the window aborts");
  assert.match(toastText(), /已请求停止输出/, "abort is confirmed with a toast");

  // 窗口外：重新武装，不触发中止。
  press(ui, "\x1b");
  await new Promise((resolve) => setTimeout(resolve, 60));
  press(ui, "\x1b");
  assert.equal(aborted.length, 1, "presses outside the window never abort");

  // 非 busy 时 Esc 不被接管（落到编辑器）。
  busy.value = false;
  assert.equal(press(ui, "\x1b"), false, "Esc falls through to the editor when idle");
});

test("beginStatus shows a spinner line in the transcript that settles into ✔/✘", () => {
  const { repl, log } = makeRepl();
  const id = repl.beginStatus("压缩上下文");
  assert.equal(log.children.length, 1, "status line lands in the transcript");
  const line = log.children[0] as StatusLine;
  const running = stripTerminalSequences(line.render(80).join("\n"));
  assert.match(running, /压缩上下文/);
  assert.match(running, /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/, "a spinner frame renders while running");

  repl.endStatus(id, false);
  assert.match(stripTerminalSequences(line.render(80).join("\n")), /✔/, "success flips to ✔ in place");

  const second = repl.beginStatus("第二次压缩");
  repl.endStatus(second, true);
  assert.match(stripTerminalSequences((log.children[1] as StatusLine).render(80).join("\n")), /✘/, "failure flips to ✘");

  repl.endStatus(id, false); // 重复收尾无副作用
  line.stop();
});

test("stopStatuses clears animations when the REPL stops", () => {
  const { repl } = makeRepl();
  repl.beginStatus("压缩上下文");
  const chat = (repl as unknown as { chat: { stopStatuses(): void; statusLines: Map<number, unknown> } }).chat;
  chat.stopStatuses();
  assert.equal(chat.statusLines.size, 0);
});

test("streamed text blocks keep their blank-line separator as a reload would", () => {
  const { repl, log } = makeRepl();
  repl.streamText("第一段。\n\n");
  repl.streamText("第二段开头");
  repl.endStream();
  const rendered = log.children.map((child) => stripTerminalSequences(child.render(80).join("\n")));
  assert.equal(rendered.length, 3, "block, spacer, block");
  assert.match(rendered[0], /第一段/);
  assert.equal(rendered[1].trim(), "", "a blank line separates the two streamed blocks");
  assert.match(rendered[2], /第二段/);

  // 下一条消息从干净状态开始：块间分隔不泄漏到消息边界之外。
  repl.streamText("新消息首段");
  repl.endStream();
  assert.equal(log.children.length, 4, "no stray spacer before the next message");
  assert.match(stripTerminalSequences(log.children[3].render(80).join("\n")), /新消息首段/);
});

test("the streaming tail is separated from committed blocks by a blank line", () => {
  const { repl, log, stream } = makeRepl();
  repl.streamText("第一段。\n\n");
  assert.equal(log.children.length, 1, "first block committed on its blank line");

  repl.streamText("第二段正在输出");
  const tail = stream.children.map((child) => stripTerminalSequences(child.render(80).join("\n")));
  assert.equal(tail.length, 2, "seam spacer + live tail");
  assert.equal(tail[0].trim(), "", "the log/stream seam carries the blank line while streaming");
  assert.match(tail[1], /第二段正在输出/);

  // 提交后空行落在 log 里，stream 区清空。
  repl.endStream();
  assert.equal(log.children.length, 3);
  assert.equal(stream.children.length, 0);
});

test("live streaming renders line-identical to history replay for the same message", () => {
  // 用户报告的场景：标题（黄色行）与后续段落之间，实时缺空行、回放有。
  const whole = [
    "## 思考 token 算不算输出速度？",
    "**算（口径上）**。速度的数据源是 usage.output。",
    "## 但发现了一个真 bug",
    "`tokens.output` 来自 getSessionStats 的累计统计。"
  ].join("\n\n");

  // 实时：按流式 chunk 逐段喂入（每段带尾随空行，最后一段不带）。
  const { repl, log } = makeRepl();
  const blocks = whole.split("\n\n");
  for (let i = 0; i < blocks.length; i++) {
    repl.streamText(i < blocks.length - 1 ? `${blocks[i]}\n\n` : blocks[i]);
  }
  repl.endStream();
  const live = log.children.flatMap((child) => stripTerminalSequences(child.render(80).join("\n")).split("\n"));

  // 回放：同一条消息一次性 append（历史回放的路径）。
  const replayed = makeRepl();
  replayed.repl.appendMarkdown(whole);
  const replay = replayed.log.children.flatMap((child) => stripTerminalSequences(child.render(80).join("\n")).split("\n"));

  // 行尾空白规范化：Markdown 的段落间空行是「整行空格」而流式分隔是真空行，
  // 视觉等价；除此之外两路必须逐行一致。
  const normalize = (lines: string[]) => lines.map((line) => line.replace(/\s+$/g, ""));
  assert.deepEqual(normalize(live), normalize(replay), "live and replay must render the exact same lines");
});

test("char-by-char streaming (real delta granularity) still inserts block spacers", () => {
  const { repl, log, stream } = makeRepl();
  repl.streamThinking("先想一下");
  const message = "## 标题一\n\n第一段。\n\n## 标题二\n\n第二段。";
  for (const ch of message) repl.streamText(ch);
  repl.endStream();

  const lines = log.children.flatMap((child) => stripTerminalSequences(child.render(80).join("\n")).split("\n"));
  const normalized = lines.map((line) => line.replace(/\s+$/g, ""));
  assert.deepEqual(normalized, [
    "▸ 思考（4 字）",
    "标题一",
    "",
    "第一段。",
    "",
    "标题二",
    "",
    "第二段。"
  ]);
});

test("end-to-end: the real alt-screen paints blank lines between streamed blocks", async () => {
  const writes: string[] = [];
  const terminal = {
    write: (chunk: string) => writes.push(chunk),
    columns: 80,
    rows: 24,
    start: () => undefined,
    stop: () => undefined,
    showCursor: () => undefined,
    hideCursor: () => undefined
  };
  const ui = new TuiAltScreen(terminal as never, true, undefined);
  const { TuiRepl } = await import("../src/cli/tui-repl.ts");
  const repl = new TuiRepl({ ui, onSubmit: async () => undefined, onExit: () => undefined });
  ui.start();
  await new Promise((r) => setTimeout(r, 50)); // 首帧 fullRedraw
  writes.length = 0;

  repl.streamThinking("先想一下");
  const message = "## 标题一\n\n第一段。\n\n## 标题二\n\n第二段。";
  for (const ch of message) repl.streamText(ch);
  repl.endStream();
  await new Promise((r) => setTimeout(r, 120)); // 等差分帧落地
  ui.stop();

  // 从写入序列重建屏幕：每行变更都是 ESC[{row};1H ESC[2K {text}。
  const all = writes.join("");
  const screen: string[] = new Array(24).fill("");
  const tokens = [...all.matchAll(/\x1b\[(\d+);1H\x1b\[2K/g)];
  for (let i = 0; i < tokens.length; i++) {
    const row = Number(tokens[i][1]) - 1;
    const start = tokens[i].index! + tokens[i][0].length;
    const end = i + 1 < tokens.length ? tokens[i + 1].index! : all.length;
    const text = stripTerminalSequences(all.slice(start, end));
    screen[row] = text.replace(/\s+$/g, "");
  }

  const headingRow = screen.findIndex((line) => line.includes("标题一"));
  assert.ok(headingRow >= 0, `标题一 is on screen; got: ${JSON.stringify(screen)}`);
  // 该行左侧是侧边栏内容，但聊天区必须是空白（不能粘贴下一段）。
  assert.ok(
    !(screen[headingRow + 1] ?? "").includes("第一段。"),
    "no paragraph glued directly below the heading"
  );
  assert.ok((screen[headingRow + 2] ?? "").includes("第一段。"), "the next block starts two rows below");
});

/** A log line arriving mid-stream commits the pending tail before itself. */
test("appendLine between stream chunks keeps arrival order", () => {
  const { repl, log } = makeRepl();
  repl.streamText("先输出的文字");
  repl.appendLine("[主 agent] 工具调用中");
  repl.streamText("后输出的文字");
  repl.endStream();

  assert.equal(log.children.length, 3);
  assert.ok(log.children[0] instanceof Markdown, "pending tail committed before the log line");
  assert.ok((log.children[0] as Markdown).render(80).join("\n").includes("先输出的文字"));
  assert.ok(log.children[1] instanceof Text);
  assert.ok(log.children[1].render(80).join("\n").includes("工具调用中"));
  assert.ok(log.children[2] instanceof Markdown);
  assert.ok((log.children[2] as Markdown).render(80).join("\n").includes("后输出的文字"));
});

test("tool calls render as running lines and flip to results in place", () => {
  const { repl, log } = makeRepl();
  repl.toolStart("supervisor", "t1", "bash", { command: "npm test" });
  assert.equal(log.children.length, 1);
  const running = stripTerminalSequences(log.children[0].render(80).join("\n"));
  assert.ok(running.includes("⏳") && running.includes("bash") && running.includes("npm test"));

  repl.toolEnd("supervisor", "t1", false);
  const done = stripTerminalSequences(log.children[0].render(80).join("\n"));
  assert.ok(done.includes("✔") && done.includes("bash"), "success flips the same line to ✔");
  assert.ok(!done.includes("⏳"), "spinner replaced by the result mark");
});

test("failed tool calls flip to ✘", () => {
  const { repl, log } = makeRepl();
  repl.toolStart("supervisor", "t2", "read", { path: "missing.ts" });
  repl.toolEnd("supervisor", "t2", true);
  const line = stripTerminalSequences(log.children[0].render(80).join("\n"));
  assert.ok(line.includes("✘") && line.includes("missing.ts"));
});

test("toolStart commits the pending stream tail first, keeping arrival order", () => {
  const { repl, log } = makeRepl();
  repl.streamText("调用工具前的说明");
  repl.toolStart("supervisor", "t3", "edit", { path: "src/a.ts" });
  repl.toolEnd("supervisor", "t3", false);
  repl.endStream();

  assert.equal(log.children.length, 2, "text tail then the tool line");
  assert.ok(log.children[0] instanceof Markdown, "pending text committed before the tool line");
  assert.ok((log.children[0] as Markdown).render(80).join("\n").includes("调用工具前的说明"));
  assert.ok(log.children[1].render(80).join("\n").includes("src/a.ts"));
});

test("flushed stream tail leaves the stream area: no duplicated content around tool rows", () => {
  // Regression: flushStream() committed the live tail into the log but left the
  // raw streaming copy in the stream area, so the text/thinking showed twice
  // (once above the tool row, once below) until the next stream event rebuilt
  // the area.
  const { repl, log, stream } = makeRepl();

  repl.streamText("调用工具前的说明");
  assert.ok(stream.children.length > 0, "live tail visible while streaming");
  repl.toolStart("supervisor", "t5", "bash", { command: "npm test" });
  assert.equal(stream.children.length, 0, "text tail must leave the stream area when committed");
  repl.toolEnd("supervisor", "t5", false);
  repl.streamText("工具后的新内容");
  assert.ok(stream.children.length > 0, "new live tail shows again for fresh text");

  const text = log.children.map((child) => stripTerminalSequences(child.render(80).join("\n"))).join("\n");
  const occurrences = text.split("调用工具前的说明").length - 1;
  assert.equal(occurrences, 1, "committed content appears exactly once, not duplicated");
});

test("flushed thinking tail leaves the stream area when a tool row arrives", () => {
  const { repl, log, stream } = makeRepl();
  repl.streamThinking("先分析一下失败原因，可能和配置有关");
  repl.toolStart("supervisor", "t6", "read", { path: "package.json" });

  assert.equal(stream.children.length, 0, "thinking tail must leave the stream area when folded");
  assert.equal(log.children.length, 2, "folded reasoning then the tool row");
  assert.ok(!(log.children[0] instanceof Markdown), "thinking folds as collapsible reasoning");
  const text = log.children.map((child) => stripTerminalSequences(child.render(80).join("\n"))).join("\n");
  const rawText = log.children.map((child) => child.render(80).join("\n")).join("\n");
  const occurrences = rawText.split("思考（").length - 1;
  assert.equal(occurrences, 1, "folded reasoning appears exactly once (collapsed summary)");
  assert.ok(!text.includes("先分析一下失败原因"), "raw thinking is folded away, not left as a stale tail");
});

test("endStream finalizes tool lines still marked running as interrupted", () => {
  const { repl, log } = makeRepl();
  repl.toolStart("supervisor", "t4", "bash", { command: "sleep 100" });
  repl.endStream();
  const line = stripTerminalSequences(log.children[0].render(80).join("\n"));
  assert.ok(line.includes("✘"), "aborted call is not left spinning");
});

test("summarizeToolArgs prefers known keys and flattens to one line", () => {
  assert.equal(summarizeToolArgs({ command: "npm\n  test" }), "npm test");
  assert.equal(summarizeToolArgs({ path: "src/a.ts", other: "x" }), "src/a.ts");
  assert.equal(summarizeToolArgs({ unknown: "值", more: true }), "值");
  assert.equal(summarizeToolArgs({ nested: { a: 1 } }), "");
  assert.equal(summarizeToolArgs(undefined), "");
  const long = summarizeToolArgs({ command: "x".repeat(100) });
  assert.ok(long.length <= 80 && long.endsWith("…"));
});

test("appendLine adds a plain text row", () => {
  const { repl, log } = makeRepl();
  repl.appendLine("[主 agent] 已恢复配置");
  assert.equal(log.children.length, 1);
  assert.ok(log.children[0] instanceof Text);
  assert.ok(log.children[0].render(80).join("\n").includes("已恢复配置"));
});

test("askQuestion collects one answer line and hands the prompt back", async () => {
  const { repl, log } = makeRepl();
  const answer = repl.askQuestion("[主 agent] 用哪个数据库？");
  const editor = editorOf(repl);
  editor.handleInput("postgres");
  editor.handleInput("\r");
  assert.equal(await answer, "postgres");
  assert.ok(log.children.length > 0);
  const raw = log.children[log.children.length - 1].render(80).join("\n");
  assert.ok(raw.includes("\x1b[48;5;61m") && raw.includes("postgres"), "answers echo as user bubbles too");
});

test("busy mode keeps the editor mounted; Enter is swallowed until the task ends", async () => {
  const ui = makeFakeUi();
  const submitted: string[] = [];
  let editor: { handleInput(data: string): void; disableSubmit: boolean };
  let busyState: { editorMounted: boolean; busyTextShown: boolean; disableSubmit: boolean } | undefined;
  const repl = new TuiRepl({
    ui: ui as never,
    onSubmit: async (line) => {
      submitted.push(line);
      const root = ui.layoutRoot! as Container;
      const [, chatColumn] = root.children as [Container, Container];
      const [chat] = chatColumn.children as [Container];
      const inputArea = chat.children[chat.children.length - 1] as Container;
      busyState = {
        editorMounted: inputArea.children.includes(editor as never),
        busyTextShown: stripTerminalSequences(inputArea.render(80).join("\n")).includes("任务执行中"),
        disableSubmit: editor.disableSubmit
      };
      editor.handleInput("\r");
    },
    onExit: () => undefined
  });
  editor = editorOf(repl);

  editor.handleInput("第一件事");
  editor.handleInput("\r");
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(submitted, ["第一件事"], "Enter while busy does not submit again");
  assert.ok(busyState);
  assert.ok(busyState.editorMounted, "editor stays mounted while busy");
  assert.ok(!busyState.busyTextShown, "no 'task running' placeholder replaces the editor");
  assert.ok(busyState.disableSubmit, "submit is disabled while busy");
  assert.ok(!editor.disableSubmit, "submit is re-enabled once the task ends");
});

test("submitted user messages render as right-aligned bubbles with a background", async () => {
  const ui = makeFakeUi();
  let release!: () => void;
  const task = new Promise<void>((settle) => {
    release = settle;
  });
  const repl = new TuiRepl({
    ui: ui as never,
    onSubmit: async () => {
      release();
    },
    onExit: () => undefined
  });
  const editor = editorOf(repl);
  const [log] = mountedChat(ui).children as [Container];

  editor.handleInput("帮我看一下这个报错");
  editor.handleInput("\r");
  await task;

  assert.equal(log.children.length, 1, "the message is echoed into the transcript");
  const raw = log.children[0].render(80).join("\n");
  assert.ok(raw.includes("\x1b[48;5;61m"), "bubble uses a colored background");
  const plain = stripTerminalSequences(raw);
  assert.ok(plain.startsWith(" "), "bubble is right-aligned, not left-anchored");
  assert.ok(plain.trimEnd().endsWith("帮我看一下这个报错"), "bubble keeps one padding column at the right edge");
});

test("picker marks and preselects the current entry, hints render as descriptions", () => {
  let settled: string | undefined;
  const picker = new PickerComponent("选择 provider", [
    { option: { value: "anthropic", label: "anthropic", hint: "Anthropic" }, searchable: "anthropic" },
    { option: { value: "openai", label: "openai", hint: "OpenAI", current: true }, searchable: "openai" }
  ], (value) => {
    settled = value;
  });
  const raw = picker.render(100).join("\n");
  const text = stripTerminalSequences(raw);
  assert.match(text, /╭─ 选择 provider/, "panel has a titled top border");
  assert.match(text, /╰/, "panel has a bottom border");
  assert.ok(raw.includes("\x1b[48;5;234m"), "panel has a solid background, distinct from chat content");
  assert.match(text, /● openai/, "current entry carries the ● marker");
  assert.match(text, /Anthropic/, "hints render as descriptions (was silently dropped before)");
  assert.ok(!text.includes("当前"), "no redundant 当前 suffix next to the ● marker");

  const selectedRow = raw.split("\n").find((line) => line.includes("→"));
  assert.ok(selectedRow?.includes("openai"), "the current entry is pre-selected (→ highlight)");

  // 边框四边等宽：顶/底/内容行可见宽度完全一致。
  const widths = new Set(raw.split("\n").map((line) => visibleWidth(line)));
  assert.equal(widths.size, 1, `all panel rows share one width, got ${[...widths]}`);

  // 所有选项的文字起点一致（● 标记列固定两格，垂直对齐）。
  const rows = text.split("\n");
  const labelCol = (needle: string): number => rows.find((row) => row.includes(needle))!.indexOf(needle);
  assert.equal(labelCol("openai"), labelCol("anthropic"), "choices align vertically");

  picker.handleInput("\r");
  assert.equal(settled, "openai", "Enter picks the pre-selected current entry");
});

test("pick selects via Enter, filters by typing, and cancels with Esc", async () => {
  const { repl, overlays } = makeRepl();
  // overlays[0] is the persistent agent tab bar; the picker is the latest overlay.
  const picker = () => overlays[overlays.length - 1];

  const first = repl.pick("选择模型", [
    { value: "gpt", label: "gpt-4o", hint: "GPT" },
    { value: "claude", label: "claude-sonnet", hint: "Claude" }
  ]);
  assert.equal(overlays.length, 2, "tab bar stays mounted while the picker opens");
  picker().component.handleInput?.("\r");
  assert.equal(await first, "gpt");
  assert.equal(overlays.length, 1, "overlay closes after selection");

  const second = repl.pick("选择模型", [
    { value: "gpt", label: "gpt-4o", hint: "GPT" },
    { value: "claude", label: "claude-sonnet", hint: "Claude" }
  ]);
  picker().component.handleInput?.("claude");
  picker().component.handleInput?.("\r");
  assert.equal(await second, "claude", "typed filter narrows the selection");

  const third = repl.pick("选择模型", [{ value: "x", label: "x" }]);
  picker().component.handleInput?.("\x1b");
  assert.equal(await third, undefined);
  assert.equal(overlays.length, 1, "overlay closes on cancel");
});

test("agent tabs register, mark background activity unread, and cycle via Alt+↓", () => {
  const { repl, ui, log, overlays } = makeRepl();
  repl.registerAgent("code-writer");
  const bar = overlays[0].component;
  const plain = () => stripTerminalSequences(bar.render(80)[0]);
  assert.ok(plain().includes("supervisor"));
  assert.ok(plain().includes("code-writer"));
  assert.ok(!plain().includes("●"), "no unread markers initially");
  assert.ok(plain().startsWith(" "), "tab row is right-aligned");
  const raw = bar.render(80)[0];
  assert.ok(raw.includes("\x1b[7msupervisor\x1b[27m"), "active tab is highlighted");
  assert.ok(!raw.includes("\x1b]8;"), "tabs are plain text, not hyperlinks");

  repl.appendLine("后台输出", "code-writer");
  assert.ok(plain().includes("● code-writer"), "background output marks the tab unread");
  assert.equal(log.children.length, 0, "background output stays out of the active log");

  const mountedBefore = mountedChat(ui);
  assert.ok(press(ui, "\x1bn"), "Alt+↓ cycles agent tabs");
  assert.notEqual(mountedChat(ui), mountedBefore, "cycling replaces the mounted transcript");
  assert.ok(!plain().includes("● code-writer"), "activation clears the unread marker");
  const [activeLog] = mountedChat(ui).children as [Container];
  assert.equal(activeLog.children.length, 1);
  assert.ok(activeLog.children[0].render(80).join("\n").includes("后台输出"));

  assert.ok(press(ui, "\x1bp"), "Alt+↑ cycles back");
  assert.equal(mountedChat(ui), mountedBefore, "cycling wraps around to the supervisor");
});

test("streaming to a background agent stays silent and lands in its transcript", () => {
  const { repl, ui, log, stream } = makeRepl();
  repl.registerAgent("code-writer");

  repl.streamThinking("后台思考", "code-writer");
  assert.equal(stream.children.length, 0, "background thinking is silent");
  repl.streamText("后台答案\n\n第二段", "code-writer");
  repl.endStream("code-writer");
  assert.equal(log.children.length, 0, "supervisor log untouched");
  assert.equal(stream.children.length, 0, "active stream area untouched");

  press(ui, "\x1bn"); // Alt+↓ → code-writer
  const [bgLog] = mountedChat(ui).children as [Container];
  assert.equal(bgLog.children.length, 4, "reasoning + markdown + blank separator + markdown");
  assert.ok(!(bgLog.children[0] instanceof Markdown), "thinking folds as collapsible reasoning");
  assert.ok(bgLog.children[1] instanceof Markdown);
  assert.equal(
    (bgLog.children[2] as Text).render(80).join("\n").trim(),
    "",
    "the split blocks keep their blank-line separator"
  );
});

test("collapsible reasoning expands and collapses via the transcript-mode f key", () => {
  const { repl, ui, log } = makeRepl();
  repl.streamThinking("第一行推理\n第二行推理");
  repl.streamText("答案");
  const reasoning = log.children[0] as unknown as { render(width: number): string[] };

  const collapsed = reasoning.render(80);
  assert.equal(collapsed.length, 1, "collapsed to a single summary line");
  assert.ok(stripTerminalSequences(collapsed[0]).includes("思考（11 字）"));

  press(ui, "\x1bt"); // Alt+T → transcript browse mode
  press(ui, "f");
  const expanded = reasoning.render(80).join("\n");
  assert.ok(stripTerminalSequences(expanded).includes("第一行推理"));
  assert.ok(stripTerminalSequences(expanded).includes("第二行推理"));

  press(ui, "f");
  assert.equal(reasoning.render(80).length, 1, "second press collapses again");
});

/** Minimal SessionSummary for sessions-bar tests. */
function makeSummary(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
  return {
    name: overrides.id,
    status: "active",
    current: false,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
    messageCount: 0,
    ...overrides
  };
}

/**
 * The sessions sidebar parts: first child of the layout HStack (left of the
 * chat column), a VStack of [top border, scrolling rows, bottom border].
 */
function sidebarParts(ui: ReturnType<typeof makeFakeUi>) {
  const root = ui.layoutRoot! as Container;
  const column = root.children[0] as unknown as Container;
  const [topBorder, scroll, bottomBorder] = column.children as [
    { render(width: number): string[] },
    Component,
    { render(width: number): string[] }
  ];
  const rows = (scroll as unknown as { child: { render(width: number): string[] } }).child;
  return { column, topBorder, scroll, bottomBorder, rows };
}

test("sessions sidebar is a full-height bordered column with scrollable rows", () => {
  const { repl, ui, overlays } = makeRepl();
  const { column, topBorder, scroll, bottomBorder, rows } = sidebarParts(ui);

  // The sidebar is a layout column, not an overlay: only the agent tab bar remains.
  assert.equal(overlays.length, 1);
  assert.equal(column.children.length, 3, "top border + scrolling rows + bottom border");
  assert.ok(stripTerminalSequences(topBorder.render(22)[0]).startsWith("╭"), "top border hugs the left edge");
  const strippedTop = stripTerminalSequences(topBorder.render(22)[0]);
  assert.ok(strippedTop.includes("─ 会话"), "the title rides the top border");
  assert.ok(strippedTop.includes("＋ 新建 (n)"), "the ＋ 新建 hint rides the title edge with its key");
  assert.ok(stripTerminalSequences(bottomBorder.render(22)[0]).startsWith("╰"), "bottom border closes the box");

  // Full-height wiring: the scroll viewport grows to absorb the spare height.
  const entries = (column as unknown as { entries: { grow: number }[] }).entries;
  assert.equal(entries[1].grow, 1, "the rows viewport stretches to the terminal height");

  // Overflow is the ScrollView's job, not truncation: every session stays a row.
  const sessions = Array.from({ length: 30 }, (_, index) => makeSummary({ id: `s${index}`, name: `会话${index}号` }));
  repl.setSessions(sessions);
  assert.equal(rows.render(22).length, 30, "one row per session, nothing dropped (＋ 新建 lives on the border)");
  assert.equal((scroll as unknown as { scrollbar: string }).scrollbar, "auto", "the sidebar thumb stays hidden at rest (no gray stripe by the gap)");
  assert.equal((scroll as unknown as { primary: boolean }).primary, false, "the transcript stays the primary scroller");
  assert.equal((scroll as unknown as { overscroll: string }).overscroll, "contain", "sidebar wheel does not chain into the chat");

  // The transcript scrolls with a visible scrollbar too, and a one-column gap
  // keeps the sidebar's scrollbar from touching the chat content.
  const root = ui.layoutRoot! as Container;
  const [, chatColumn] = root.children as [Container, Container];
  const [chat] = chatColumn.children as [Container];
  const [chatScroll] = chat.children as [Container];
  assert.equal((chatScroll as unknown as { scrollbar: string }).scrollbar, "auto", "the transcript scrollbar is transient (auto-visible)");
  assert.equal((root as unknown as { gap: number }).gap, 1, "one blank column between sidebar and chat");
});

test("sessions sidebar rows list current/closed/empty states and stay inside the column", () => {
  const { repl, ui } = makeRepl();
  const { topBorder, rows } = sidebarParts(ui);
  const plain = (width = 22) => stripTerminalSequences(rows.render(width).join("\n"));

  // Lazy creation: nothing exists yet — the ＋ 新建 hint and the empty-state hint.
  assert.ok(stripTerminalSequences(topBorder.render(22)[0]).includes("＋ 新建 (n)"), "＋ 新建 is always offered");
  assert.ok(plain().includes("暂无会话"), "empty state hints at lazy auto-create");

  repl.setSessions([
    makeSummary({ id: "s1", name: "会话甲", current: true }),
    makeSummary({ id: "s2", name: "会话乙" }),
    makeSummary({ id: "s3", name: "会话丙", status: "closed" })
  ]);
  const rendered = rows.render(22);
  const raw = rendered.join("\n");
  assert.ok(!raw.includes("\x1b]8;"), "rows are plain text, not hyperlinks");
  assert.ok(raw.includes("\x1b[7m● 会话甲\x1b[27m"), "current session is highlighted with a ● marker");
  assert.ok(plain().includes("✕ 会话丙"), "closed sessions show a ✕ marker");
  assert.ok(plain().includes("  会话乙"), "other sessions keep marker alignment");

  // Long names never spill past the column (rows render inside a scrollbar
  // viewport one column narrower than the bordered sidebar).
  repl.setSessions([makeSummary({ id: "wide", name: "很长的会话名称占位符很多字" })]);
  for (const line of rows.render(22)) {
    assert.ok(visibleWidth(line) <= 22, "every row fits the sidebar width");
  }
  assert.ok(!plain(22).includes("很长的会话名称占位符很多字"), "long names are ellipsized before rendering");
});

test("setDraftMode pins a highlighted ✎ 草稿 row at the top of the sidebar", () => {
  const { repl, ui } = makeRepl();
  const { rows } = sidebarParts(ui);
  const plain = (width = 22) => stripTerminalSequences(rows.render(width).join("\n"));

  assert.ok(!plain().includes("草稿"), "no draft row before setDraftMode");

  repl.setDraftMode(true);
  const rendered = rows.render(22);
  assert.ok(plain().includes("✎ 草稿（未保存）"), "the draft row is visible");
  assert.ok(rendered.join("\n").includes("\x1b[7m"), "the draft row uses the current-session highlight");

  // The hint stays hidden while a draft is open (the draft itself is the hint).
  repl.setSessions([]);
  assert.ok(!plain().includes("暂无会话"), "empty-state hint yields to the draft row");

  repl.setDraftMode(false);
  assert.ok(!plain().includes("草稿"), "leaving draft mode removes the row");
});

test("clearTranscript empties the active transcript (draft starts from a clean slate)", () => {
  const { repl, log, stream } = makeRepl();
  repl.appendLine("旧行一");
  repl.appendMarkdown("旧正文");
  repl.streamText("未完成的流");
  assert.ok(log.children.length > 0 || stream.children.length > 0);

  repl.clearTranscript();
  assert.equal(log.children.length, 0, "the log is emptied");
  assert.equal(stream.children.length, 0, "the live tail is emptied");

  // After clearing, new content still lands normally.
  repl.appendLine("新行");
  assert.equal(log.children.length, 1);
});

test("sidebar keyboard navigation: ↑↓ select, Enter opens, n starts a draft, Esc returns to the editor", () => {
  const ui = makeFakeUi();
  const clicked: string[] = [];
  const repl = new TuiRepl({
    ui: ui as never,
    onSubmit: async () => undefined,
    onExit: () => undefined,
    onSessionClick: (id) => {
      clicked.push(id);
    }
  });
  repl.setSessions([
    makeSummary({ id: "s1", name: "会话甲" }),
    makeSummary({ id: "s2", name: "会话乙" })
  ]);

  assert.ok(press(ui, "\x1bs"), "Alt+S focuses the sidebar");
  const { rows } = sidebarParts(ui);
  assert.ok(rows.render(22)[0].includes("\x1b[7m"), "the selected row is highlighted while focused");

  press(ui, "\x1b[B"); // ↓ → 会话乙
  press(ui, "\r"); // Enter opens it
  press(ui, "n"); // n starts a draft
  assert.deepEqual(clicked, ["s2", "draft"]);

  press(ui, "\x1b"); // Esc → editor
  const editor = editorOf(repl);
  assert.equal(ui.focusTargets[ui.focusTargets.length - 1], editor, "Esc restores editor focus");
  assert.ok(!rows.render(22).join("\n").includes("\x1b[7m● 会话甲"), "no selection highlight while unfocused");
});

test("sidebar selection wraps around and follows into the scroll viewport", () => {
  const { repl, ui } = makeRepl();
  repl.setSessions(Array.from({ length: 30 }, (_, index) => makeSummary({ id: `s${index}`, name: `会话${index}号` })));
  const { scroll, rows } = sidebarParts(ui);
  (scroll as unknown as {
    updateLayout(contentHeight: number, viewportHeight: number, requestRender: () => void): void;
  }).updateLayout(30, 10, () => undefined);
  press(ui, "\x1bs");
  press(ui, "\x1b[A"); // ↑ from row 0 wraps to the last row
  assert.equal((scroll as unknown as { scrollTop: number }).scrollTop, 20, "wrap scrolls so the selection stays visible");
  assert.ok(rows.render(22)[29].includes("\x1b[7m"), "the wrapped selection is highlighted");
});

test("Tab hops between sidebar and transcript; Esc returns to the editor", () => {
  const { repl, ui } = makeRepl();
  const editor = editorOf(repl);
  const lastFocus = () => ui.focusTargets[ui.focusTargets.length - 1];

  press(ui, "\x1bs"); // → sidebar
  assert.equal(lastFocus(), null, "sidebar mode releases component focus");
  const { bottomBorder } = sidebarParts(ui);
  assert.ok(stripTerminalSequences(bottomBorder.render(22)[0]).includes("Enter 打开"), "focused sidebar shows key hints");

  press(ui, "\t"); // → transcript
  press(ui, "\t"); // → back to sidebar
  assert.ok(stripTerminalSequences(bottomBorder.render(22)[0]).includes("Enter 打开"), "hints return with the sidebar");

  press(ui, "\x1b"); // → editor
  assert.equal(lastFocus(), editor, "Esc returns to the editor");
  assert.ok(!stripTerminalSequences(bottomBorder.render(22)[0]).includes("Enter 打开"), "hints hide when unfocused");
});

test("typing in panel modes falls straight back to the editor", () => {
  const { repl, ui } = makeRepl();
  const editor = editorOf(repl);

  press(ui, "\x1bs"); // sidebar
  assert.equal(press(ui, "你"), false, "printable input is not consumed");
  assert.equal(ui.focusTargets[ui.focusTargets.length - 1], editor, "focus returned to the editor");

  press(ui, "\x1bt"); // transcript
  assert.equal(press(ui, "x"), false);
  assert.equal(ui.focusTargets[ui.focusTargets.length - 1], editor);
});

test("kitty key-release events are consumed and never toggle global bindings", () => {
  const { repl, ui } = makeRepl();
  const lastFocus = () => ui.focusTargets[ui.focusTargets.length - 1];

  // iTerm2 启用 Option-as-Esc+ 后，⌥S 以 Kitty 协议上报按下+释放两个事件。
  assert.equal(press(ui, "\x1b[115;3:1u"), true, "alt+s press toggles to the sidebar");
  assert.equal(lastFocus(), null, "press lands in sidebar mode");
  assert.equal(press(ui, "\x1b[115;3:3u"), true, "release is consumed");
  assert.equal(lastFocus(), null, "release must not toggle back to the editor");

  // 释放事件也不得落到编辑器或面板路由（否则会误触回退/导航）。
  const transcriptRelease = "\x1b[102;3:3u"; // alt+f release
  assert.equal(press(ui, "\x1bt"), true); // → transcript
  assert.equal(press(ui, transcriptRelease), true, "random release is consumed");
});

test("transcript browse mode scrolls the chat line by line", () => {
  const { repl, ui } = makeRepl();
  for (let i = 0; i < 50; i++) repl.appendLine(`第${i}行`);
  const root = ui.layoutRoot! as Container;
  const [, chatColumn] = root.children as [Container, Container];
  const [chat] = chatColumn.children as [Container];
  const chatScroll = chat.children[0] as unknown as {
    scrollTop: number;
    scrollBy(lines: number): unknown;
    updateLayout(contentHeight: number, viewportHeight: number, requestRender: () => void): void;
  };
  chatScroll.updateLayout(200, 10, () => undefined);

  press(ui, "\x1bt"); // Alt+T → transcript browse
  press(ui, "\x1b[A"); // ↑
  assert.equal(chatScroll.scrollTop, 189, "follow-end starts at the bottom; ↑ scrolls one line");
  press(ui, "\x1b[B"); // ↓
  assert.equal(chatScroll.scrollTop, 190, "↓ scrolls back down");
});

test("d on a sidebar session opens a delete confirmation driven by the keyboard", () => {
  const ui = makeFakeUi();
  const deleted: string[] = [];
  const repl = new TuiRepl({
    ui: ui as never,
    onSubmit: async () => undefined,
    onExit: () => undefined,
    onDeleteSession: (id) => {
      deleted.push(id);
    }
  });
  repl.setSessions([
    makeSummary({ id: "s1", name: "会话甲" }),
    makeSummary({ id: "s2", name: "会话乙" })
  ]);
  // The constructor already shows the agent tab bar overlay; measure deltas.
  const baseline = ui.overlays.length;
  const menuAt = () => ui.overlays[ui.overlays.length - 1]!.component as unknown as {
    handleInput(data: string): void;
    render(width: number): string[];
  };

  press(ui, "\x1bs"); // focus sidebar; selection = 会话甲
  press(ui, "d");
  assert.equal(ui.overlays.length, baseline + 1, "the confirmation menu opens");
  assert.ok(stripTerminalSequences(menuAt().render(26).join("\n")).includes("删除会话"), "menu lists the delete action");

  menuAt().handleInput("\r"); // Enter on 删除
  assert.deepEqual(deleted, ["s1"], "Enter confirms the delete");
  assert.equal(ui.overlays.length, baseline, "the menu closes after the action");

  press(ui, "d"); // open again, arrow down to 取消
  menuAt().handleInput("\x1b[B");
  menuAt().handleInput("\r");
  assert.deepEqual(deleted, ["s1"], "取消 runs no action");

  press(ui, "d"); // Esc cancels outright
  menuAt().handleInput("\x1b");
  assert.equal(ui.overlays.length, baseline, "Esc closes the menu");
  assert.deepEqual(deleted, ["s1"]);
});

test("with a draft open the first sidebar row is the draft and the second is session one", () => {
  const ui = makeFakeUi();
  const activated: string[] = [];
  const deleted: string[] = [];
  const repl = new TuiRepl({
    ui: ui as never,
    onSubmit: async () => undefined,
    onExit: () => undefined,
    onSessionClick: (id) => {
      activated.push(id);
    },
    onDeleteSession: (id) => {
      deleted.push(id);
    }
  });
  repl.setSessions([makeSummary({ id: "s1", name: "会话甲" })]);
  repl.setDraftMode(true);
  const baseline = ui.overlays.length;

  press(ui, "\x1bs"); // selection = draft row
  press(ui, "d");
  assert.equal(ui.overlays.length, baseline, "the draft row is not deletable");

  press(ui, "\r"); // Enter on the draft row
  assert.deepEqual(activated, ["draft"]);

  press(ui, "\x1b[B"); // ↓ → session one shifted down by the draft row
  press(ui, "d");
  assert.equal(ui.overlays.length, baseline + 1);
  (ui.overlays[ui.overlays.length - 1]!.component as unknown as { handleInput(data: string): void }).handleInput("\r");
  assert.deepEqual(deleted, ["s1"]);
});

test("renders contain no OSC 8 hyperlinks anywhere (keyboard-only)", () => {
  const { repl, ui, log } = makeRepl();
  repl.setSessions([makeSummary({ id: "s1", name: "会话甲" })]);
  repl.setDraftMode(true);
  repl.appendThinking("推理内容");
  repl.registerAgent("code-writer");
  const parts = sidebarParts(ui);
  const surfaces = [
    ...parts.topBorder.render(22),
    ...parts.rows.render(22),
    ...parts.bottomBorder.render(22),
    ...ui.overlays[0].component.render(80),
    ...log.children[0].render(80)
  ];
  for (const line of surfaces) {
    assert.ok(!line.includes("\x1b]8;"), "no hyperlink escape sequences remain");
  }
});

test("transcriptText keeps logical plain text for whole-transcript copy", () => {
  const { repl, ui } = makeRepl();
  const chat = chatPanelOf(ui);
  repl.appendLine("[主 agent] 启动");
  repl.appendUserMessage("帮我跑测试");
  repl.streamThinking("先看失败原因");
  repl.streamText("结果如下：\n\n- A");
  repl.endStream();
  repl.toolStart("supervisor", "t1", "bash", { command: "npm test" });
  repl.toolEnd("supervisor", "t1", false);

  const text = chat.transcriptText();
  assert.ok(text.includes("[主 agent] 启动"), "log lines are kept verbatim");
  assert.ok(text.includes("帮我跑测试"), "user bubbles keep their text");
  assert.ok(text.includes("先看失败原因"), "flushed thinking keeps full content");
  assert.ok(text.includes("结果如下"), "markdown blocks keep their source");
  assert.ok(!text.includes("⏳"), "running tool line is rewritten to the settled mark");
  assert.ok(text.includes("✔ bash"), "settled tool line carries the ok mark");

  chat.clearTranscript();
  assert.equal(chat.transcriptText(), "", "clearTranscript also empties the plain log");
});

test("visibleText returns the current viewport slice with styles stripped", () => {
  const { repl, ui } = makeRepl();
  const chat = chatPanelOf(ui);
  for (let i = 0; i < 50; i++) repl.appendLine(i === 45 ? `\x1b[2m暗色第45行\x1b[0m` : `第${i}行`);
  const root = ui.layoutRoot! as Container;
  const [, chatColumn] = root.children as [Container, Container];
  const [chatNode] = chatColumn.children as [Container];
  const chatScroll = chatNode.children[0] as unknown as {
    updateLayout(contentHeight: number, viewportHeight: number, requestRender: () => void): void;
  };
  chatScroll.updateLayout(50, 10, () => undefined); // follow-end → scrollTop = 40

  const text = chat.visibleText();
  const lines = text.split("\n");
  assert.equal(lines.length, 10, "exactly the viewport height is copied");
  assert.ok(lines[0].includes("第40行"), "slice starts at the scroll position");
  assert.ok(text.includes("第49行"), "slice ends at the bottom");
  assert.ok(!text.includes("第39行"), "content above the viewport is excluded");
  assert.ok(text.includes("暗色第45行"), "ANSI styles are stripped but text remains");
  assert.ok(!text.includes("\x1b["), "no escape sequences leak into the clipboard payload");
});

test("y/a in transcript mode and ctrl+o in the editor run the clipboard copy path", async () => {
  const { repl, ui } = makeRepl();
  const editor = editorOf(repl) as unknown as { setText(text: string): void };
  const toastText = (): string => {
    const entry = ui.overlays.find((overlay) => overlay.component instanceof ToastStack);
    return entry ? stripTerminalSequences((entry.component as ToastStack).render(120).join("\n")) : "";
  };

  repl.appendLine("有一条内容");
  const root = ui.layoutRoot! as Container;
  const [, chatColumn] = root.children as [Container, Container];
  const [chatNode] = chatColumn.children as [Container];
  (chatNode.children[0] as unknown as {
    updateLayout(contentHeight: number, viewportHeight: number, requestRender: () => void): void;
  }).updateLayout(1, 10, () => undefined);
  assert.equal(press(ui, "\x1bt"), true); // Alt+T → transcript
  assert.equal(press(ui, "a"), true, "a is consumed by the copy binding");
  // 测试进程 stdout 非 TTY，writeClipboard 必然失败：走的是告警 toast 分支。
  assert.match(toastText(), /整个转录复制失败：终端不支持 OSC 52/, "a copies the whole transcript");

  assert.equal(press(ui, "y"), true, "y is consumed by the copy binding");
  assert.match(toastText(), /可见区域已复制：1 行|可见区域复制失败/, "y copies the visible slice");

  press(ui, "\x1b"); // → editor
  editor.setText("草稿第一行");
  assert.equal(press(ui, "\x0f"), true, "ctrl+o is consumed by the copy binding");
  assert.match(toastText(), /输入框内容复制失败|输入框内容已复制/, "ctrl+o copies the editor content");
});
