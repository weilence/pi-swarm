import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDraftSession, deleteSessionById, executeCommand, switchToSessionId, type CommandServices, type SessionTasks } from "../src/cli/commands.ts";
import { SessionRegistry } from "../src/core/session/session-registry.ts";
import { InMemorySessionStore, type SessionStore } from "../src/core/session/session-store.ts";
import { WorktreeRegistry } from "../src/core/worktree/worktree-registry.ts";
import type { SessionRecord } from "../src/core/session/session-types.ts";

const T0 = Date.parse("2025-01-01T00:00:00.000Z");

/** Clock the caller can advance so /sessions numbering stays deterministic. */
function makeClock() {
  let clockMs = T0;
  return { now: () => new Date(clockMs), advance: (ms: number) => (clockMs += ms) };
}

async function makeSessions(clock = makeClock()) {
  const dir = await mkdtemp(join(tmpdir(), "pi-swarm-cmd-sessions-"));
  const sessions = new SessionRegistry({
    cwd: dir,
    store: new InMemorySessionStore(),
    sessionDir: join(dir, "sessions"),
    now: clock.now,
    // 作用域 cwd 解析：测试里不真建目录，只验证指针被传入 Pi 会话工厂。
    resolveWorktreeCwd: (name) => Promise.resolve(join(dir, "wt", name))
  });
  await sessions.initialize();
  return { sessions, clock, dir };
}

/** git 命令桩：仓库根是临时目录；registered 里的名字视为已注册的 worktree。 */
async function makeWorktrees(registered: string[] = []) {
  const dir = await mkdtemp(join(tmpdir(), "pi-swarm-worktrees-"));
  const root = join(dir, "repo");
  await mkdir(root, { recursive: true });
  const added: string[] = [];
  const worktrees = new WorktreeRegistry({
    cwd: root,
    runGit: async (args) => {
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return { stdout: root };
      if (args[0] === "worktree" && args[1] === "list") {
        const lines = registered.map((name) => `worktree ${join(root, ".pi-swarm", "worktrees", name)}`);
        return { stdout: lines.join("\n") };
      }
      if (args[0] === "rev-parse") throw new Error("no such ref");
      if (args[0] === "worktree" && args[1] === "add") added.push(args.join(" "));
      return { stdout: "" };
    }
  });
  return { worktrees, root, added };
}

/** 执行池门面桩：记录 ensure/dispose/runTask 调用，busy 可全局打开。 */
function makeTasks(options: { busy?: boolean; ensureError?: Error } = {}) {
  const ran: string[] = [];
  const ensured: string[] = [];
  const disposed: string[] = [];
  const tasks: SessionTasks = {
    isBusy: () => options.busy ?? false,
    ensure: async (id) => {
      if (options.ensureError) throw options.ensureError;
      ensured.push(id);
      return {
        runTask: async (goal: string) => {
          ran.push(`${id}:${goal}`);
          return "任务完成";
        }
      };
    },
    dispose: async (id) => {
      disposed.push(id);
    }
  };
  return { tasks, ran, ensured, disposed };
}

/** TUI 视图桩：记录会话挂载/草稿进入/回放；默认所有会话缓冲为空（触发回放路径）。 */
function makeReplStub(options: { populated?: (session: string) => boolean } = {}) {
  const mounted: string[] = [];
  const drafts: string[] = [];
  const replayed: string[] = [];
  return {
    mounted,
    drafts,
    replayed,
    setActiveSession(session: string): void {
      mounted.push(session);
    },
    sessionPopulated(session: string): boolean {
      return options.populated?.(session) ?? false;
    },
    clearTranscript(): void {
      drafts.push("clear");
    },
    appendMarkdown(markdown: string, agent?: string, session?: string): void {
      void markdown;
      void agent;
      if (session) replayed.push(session);
    },
    appendLine(line: string, agent?: string, session?: string): void {
      void line;
      void agent;
      if (session) replayed.push(session);
    },
    appendUserMessage(message: string, session?: string): void {
      void message;
      if (session) replayed.push(session);
    },
    appendThinking(text: string, agent?: string, session?: string): void {
      void text;
      void agent;
      if (session) replayed.push(session);
    },
    appendToolCall(toolName: string, summary: string, isError: boolean, agent?: string, session?: string): void {
      void toolName;
      void summary;
      void isError;
      void agent;
      if (session) replayed.push(session);
    }
  };
}

function makeServices(
  sessions: SessionRegistry,
  tasks: SessionTasks = makeTasks().tasks,
  repl?: ReturnType<typeof makeReplStub>,
  worktrees?: WorktreeRegistry
): CommandServices {
  return {
    agent: undefined,
    catalog: { load: async () => [] },
    log: (line: string) => logs.push(line),
    interactive: false,
    pick: async () => undefined,
    repl: repl as unknown as CommandServices["repl"],
    sessions,
    worktrees,
    tasks
  };
}

const logs: string[] = [];

async function run(line: string, services: CommandServices) {
  logs.length = 0;
  return await executeCommand(line, services, {});
}

test("/new opens a draft without creating anything; the first task materializes it in the current scope", async () => {
  const { sessions } = await makeSessions();
  const { tasks, ran, ensured } = makeTasks();
  const repl = makeReplStub();
  const services = makeServices(sessions, tasks, repl);

  await run("/new alpha", services);
  assert.equal(sessions.current(), undefined, "no record is created yet");
  assert.equal(sessions.isDraft(), true, "the pointer enters the draft state");
  assert.equal((await sessions.list()).length, 0, "the index stays empty");
  assert.ok(logs.some((line) => line.includes("草稿")));
  assert.deepEqual(repl.drafts, ["clear"], "the draft view is prepared");

  await run("hello world", services);
  const current = sessions.current()!;
  assert.equal(current.name, "alpha", "the draft name wins over the message summary");
  assert.equal(sessions.isDraft(), false, "the draft is consumed");
  assert.deepEqual(ensured, [current.id], "the pool builds the context for the materialized session");
  assert.deepEqual(ran, [`${current.id}:hello world`]);
  assert.equal(current.worktree, undefined, "main workspace scope has no worktree stamp");
});

test("the first task in a draft follows the view into the materialized session", async () => {
  const { sessions } = await makeSessions();
  const { tasks, ran } = makeTasks();
  const repl = makeReplStub();
  const services = makeServices(sessions, tasks, repl);

  await run("/new alpha", services);
  assert.deepEqual(repl.mounted, ["draft"], "opening the draft mounts the draft namespace");

  await run("hello worktree", services);
  const current = sessions.current()!;
  assert.deepEqual(
    repl.mounted,
    ["draft", current.id],
    "the view follows the materialized session instead of staying on the invisible draft"
  );
  assert.deepEqual(repl.replayed, [current.id], "the first message is echoed into the new namespace so streaming lands on the mounted buffer");
  assert.deepEqual(ran, [`${current.id}:hello worktree`]);
});

test("a task without a draft names the new session from the message summary", async () => {
  const { sessions } = await makeSessions();
  const { tasks } = makeTasks();
  const services = makeServices(sessions, tasks);

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

test("/new while a session streams is allowed: switching views never blocks on busy", async () => {
  const { sessions } = await makeSessions();
  const { tasks, ensured, disposed } = makeTasks({ busy: true });
  const services = makeServices(sessions, tasks);
  await run("warm up", services);
  const busyId = sessions.current()!.id;
  assert.deepEqual(ensured, [busyId]);

  await run("/new beta", services);
  assert.equal(sessions.isDraft(), true, "the draft opens even though the session is streaming");
  assert.deepEqual(disposed, [], "the streaming context is untouched");
  assert.equal((await sessions.list())[0].id, busyId, "the streaming session stays in the index");
});

test("repeated /new opens the same draft and keeps its name (idempotent)", async () => {
  const { sessions } = await makeSessions();
  const { tasks, ran } = makeTasks();
  const services = makeServices(sessions, tasks);

  await openDraftSession(services, "first");
  await openDraftSession(services);
  await run("/new", services);
  assert.equal(sessions.isDraft(), true);
  assert.equal((await sessions.list()).length, 0, "still nothing on the index");

  await run("go", services);
  assert.equal(sessions.current()!.name, "first", "the original draft name survives re-openings");
  assert.equal(ran.length, 1, "exactly one task ran");
});

test("an ensure failure closes the orphan session and surfaces the error", async () => {
  const { sessions } = await makeSessions();
  const { tasks } = makeTasks({ ensureError: new Error("pool boom") });
  const services = makeServices(sessions, tasks);

  await run("do something", services);
  assert.equal(sessions.current(), undefined, "the unused materialized session is closed again");
  assert.equal((await sessions.list()).every((summary) => summary.status === "closed"), true);
  assert.ok(logs.some((line) => line.includes("任务执行失败：pool boom")));
});

test("/switch draft opens the draft; switching to a real session discards it", async () => {
  const { sessions } = await makeSessions();
  const services = makeServices(sessions);
  const first = await sessions.create({ name: "first" });

  await run("/switch draft", services);
  assert.equal(sessions.isDraft(), true, "draft is a reserved /switch target");

  await switchToSessionId(first.id, services);
  assert.equal(sessions.isDraft(), false, "switching away consumes the draft");
  assert.equal(sessions.current()?.name, "first");
});

test("/sessions lists numbered sessions grouped by scope", async () => {
  const { sessions, clock } = await makeSessions();
  const services = makeServices(sessions);
  await run("/sessions", services);
  assert.ok(logs.some((line) => line.includes("暂无会话")));

  await sessions.create({ name: "one" });
  clock.advance(10);
  const second = await sessions.create({ name: "two" });
  sessions.switchWorktree("wt-side");
  clock.advance(10);
  await sessions.create({ name: "side" });
  sessions.switchWorktree(undefined);
  await run("/sessions", services);
  assert.ok(logs.some((line) => line.includes("⎇ 主工作区")));
  assert.ok(logs.some((line) => line.includes("⎇ wt-side")));
  // 全局序号与 /switch <序号> 对齐：side 最新为 1，two、one 依次在后。
  assert.ok(logs.some((line) => line.includes("1. side")));
  assert.ok(logs.some((line) => line.includes("2. two")));
  assert.ok(logs.some((line) => line.includes("3. one")));
  assert.ok(logs.some((line) => line.includes("当前")));
  assert.ok(logs.some((line) => line.includes(second.id)));
});

test("/switch resolves by id and by list number, rejecting closed sessions", async () => {
  const { sessions, clock } = await makeSessions();
  const services = makeServices(sessions);
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

  await run("/switch", services);
  assert.ok(logs.some((line) => line.includes("用法")));
  await run("/switch ghost", services);
  assert.ok(logs.some((line) => line.includes("找不到会话")));

  await run(`/switch ${sessions.current()!.id}`, services);
  assert.ok(logs.some((line) => line.includes("已是当前会话")));
});

test("/close defaults to the current session; busy sessions refuse to close", async () => {
  const { sessions } = await makeSessions();
  const { tasks, disposed } = makeTasks();
  const services = makeServices(sessions, tasks);
  await sessions.create({ name: "work" });

  await run("/close", services);
  assert.equal(sessions.current(), undefined);
  assert.deepEqual(disposed.length, 1, "the closed session's context is released");
  assert.ok(logs.some((line) => line.includes("原当前会话") && line.includes("草稿")));
  await run("/close", services);
  assert.ok(logs.some((line) => line.includes("没有当前会话")));

  const second = await sessions.create({ name: "work-2" });
  const busyTasks = makeTasks({ busy: true });
  services.tasks = busyTasks.tasks;
  await run("/close", services);
  assert.equal(sessions.current()?.id, second.id, "the busy session stays open");
  assert.ok(logs.some((line) => line.includes("无法关闭")));
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
  const sessions = new SessionRegistry({ cwd: dir, store: failing, sessionDir: join(dir, "sessions"), now: clock.now });
  await sessions.initialize();

  await assert.rejects(() => sessions.materialize(), /disk full/);
  assert.equal(sessions.current(), undefined);
  assert.deepEqual(await sessions.list(), []);
});

test("switchToSessionId mounts the view; JSONL replay only when the buffer is empty", async () => {
  const { sessions } = await makeSessions();
  const repl = makeReplStub();
  const services = makeServices(sessions, makeTasks().tasks, repl);
  const first = await sessions.create({ name: "first" });
  const second = await sessions.create({ name: "second" });

  // The sessions bar routes raw ids here; unknown ones must not throw.
  await switchToSessionId("ghost", services);
  assert.ok(logs.some((line) => line.includes("找不到会话")));
  assert.deepEqual(repl.mounted, [], "a failed switch keeps the current view");

  await switchToSessionId(first.id, services);
  assert.equal(sessions.current()?.name, "first");
  assert.deepEqual(repl.mounted, [first.id], "the view mounts the target session");
  assert.deepEqual(repl.replayed, [first.id], "an empty buffer triggers the JSONL replay");

  // 已有缓冲（进程内切回）：不再回放 JSONL。
  const repl2 = makeReplStub({ populated: () => true });
  const services2 = makeServices(sessions, makeTasks().tasks, repl2);
  await switchToSessionId(second.id, services2);
  assert.deepEqual(repl2.mounted, [second.id]);
  assert.deepEqual(repl2.replayed, [], "populated buffers catch up without replay");

  await switchToSessionId(first.id, services2);
  assert.equal(sessions.current()?.name, "first");
});

test("clicking a session from another scope switches the scope along with it", async () => {
  const { sessions } = await makeSessions();
  const services = makeServices(sessions);
  await sessions.create({ name: "home" });
  sessions.switchWorktree("wt-a");
  const scoped = await sessions.create({ name: "scoped" });
  sessions.switchWorktree(undefined);

  await switchToSessionId(scoped.id, services);
  assert.equal(sessions.current()?.name, "scoped");
  assert.equal(sessions.currentScope(), "wt-a", "the scope pointer follows the clicked session");

  await switchToSessionId("ghost", services);
  assert.equal(sessions.currentScope(), "wt-a", "failed switches leave the scope alone");
});

test("/worktree creates a random scope and lands in draft; sessions created there belong to it", async () => {
  const { sessions } = await makeSessions();
  const { tasks } = makeTasks();
  const repl = makeReplStub();
  const { worktrees } = await makeWorktrees();
  const services = makeServices(sessions, tasks, repl, worktrees);

  await run("/worktree", services);
  const scope = sessions.currentScope();
  assert.ok(scope && scope.startsWith("wt-"), "a random scope name is generated");
  assert.equal(sessions.isDraft(), true, "an empty scope lands in the draft state");
  assert.ok(logs.some((line) => line.includes("已创建 worktree")));

  const record = await sessions.create({ name: "in-scope" });
  assert.equal(record.worktree, scope, "the scope stamp is applied at creation");
});

test("/worktree <name> reuses a registered worktree without creating another", async () => {
  const { sessions } = await makeSessions();
  const services = makeServices(sessions, makeTasks().tasks, undefined, await makeWorktrees(["shared"]).then((w) => w.worktrees));

  await run("/worktree shared", services);
  assert.equal(sessions.currentScope(), "shared");
  assert.ok(logs.some((line) => line.includes("切入已有 worktree")));
});

test("/worktree . returns to the main workspace and resumes its latest session", async () => {
  const { sessions } = await makeSessions();
  const { worktrees } = await makeWorktrees(["wt-a"]);
  const services = makeServices(sessions, makeTasks().tasks, undefined, worktrees);
  await sessions.create({ name: "home" });
  sessions.switchWorktree("wt-a");
  await sessions.create({ name: "in-a" });

  await run("/worktree .", services);
  assert.equal(sessions.currentScope(), undefined, "the pointer is back on the main workspace");
  assert.equal(sessions.current()?.name, "home", "the latest main-workspace session is resumed");
  assert.equal(sessions.isDraft(), false);

  await run("/worktrees", services);
  assert.ok(logs.some((line) => line.includes("主工作区（当前）")));
  assert.ok(logs.some((line) => line.includes("⎇ wt-a")));
});

test("deleteSessionById removes a non-current session without touching the pointer", async () => {
  const { sessions } = await makeSessions();
  const { tasks, disposed } = makeTasks();
  const services = makeServices(sessions, tasks);
  const first = await sessions.create({ name: "first" });
  await sessions.create({ name: "second" }); // current

  await deleteSessionById(first.id, services);
  assert.equal((await sessions.list()).length, 1, "the record is gone");
  assert.equal(sessions.current()?.name, "second", "the pointer is untouched");
  assert.equal(sessions.isDraft(), false);
  assert.deepEqual(disposed, [], "only the current session's context would be released");
  assert.ok(logs.some((line) => line.includes("已删除会话：first")));
  void first;
});

test("deleting the current session opens the session that takes its sidebar slot", async () => {
  const { sessions } = await makeSessions();
  const { tasks, disposed } = makeTasks();
  const services = makeServices(sessions, tasks);
  await sessions.create({ name: "first" });
  const second = await sessions.create({ name: "second" }); // current

  // Sidebar order: second, first → deleting second lets first take the slot.
  await deleteSessionById(second.id, services);
  assert.deepEqual((await sessions.list()).map((summary) => summary.name), ["first"], "only the other session remains");
  assert.equal(sessions.current()?.name, "first", "the remaining session takes the deleted slot, no draft");
  assert.equal(sessions.isDraft(), false);
  assert.deepEqual(disposed, [second.id], "the deleted session's context is released first");
  assert.ok(logs.some((line) => line.includes("已删除会话：second")));
});

test("deleting a middle session opens the next one below the deleted slot", async () => {
  const { sessions } = await makeSessions();
  const services = makeServices(sessions);
  await sessions.create({ name: "first" });
  const second = await sessions.create({ name: "second" });
  await sessions.create({ name: "third" });
  await sessions.switch(second.id); // current

  // Sidebar order: third, second, first → slot 1 is taken by first after deletion.
  await deleteSessionById(second.id, services);
  assert.equal(sessions.current()?.name, "first");
  assert.equal(sessions.isDraft(), false);
});

test("deleting the last remaining session falls back to the draft state", async () => {
  const { sessions } = await makeSessions();
  const { tasks, disposed } = makeTasks();
  const repl = makeReplStub();
  const services = makeServices(sessions, tasks, repl);
  const first = await sessions.create({ name: "first" }); // current

  await deleteSessionById(first.id, services);
  assert.equal((await sessions.list()).length, 0);
  assert.equal(sessions.current(), undefined);
  assert.equal(sessions.isDraft(), true, "no session remains: the app lands in the draft state");
  assert.deepEqual(disposed, [first.id]);
  assert.ok(repl.drafts.length > 0, "the draft view is prepared");
});

test("delete is rejected while busy and unknown ids are reported", async () => {
  const { sessions } = await makeSessions();
  const { tasks } = makeTasks({ busy: true });
  const services = makeServices(sessions, tasks);
  const first = await sessions.create({ name: "first" });

  await deleteSessionById(first.id, services);
  assert.equal((await sessions.list()).length, 1, "busy state prevents deletion");
  assert.ok(logs.some((line) => line.includes("正在输出")));

  const idleServices = makeServices(sessions, makeTasks().tasks);
  await deleteSessionById("ghost", idleServices);
  assert.ok(logs.some((line) => line.includes("找不到会话")));
});

test("/delete resolves by id and by list number", async () => {
  const { sessions } = await makeSessions();
  const services = makeServices(sessions);
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
