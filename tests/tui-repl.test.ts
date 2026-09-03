import assert from "node:assert/strict";
import { test } from "node:test";
import type { Component } from "@earendil-works/pi-tui";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import { splitMarkdownBlocks, TuiRepl } from "../src/cli/tui-repl.ts";

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

function makeRepl(): { repl: TuiRepl; log: Container; stream: Container; overlays: FakeOverlay[] } {
  const ui = makeFakeUi();
  const repl = new TuiRepl({ ui: ui as never, onSubmit: async () => undefined, onExit: () => undefined });
  const [log, stream] = ui.children as [Container, Container];
  return { repl, log, stream, overlays: ui.overlays };
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

test("streamThinking shows dim output and folds into the log when text starts", () => {
  const { repl, log, stream } = makeRepl();
  repl.streamThinking("让我想想…");
  assert.ok(stream.children.length > 0, "thinking is visible while streaming");

  repl.streamText("答案");
  assert.equal(log.children.length, 1, "thinking folds into the log as plain text");
  assert.ok(log.children[0] instanceof Text);
  assert.ok(!(log.children[0] instanceof Markdown));
});

test("endStream flushes the remaining partial block as markdown", () => {
  const { repl, log, stream } = makeRepl();
  repl.streamText("尾段内容");
  repl.endStream();
  assert.equal(log.children.length, 1);
  assert.ok(log.children[0] instanceof Markdown);
  assert.equal(stream.children.length, 0, "tail clears after the stream ends");
});

test("appendLine adds a plain text row", () => {
  const { repl, log } = makeRepl();
  repl.appendLine("[主 agent] 已恢复配置");
  assert.equal(log.children.length, 1);
  assert.ok(log.children[0] instanceof Text);
  assert.ok(log.children[0].render(80).join("\n").includes("已恢复配置"));
});

test("pick selects via Enter, filters by typing, and cancels with Esc", async () => {
  const { repl, overlays } = makeRepl();

  const first = repl.pick("选择模型", [
    { value: "gpt", label: "gpt-4o", hint: "GPT" },
    { value: "claude", label: "claude-sonnet", hint: "Claude" }
  ]);
  assert.equal(overlays.length, 1);
  overlays[0].component.handleInput?.("\r");
  assert.equal(await first, "gpt");
  assert.equal(overlays.length, 0, "overlay closes after selection");

  const second = repl.pick("选择模型", [
    { value: "gpt", label: "gpt-4o", hint: "GPT" },
    { value: "claude", label: "claude-sonnet", hint: "Claude" }
  ]);
  overlays[0].component.handleInput?.("claude");
  overlays[0].component.handleInput?.("\r");
  assert.equal(await second, "claude", "typed filter narrows the selection");

  const third = repl.pick("选择模型", [{ value: "x", label: "x" }]);
  overlays[0].component.handleInput?.("\x1b");
  assert.equal(await third, undefined);
  assert.equal(overlays.length, 0, "overlay closes on cancel");
});
