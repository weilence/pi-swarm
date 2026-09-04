import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Container, Markdown, stripTerminalSequences } from "@earendil-works/pi-tui";
import { replayHistory } from "../src/cli/history-replay.ts";
import { TuiRepl } from "../src/cli/tui-repl.ts";

const T0 = Date.parse("2025-01-01T00:00:00.000Z");

let nextId = 0;

/** Message entry with the given Pi message payload; parentId chains the path. */
function messageEntry(message: Record<string, unknown>, parentId: string | null = null): SessionEntry {
  nextId += 1;
  return { type: "message", id: `e${nextId}`, parentId, timestamp: new Date(T0).toISOString(), message } as unknown as SessionEntry;
}

/** Non-message entry (compaction, model_change, ...); parentId chains the path. */
function otherEntry(type: string, extra: Record<string, unknown> = {}, parentId: string | null = null): SessionEntry {
  nextId += 1;
  return { type, id: `e${nextId}`, parentId, timestamp: new Date(T0).toISOString(), ...extra } as unknown as SessionEntry;
}

function userEntry(content: unknown, parentId: string | null = null): SessionEntry {
  return messageEntry({ role: "user", content, timestamp: T0 }, parentId);
}

function assistantEntry(content: unknown, stopReason: string, parentId: string | null = null, extra: Record<string, unknown> = {}): SessionEntry {
  return messageEntry({ role: "assistant", content, stopReason, timestamp: T0, ...extra }, parentId);
}

/** Fake TUI + a real TuiRepl; returns the active transcript's log container. */
function makeRepl(): { repl: TuiRepl; log: Container } {
  const children: Component[] = [];
  // pi-tui marks viewport TUIs with a registry symbol that is not re-exported as a value.
  const VIEWPORT_TUI = Symbol.for("@earendil-works/pi-tui/viewport");
  const ui = {
    terminal: { rows: 30, columns: 120 },
    children,
    [VIEWPORT_TUI]: true,
    layoutRoot: undefined as Component | undefined,
    setLayoutRoot: (component: Component) => {
      ui.layoutRoot = component;
    },
    addChild: (component: Component) => {
      children.push(component);
    },
    removeChild: () => undefined,
    clear: () => children.splice(0, children.length),
    requestRender: () => undefined,
    start: () => undefined,
    stop: () => undefined,
    setFocus: () => undefined,
    addInputListener: () => () => undefined,
    showOverlay: () => ({ hide: () => undefined }),
    hideOverlay: () => undefined,
    hasOverlay: () => false
  };
  const repl = new TuiRepl({ ui: ui as never, onSubmit: async () => undefined, onExit: () => undefined });
  // layoutRoot → VStack[ScrollView(scrollBody → transcript), inputArea]; transcript = [log, stream].
  const root = ui.layoutRoot! as Container;
  const [chatArea] = root.children as [Container];
  const [scrollBody] = chatArea.children as [Container];
  const [transcript] = scrollBody.children as [Container];
  const [log] = transcript.children as [Container];
  return { repl, log };
}

const plain = (component: Component, width = 80): string => stripTerminalSequences(component.render(width).join("\n"));

test("empty history replays nothing", () => {
  const { repl } = makeRepl();
  assert.equal(replayHistory(repl, []), 0);
});

test("user messages replay as right-aligned bubbles (same component as live)", () => {
  const { repl, log } = makeRepl();
  const count = replayHistory(repl, [userEntry("你好")]);
  assert.equal(count, 1);
  assert.equal(log.children.length, 2, "announce row + the bubble");
  const raw = log.children[1].render(80).join("\n");
  assert.ok(raw.includes("\x1b[48;5;61m"), "bubble background color");
  const text = plain(log.children[1]);
  assert.ok(text.startsWith(" "), "right-aligned like the live bubble");
  assert.ok(text.trimEnd().endsWith("你好"));
  assert.ok(!text.includes("▸ 你"), "no speaker header — the bubble replaces it");
});

test("assistant thinking replays as a collapsible entry, text as headerless markdown", () => {
  const { repl, log } = makeRepl();
  const assistant = assistantEntry(
    [
      { type: "thinking", thinking: "先想一下", thinkingSignature: "sig" },
      { type: "text", text: "这是答案" }
    ],
    "stop"
  );
  replayHistory(repl, [assistant]);

  assert.equal(log.children.length, 3);
  assert.ok(log.children[1].render(80).join("\n").includes("pi-swarm://think/1"), "thinking folds as collapsible reasoning");
  assert.ok(log.children[2] instanceof Markdown, "text is plain markdown like the live stream");
  assert.ok(plain(log.children[2]).includes("这是答案"));
  assert.ok(!plain(log.children[2]).includes("▸ 助手"), "no speaker header — live output has none either");
});

test("tool calls replay as settled ✔/✘ rows with the arguments summary from the paired toolCall", () => {
  const { repl, log } = makeRepl();
  const assistant = assistantEntry(
    [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "npm test" } }],
    "toolUse"
  );
  const result = messageEntry(
    { role: "toolResult", toolCallId: "t1", toolName: "bash", content: [], isError: false, timestamp: T0 },
    assistant.id
  );
  const failed = assistantEntry([{ type: "toolCall", id: "t2", name: "read", arguments: { path: "a.ts" } }], "toolUse", result.id);
  const failure = messageEntry(
    { role: "toolResult", toolCallId: "t2", toolName: "read", content: [], isError: true, timestamp: T0 },
    failed.id
  );
  replayHistory(repl, [assistant, result, failed, failure]);

  assert.equal(log.children.length, 3);
  const ok = plain(log.children[1]);
  assert.ok(ok.includes("✔") && ok.includes("bash") && ok.includes("npm test"), "settled ✔ row with summary");
  const bad = plain(log.children[2]);
  assert.ok(bad.includes("✘") && bad.includes("read") && bad.includes("a.ts"), "failed ✘ row with summary");
});

test("aborted replies get an interrupted marker, errors get a warning line", () => {
  const { repl, log } = makeRepl();
  const aborted = assistantEntry([{ type: "text", text: "写到一半" }], "aborted");
  replayHistory(repl, [aborted, assistantEntry([], "error", aborted.id, { errorMessage: "provider 炸了" })]);

  assert.equal(log.children.length, 3);
  assert.ok(plain(log.children[1]).includes("写到一半（已中断）"));
  assert.ok(plain(log.children[2]).includes("⚠️ 助手返回错误：provider 炸了"));
});

test("custom display messages and compaction summaries replay as markdown notes", () => {
  const { repl, log } = makeRepl();
  const first = userEntry("早期消息");
  const second = assistantEntry([{ type: "text", text: "早期回复" }], "stop", first.id);
  const compaction = otherEntry("compaction", { summary: "摘要", firstKeptEntryId: second.id, tokensBefore: 10 }, second.id);
  const latest = userEntry("新消息", compaction.id);
  const shown = messageEntry({ role: "custom", customType: "note", content: "提示内容", display: true, timestamp: T0 }, latest.id);
  replayHistory(repl, [first, second, compaction, latest, shown]);

  const all = log.children.slice(1).map((child) => plain(child));
  assert.equal(log.children.length, 5, "announce + summary + kept user + latest user + custom note");
  assert.ok(all[0].includes("已压缩为摘要"));
  assert.ok(all[3].includes("提示内容"));
});

test("long texts are clamped and more items than maxMessages keep the latest with an omission marker", () => {
  const { repl, log } = makeRepl();
  const first = userEntry("0123456789");
  const second = userEntry("二", first.id);
  const third = userEntry("三", second.id);
  replayHistory(repl, [first, second, third], { maxMessages: 2, maxMessageChars: 4 });

  assert.ok(plain(log.children[1]).includes("已省略更早的 1 条"), "omission notice right after the announce row");
  assert.ok(plain(log.children[2]).includes("二"));
  const bubble = log.children[log.children.length - 1].render(80).join("\n");
  assert.ok(bubble.includes("\x1b[48;5;61m"), "clamped user message still replays as a bubble");
  assert.ok(plain(log.children[log.children.length - 1]).includes("三"));
});

test("replay announces the row count in the transcript", () => {
  const { repl, log } = makeRepl();
  replayHistory(repl, [userEntry("唯一一条")]);
  assert.ok(plain(log.children[0]).includes("已回放 1 条历史记录"), "header announces the row count");
});
