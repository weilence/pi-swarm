import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDraftSession, deleteSessionById, executeCommand, switchToSessionId, type CommandServices } from "../src/cli/commands.ts";
import { SessionManager } from "../src/core/session/session-manager.ts";
import { InMemorySessionStore, type SessionStore } from "../src/core/session/session-store.ts";
import type { SessionRecord } from "../src/core/session/session-types.ts";

const T0 = Date.parse("2025-01-01T00:00:00.000Z");

/** Clock the caller can advance so /sessions numbering stays deterministic. */
function makeClock() {
  let clockMs = T0;
  return { now: () => new Date(clockMs), advance: (ms: number) => (clockMs += ms) };
}

async function makeSessions(store: SessionStore = new InMemorySessionStore(), clock = makeClock()) {
  const dir = await mkdtemp(join(tmpdir(), "pi-swarm-cmd-sessions-"));
  const sessions = new SessionManager({ cwd: dir, store, sessionDir: join(dir, "sessions"), now: clock.now });
  await sessions.initialize();
  return { sessions, clock };
}

interface AgentStub {
  rebindCalls: string[];
  detachCalls: number;
  busy: boolean;
  rebindError?: Error;
}

function makeAgent(stub: AgentStub) {
  return {
    rebind: async (sessionManager: { getSessionId(): string }) => {
      if (stub.rebindError) throw stub.rebindError;
      stub.rebindCalls.push(sessionManager.getSessionId());
      return `已切换会话：${sessionManager.getSessionId()}`;
    },
    detach: () => {
      stub.detachCalls += 1;
    },
    isBusy: () => stub.busy,
    runTask: async (goal: string) => `任务完成：${goal}`
  } as unknown as CommandServices["agent"];
}

function makeServices(
  sessions: SessionManager,
  agent?: CommandServices["agent"],
  repl?: CommandServices["repl"]
): CommandServices {
  return {
    agent,
    catalog: { load: async () => [] },
    log: (line: string) => logs.push(line),
    interactive: false,
    pick: async () => undefined,
    repl,
    sessions,
    agents: { list: () => [] }
  };
}

const logs: string[] = [];

async function run(line: string, services: CommandServices) {
  logs.length = 0;
  return await executeCommand(line, services, {});
}

test("/new opens a draft without creating anything; the first task materializes it with the draft name", async () => {
  const { sessions } = await makeSessions();
  const stub: AgentStub = { rebindCalls: [], detachCalls: 0, busy: false };
  const services = makeServices(sessions, makeAgent(stub));

  await run("/new alpha", services);
  assert.equal(sessions.current(), undefined, "no record is created yet");
  assert.equal(sessions.isDraft(), true, "the pointer enters the draft state");
  assert.equal((await sessions.list()).length, 0, "the index stays empty");
  assert.equal(stub.rebindCalls.length, 0, "no rebind happens either");
  assert.equal(stub.detachCalls, 1, "the agent releases its previous session");
  assert.ok(logs.some((line) => line.includes("草稿")));

  await run("hello world", services);
  const current = sessions.current()!;
  assert.equal(current.name, "alpha", "the draft name wins over the message summary");
  assert.deepEqual(stub.rebindCalls, [current.id], "the agent binds the materialized session");
  assert.equal(sessions.isDraft(), false, "the draft is consumed");
});

test("a task without a draft names the new session from the message summary", async () => {
  const { sessions } = await makeSessions();
  const stub: AgentStub = { rebindCalls: [], detachCalls: 0, busy: false };
  const services = makeServices(sessions, makeAgent(stub));

  await run("修复登录页面的 bug", services);
  const current = sessions.current()!;
  assert.equal(current.name, "修复登录页面的 bug");
  assert.equal(current.messageCount, 2, "one turn = user message + assistant reply");
  assert.equal(sessions.isDraft(), false);

  await run("/new", services);
  assert.equal(sessions.isDraft(), true, "a later /new opens a fresh draft");
  await run("继续下一个任务", services);
  assert.notEqual(sessions.current()!.id, current.id, "the draft materializes a new session");
  assert.equal(sessions.current()!.name, "继续下一个任务");
});

test("/new is rejected while the agent is busy and leaves state untouched", async () => {
  const { sessions } = await makeSessions();
  const stub: AgentStub = { rebindCalls: [], detachCalls: 0, busy: false };
  const services = makeServices(sessions, makeAgent(stub));
  await run("warm up", services);
  const before = sessions.current()!.id;

  stub.busy = true;
  await run("/new beta", services);
  assert.equal(sessions.current()!.id, before, "the pointer stays on the running session");
  assert.equal(sessions.isDraft(), false);
  assert.equal(stub.detachCalls, 0);
  assert.ok(logs.some((line) => line.includes("正在输出")));
});

test("repeated /new opens the same draft and keeps its name (idempotent)", async () => {
  const { sessions } = await makeSessions();
  const stub: AgentStub = { rebindCalls: [], detachCalls: 0, busy: false };
  const services = makeServices(sessions, makeAgent(stub));

  await openDraftSession(services, "first");
  await openDraftSession(services);
  await run("/new", services);
  assert.equal(sessions.isDraft(), true);
  assert.equal((await sessions.list()).length, 0, "still nothing on the index");

  await run("go", services);
  assert.equal(sessions.current()!.name, "first", "the original draft name survives re-openings");
  assert.equal(stub.detachCalls, 3, "each open detaches, but no session is ever created early");
});

test("a task in draft mode closes the orphan session when rebind fails, and still runs", async () => {
  const { sessions } = await makeSessions();
  const stub: AgentStub = { rebindCalls: [], detachCalls: 0, busy: false, rebindError: new Error("rebind boom") };
  const services = makeServices(sessions, makeAgent(stub));

  await run("do something", services);
  assert.equal(sessions.current(), undefined, "the unused materialized session is closed again");
  assert.equal((await sessions.list()).every((summary) => summary.status === "closed"), true);
  assert.ok(logs.some((line) => line.includes("自动创建会话失败")));
});

test("/switch draft opens the draft; switching to a real session discards it", async () => {
  const { sessions } = await makeSessions();
  const stub: AgentStub = { rebindCalls: [], detachCalls: 0, busy: false };
  const services = makeServices(sessions, makeAgent(stub));
  const first = await sessions.create({ name: "first" });

  await run("/switch draft", services);
  assert.equal(sessions.isDraft(), true, "draft is a reserved /switch target");

  await switchToSessionId(first.id, services);
  assert.equal(sessions.isDraft(), false, "switching away consumes the draft");
  assert.equal(sessions.current()?.name, "first");
});

test("/sessions lists numbered sessions and reports none when the index is empty", async () => {
  const { sessions, clock } = await makeSessions();
  const services = makeServices(sessions);
  await run("/sessions", services);
  assert.ok(logs.some((line) => line.includes("暂无会话")));

  await sessions.create({ name: "one" });
  clock.advance(10);
  const second = await sessions.create({ name: "two" });
  await run("/sessions", services);
  assert.ok(logs.some((line) => line.includes("1. two")));
  assert.ok(logs.some((line) => line.includes("2. one")));
  assert.ok(logs.some((line) => line.includes("当前")));
  assert.ok(logs.some((line) => line.includes(second.id)));
});

test("/switch resolves by id and by list number, rejecting closed sessions", async () => {
  const { sessions, clock } = await makeSessions();
  const stub: AgentStub = { rebindCalls: [], detachCalls: 0, busy: false };
  const services = makeServices(sessions, makeAgent(stub));
  const first = await sessions.create({ name: "first" });
  clock.advance(10);
  const second = await sessions.create({ name: "second" });
  await sessions.close(first.id);

  await run("/switch " + first.id, services);
  assert.ok(logs.some((line) => line.includes("切换失败") && line.includes("已关闭")));

  await run("/switch 2", services); // list order: second, first → 2 = first (closed)
  assert.ok(logs.some((line) => line.includes("切换失败")));

  clock.advance(10);
  await sessions.create({ name: "third" }); // list order: third, second, first(closed)
  await run("/switch 2", services); // 2 = second, a real switch
  assert.equal(sessions.current()?.name, "second");
  assert.deepEqual(stub.rebindCalls, [second.id]);

  const rebinds = stub.rebindCalls.length;
  await run("/switch", services);
  assert.ok(logs.some((line) => line.includes("用法")));
  await run("/switch ghost", services);
  assert.ok(logs.some((line) => line.includes("找不到会话")));

  await run(`/switch ${sessions.current()!.id}`, services);
  assert.equal(stub.rebindCalls.length, rebinds, "switching to the current session is a logged no-op");
  assert.ok(logs.some((line) => line.includes("已是当前会话")));
});

test("/close defaults to the current session and hints at the draft flow", async () => {
  const { sessions } = await makeSessions();
  const stub: AgentStub = { rebindCalls: [], detachCalls: 0, busy: false };
  const services = makeServices(sessions, makeAgent(stub));
  await sessions.create({ name: "work" });

  await run("/close", services);
  assert.equal(sessions.current(), undefined);
  assert.ok(logs.some((line) => line.includes("原当前会话") && line.includes("草稿")));
  await run("/close", services);
  assert.ok(logs.some((line) => line.includes("没有当前会话")));
});

test("create leaves memory untouched when the store cannot persist", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-swarm-cmd-sessions-"));
  const failing = new (class implements SessionStore {
    async load(): Promise<SessionRecord[]> {
      return [];
    }

    async save(): Promise<void> {
      throw new Error("disk full");
    }
  })();
  const clock = makeClock();
  const sessions = new SessionManager({ cwd: dir, store: failing, sessionDir: join(dir, "sessions"), now: clock.now });
  await sessions.initialize();

  await assert.rejects(() => sessions.materialize(), /disk full/);
  assert.equal(sessions.current(), undefined);
  assert.deepEqual(await sessions.list(), []);
});

test("switchToSessionId shares the /switch core: no-op on current, unknown ids rejected", async () => {
  const { sessions } = await makeSessions();
  const stub: AgentStub = { rebindCalls: [], detachCalls: 0, busy: false };
  const services = makeServices(sessions, makeAgent(stub));
  const first = await sessions.create({ name: "first" });
  const second = await sessions.create({ name: "second" });

  // The sessions bar routes raw ids here; unknown ones must not throw.
  await switchToSessionId("ghost", services);
  assert.ok(logs.some((line) => line.includes("找不到会话")));

  await switchToSessionId(first.id, services);
  assert.equal(sessions.current()?.name, "first");
  assert.deepEqual(stub.rebindCalls, [first.id]);

  logs.length = 0;
  await switchToSessionId(second.id, services);
  await switchToSessionId(first.id, services);
  assert.deepEqual(stub.rebindCalls, [first.id, second.id, first.id]);

  logs.length = 0;
  await switchToSessionId(first.id, services);
  assert.equal(stub.rebindCalls.length, 3, "clicking the current session must not rebind again");
  assert.ok(logs.some((line) => line.includes("已是当前会话")));
});

test("switching clears the transcript even when the target session is empty", async () => {
  const { sessions } = await makeSessions();
  const stub: AgentStub = { rebindCalls: [], detachCalls: 0, busy: false };
  const repl = {
    cleared: 0,
    appended: [] as string[],
    clearTranscript(): void {
      repl.cleared += 1;
    },
    appendMarkdown(markdown: string): void {
      repl.appended.push(markdown);
    }
  };
  const services = makeServices(sessions, makeAgent(stub), repl as unknown as CommandServices["repl"]);
  const first = await sessions.create({ name: "first" });
  await sessions.create({ name: "empty" });

  await switchToSessionId(first.id, services);
  assert.equal(repl.cleared, 1, "a successful switch wipes the transcript before replay");
  assert.ok(repl.appended.some((line) => line.includes("空会话")), "an empty target gets an explicit note");

  repl.cleared = 0;
  await switchToSessionId("ghost", services);
  assert.equal(repl.cleared, 0, "a failed switch keeps the current transcript");
  await switchToSessionId(first.id, services);
  assert.equal(repl.cleared, 0, "a no-op switch (current session) keeps the transcript");
});

test("deleteSessionById removes a non-current session without touching the pointer", async () => {
  const { sessions } = await makeSessions();
  const stub: AgentStub = { rebindCalls: [], detachCalls: 0, busy: false };
  const services = makeServices(sessions, makeAgent(stub));
  const first = await sessions.create({ name: "first" });
  await sessions.create({ name: "second" }); // current

  await deleteSessionById(first.id, services);
  assert.equal((await sessions.list()).length, 1, "the record is gone");
  assert.equal(sessions.current()?.name, "second", "the pointer is untouched");
  assert.equal(sessions.isDraft(), false);
  assert.equal(stub.detachCalls, 0);
  assert.ok(logs.some((line) => line.includes("已删除会话：first")));
});

test("deleting the current session opens the session that takes its sidebar slot", async () => {
  const { sessions } = await makeSessions();
  const stub: AgentStub = { rebindCalls: [], detachCalls: 0, busy: false };
  const services = makeServices(sessions, makeAgent(stub));
  await sessions.create({ name: "first" });
  const second = await sessions.create({ name: "second" }); // current

  // Sidebar order: second, first → deleting second lets first take the slot.
  await deleteSessionById(second.id, services);
  assert.deepEqual((await sessions.list()).map((summary) => summary.name), ["first"], "only the other session remains");
  assert.equal(sessions.current()?.name, "first", "the remaining session takes the deleted slot, no draft");
  assert.equal(sessions.isDraft(), false);
  assert.equal(stub.detachCalls, 1, "the agent releases the deleted session first");
  assert.equal(stub.rebindCalls.length, 1, "the successor is rebound like /switch");
  assert.ok(logs.some((line) => line.includes("已删除会话：second")));
});

test("deleting a middle session opens the next one below the deleted slot", async () => {
  const { sessions } = await makeSessions();
  const stub: AgentStub = { rebindCalls: [], detachCalls: 0, busy: false };
  const services = makeServices(sessions, makeAgent(stub));
  await sessions.create({ name: "first" });
  const second = await sessions.create({ name: "second" });
  await sessions.create({ name: "third" });
  await sessions.switch(second.id); // current

  // Sidebar order: third, second, first → slot 1 is taken by first after deletion.
  await deleteSessionById(second.id, services);
  assert.equal(sessions.current()?.name, "first");
  assert.equal(sessions.isDraft(), false);
  assert.equal(stub.rebindCalls.length, 1, "exactly one rebind: onto the slot successor");
});

test("deleting the last remaining session falls back to the draft state", async () => {
  const { sessions } = await makeSessions();
  const stub: AgentStub = { rebindCalls: [], detachCalls: 0, busy: false };
  const services = makeServices(sessions, makeAgent(stub));
  const first = await sessions.create({ name: "first" }); // current

  await deleteSessionById(first.id, services);
  assert.equal((await sessions.list()).length, 0);
  assert.equal(sessions.current(), undefined);
  assert.equal(sessions.isDraft(), true, "no session remains: the app lands in the draft state");
  assert.equal(stub.detachCalls, 1);
});

test("delete is rejected while busy and unknown ids are reported", async () => {
  const { sessions } = await makeSessions();
  const stub: AgentStub = { rebindCalls: [], detachCalls: 0, busy: true };
  const services = makeServices(sessions, makeAgent(stub));
  const first = await sessions.create({ name: "first" });

  await deleteSessionById(first.id, services);
  assert.equal((await sessions.list()).length, 1, "busy state prevents deletion");
  assert.ok(logs.some((line) => line.includes("正在输出")));

  stub.busy = false;
  await deleteSessionById("ghost", services);
  assert.ok(logs.some((line) => line.includes("找不到会话")));
});

test("/delete resolves by id and by list number", async () => {
  const { sessions } = await makeSessions();
  const stub: AgentStub = { rebindCalls: [], detachCalls: 0, busy: false };
  const services = makeServices(sessions, makeAgent(stub));
  await sessions.create({ name: "one" });
  await sessions.create({ name: "two" });

  await run("/delete 1", services); // list order: two, one → 1 = two (current)
  assert.equal((await sessions.list()).map((summary) => summary.name).join(), "one");
  assert.equal(sessions.current()?.name, "one", "one takes the deleted slot instead of a draft");
  assert.equal(sessions.isDraft(), false);

  await run("/delete", services);
  assert.ok(logs.some((line) => line.includes("用法")));
  await run("/delete ghost", services);
  assert.ok(logs.some((line) => line.includes("找不到会话")));
});
