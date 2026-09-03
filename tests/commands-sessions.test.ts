import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeCommand, type CommandServices } from "../src/cli/commands.ts";
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
    isBusy: () => stub.busy,
    runTask: async (goal: string) => `任务完成：${goal}`
  } as unknown as CommandServices["agent"];
}

function makeServices(sessions: SessionManager, agent?: CommandServices["agent"]): CommandServices {
  return {
    agent,
    catalog: { load: async () => [] },
    log: (line: string) => logs.push(line),
    interactive: false,
    pick: async () => undefined,
    sessions,
    agents: { list: () => [] }
  };
}

const logs: string[] = [];

async function run(line: string, services: CommandServices) {
  logs.length = 0;
  return await executeCommand(line, services, {});
}

test("/new creates a session, moves the pointer, and rebinds the agent", async () => {
  const { sessions } = await makeSessions();
  const stub: AgentStub = { rebindCalls: [], busy: false };
  const services = makeServices(sessions, makeAgent(stub));

  await run("/new alpha", services);
  const current = sessions.current()!;
  assert.equal(current.name, "alpha");
  assert.deepEqual(stub.rebindCalls, [current.id]);
  assert.ok(logs.some((line) => line.includes("已切换会话")));
});

test("/new is rejected while the agent is busy and leaves state untouched", async () => {
  const { sessions } = await makeSessions();
  const stub: AgentStub = { rebindCalls: [], busy: false };
  const services = makeServices(sessions, makeAgent(stub));
  await run("/new alpha", services);
  const before = sessions.current()!.id;

  stub.busy = true;
  await run("/new beta", services);
  assert.equal(sessions.current()!.id, before);
  assert.equal(stub.rebindCalls.length, 1);
  assert.ok(logs.some((line) => line.includes("正在输出")));
});

test("/new rolls the pointer back when rebind fails after create", async () => {
  const { sessions } = await makeSessions();
  const stub: AgentStub = { rebindCalls: [], busy: false };
  const services = makeServices(sessions, makeAgent(stub));
  await run("/new keep", services);
  const before = sessions.current()!.id;

  stub.rebindError = new Error("boom");
  await run("/new broken", services);
  assert.equal(sessions.current()!.id, before, "the pointer stays on the session the agent actually uses");
  assert.ok(logs.some((line) => line.includes("新建会话失败")));
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
  const stub: AgentStub = { rebindCalls: [], busy: false };
  const services = makeServices(sessions, makeAgent(stub));
  const first = await sessions.create({ name: "first" });
  clock.advance(10);
  await sessions.create({ name: "second" });
  await sessions.close(first.id);

  await run("/switch " + first.id, services);
  assert.ok(logs.some((line) => line.includes("切换失败") && line.includes("已关闭")));

  await run("/switch 2", services); // list order: second, first → 2 = first (closed)
  assert.ok(logs.some((line) => line.includes("切换失败")));

  await run("/switch 1", services); // second
  assert.equal(sessions.current()?.name, "second");
  assert.equal(stub.rebindCalls.length, 1);

  await run("/switch", services);
  assert.ok(logs.some((line) => line.includes("用法")));
  await run("/switch ghost", services);
  assert.ok(logs.some((line) => line.includes("找不到会话")));
});

test("/close defaults to the current session and hints at auto-create", async () => {
  const { sessions } = await makeSessions();
  const stub: AgentStub = { rebindCalls: [], busy: false };
  const services = makeServices(sessions, makeAgent(stub));
  await sessions.create({ name: "work" });

  await run("/close", services);
  assert.equal(sessions.current(), undefined);
  assert.ok(logs.some((line) => line.includes("原当前会话") && line.includes("自动新建")));
  await run("/close", services);
  assert.ok(logs.some((line) => line.includes("没有当前会话")));
});

test("a task auto-creates a session when none is current, then records the turn", async () => {
  const { sessions, clock } = await makeSessions();
  const stub: AgentStub = { rebindCalls: [], busy: false };
  const services = makeServices(sessions, makeAgent(stub));

  await run("do something", services);
  const current = sessions.current()!;
  assert.ok(current);
  assert.equal(stub.rebindCalls.length, 1);
  assert.equal(current.messageCount, 2, "one turn = user message + assistant reply");

  clock.advance(10);
  await run("do more", services);
  assert.equal(sessions.current()?.messageCount, 4, "the same session keeps accumulating");
  assert.equal(stub.rebindCalls.length, 1, "no rebind while a current session exists");
});

test("auto-create failure closes the orphan session and still runs the task", async () => {
  const { sessions } = await makeSessions();
  const stub: AgentStub = { rebindCalls: [], busy: false, rebindError: new Error("rebind boom") };
  const services = makeServices(sessions, makeAgent(stub));

  await run("do something", services);
  assert.equal(sessions.current(), undefined, "the unused fresh session is closed again");
  assert.equal((await sessions.list()).every((summary) => summary.status === "closed"), true);
  assert.ok(logs.some((line) => line.includes("自动新建会话失败")));
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

  await assert.rejects(() => sessions.create(), /disk full/);
  assert.equal(sessions.current(), undefined);
  assert.deepEqual(await sessions.list(), []);
});
