import assert from "node:assert/strict";
import { test } from "node:test";
import type { Component } from "@earendil-works/pi-tui";
import { Container, Markdown, stripTerminalSequences, Text } from "@earendil-works/pi-tui";
import { splitMarkdownBlocks, summarizeToolArgs, TuiRepl } from "../src/cli/tui-repl.ts";

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
  handle: { hide(): void };
}

function makeFakeUi() {
  const children: Component[] = [];
  const overlays: FakeOverlay[] = [];
  const ui = {
    children,
    overlays,
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
    addInputListener: () => () => undefined,
    showOverlay: (component: Component) => {
      const entry: FakeOverlay = {
        component,
        handle: {
          hide: () => {
            const index = overlays.indexOf(entry);
            if (index >= 0) overlays.splice(index, 1);
          }
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

function makeRepl(): {
  repl: TuiRepl;
  ui: ReturnType<typeof makeFakeUi>;
  log: Container;
  stream: Container;
  overlays: FakeOverlay[];
} {
  const ui = makeFakeUi();
  const repl = new TuiRepl({ ui: ui as never, onSubmit: async () => undefined, onExit: () => undefined });
  // ui.children = [active transcript container, inputArea]; the transcript holds [log, stream].
  const [chat] = ui.children as [Container];
  const [log, stream] = chat.children as [Container, Container];
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
  assert.ok(stream.children[0] instanceof Text);
  assert.ok((stream.children[0] as Text).render(80).join("\n").includes("步骤一"));
});

test("streamThinking shows a live summary and folds into the log as collapsible reasoning", () => {
  const { repl, log, stream } = makeRepl();
  repl.streamThinking("让我想想…");
  assert.ok(stream.children.length > 0, "thinking summary is visible while streaming");
  assert.ok(stream.children[0].render(80).join("\n").includes("思考"));

  repl.streamText("答案");
  assert.equal(log.children.length, 1, "thinking folds into the log as a collapsible entry");
  assert.ok(!(log.children[0] instanceof Markdown));
  assert.ok(log.children[0].render(80).join("\n").includes("pi-swarm://think/1"));
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
  assert.ok(log.children[1].render(80).join("\n").includes("pi-swarm://think/1"));
  assert.ok(log.children[2] instanceof Markdown, "second text run is plain markdown");
  assert.ok((log.children[2] as Markdown).render(80).join("\n").includes("答案二"));
  assert.ok(!(log.children[3] instanceof Markdown), "second thinking run is collapsible");
  assert.ok(log.children[3].render(80).join("\n").includes("pi-swarm://think/2"));
  assert.equal(stream.children.length, 0, "tail clears after the stream ends");
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
  const editor = (repl as unknown as { editor: { handleInput(data: string): void } }).editor;
  editor.handleInput("postgres");
  editor.handleInput("\r");
  assert.equal(await answer, "postgres");
  assert.ok(log.children.length > 0);
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

test("agent tabs register, mark background activity unread, and switch via handleLink", () => {
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
  assert.ok(raw.includes("pi-swarm://agent/code-writer"), "tabs are OSC 8 links");

  repl.appendLine("后台输出", "code-writer");
  assert.ok(plain().includes("● code-writer"), "background output marks the tab unread");
  assert.equal(log.children.length, 0, "background output stays out of the active log");

  const mountedBefore = ui.children[0];
  repl.handleLink("pi-swarm://agent/code-writer");
  assert.notEqual(ui.children[0], mountedBefore, "switching replaces the mounted transcript");
  assert.ok(!plain().includes("● code-writer"), "activation clears the unread marker");
  const [chat] = ui.children as [Container];
  const [activeLog] = chat.children as [Container];
  assert.equal(activeLog.children.length, 1);
  assert.ok(activeLog.children[0].render(80).join("\n").includes("后台输出"));

  const mounted = ui.children[0];
  repl.handleLink("pi-swarm://agent/ghost");
  assert.equal(ui.children[0], mounted, "links for unknown agents are ignored");
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

  repl.handleLink("pi-swarm://agent/code-writer");
  const [chat] = ui.children as [Container];
  const [bgLog] = chat.children as [Container];
  assert.equal(bgLog.children.length, 3, "collapsible reasoning + two markdown blocks");
  assert.ok(!(bgLog.children[0] instanceof Markdown), "thinking folds as collapsible reasoning");
  assert.ok(bgLog.children[1] instanceof Markdown);
});

test("collapsible reasoning expands and collapses via pi-swarm://think links", () => {
  const { repl, log } = makeRepl();
  repl.streamThinking("第一行推理\n第二行推理");
  repl.streamText("答案");
  const reasoning = log.children[0] as unknown as { render(width: number): string[] };

  const collapsed = reasoning.render(80);
  assert.equal(collapsed.length, 1, "collapsed to a single summary line");
  assert.ok(collapsed[0].includes("pi-swarm://think/1"));
  assert.ok(stripTerminalSequences(collapsed[0]).includes("思考（11 字）· 点击展开"));

  repl.handleLink("pi-swarm://think/1");
  const expanded = reasoning.render(80).join("\n");
  assert.ok(stripTerminalSequences(expanded).includes("第一行推理"));
  assert.ok(stripTerminalSequences(expanded).includes("第二行推理"));

  repl.handleLink("pi-swarm://think/1");
  assert.equal(reasoning.render(80).length, 1, "second click collapses again");
});
