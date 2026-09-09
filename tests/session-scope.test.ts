import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionRegistry } from "../src/core/session/session-registry.ts";
import { InMemorySessionStore } from "../src/core/session/session-store.ts";
import { WorktreeScopeMissingError } from "../src/core/session/session-types.ts";

const T0 = Date.parse("2025-01-01T00:00:00.000Z");

interface createdPi {
  cwd: string;
  id?: string;
}

/** 内存索引 + 录制型 Pi 工厂：验证 cwd/id 注入，不碰真实文件系统。 */
async function makeRegistry(options: { worktrees?: Map<string, string> } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "pi-swarm-scope-"));
  const created: createdPi[] = [];
  const opened: { path: string; cwd?: string }[] = [];
  const sessions = new SessionRegistry({
    cwd: dir,
    store: new InMemorySessionStore(),
    sessionDir: join(dir, "sessions"),
    now: () => new Date(T0),
    createPiSession: (cwd, _dir, opts) => {
      created.push({ cwd, ...(opts?.id ? { id: opts.id } : {}) });
      // 最小 Pi 桩：仅暴露 registry 依赖的读接口。
      return {
        getSessionId: () => opts?.id ?? "generated",
        getSessionFile: () => join(dir, "sessions", `${opts?.id ?? "generated"}.jsonl`),
        isPersisted: () => true,
        getSessionName: () => undefined
      } as never;
    },
    openPiSession: (path, _dir, cwdOverride) => {
      opened.push({ path, ...(cwdOverride ? { cwd: cwdOverride } : {}) });
      return {
        getSessionId: () => "opened",
        getSessionFile: () => path,
        isPersisted: () => true,
        getSessionName: () => undefined
      } as never;
    },
    resolveWorktreeCwd: options.worktrees ? (name) => Promise.resolve(options.worktrees!.get(name)) : undefined
  });
  await sessions.initialize();
  return { sessions, created, opened, dir };
}

test("startup scope is the main workspace; switchWorktree moves the in-memory pointer", async () => {
  const { sessions } = await makeRegistry();
  assert.equal(sessions.currentScope(), undefined, "startup always lands in the main workspace");
  sessions.switchWorktree("wt-x");
  assert.equal(sessions.currentScope(), "wt-x");
  sessions.switchWorktree(undefined);
  assert.equal(sessions.currentScope(), undefined);
  sessions.switchWorktree("   ");
  assert.equal(sessions.currentScope(), undefined, "blank names normalize to the main workspace");
});

test("materialize stamps the CURRENT scope; sessions created elsewhere keep theirs", async () => {
  const { sessions, created } = await makeRegistry();

  const main = await sessions.create({ name: "main" });
  assert.equal(main.worktree, undefined, "main-workspace sessions carry no stamp");

  sessions.switchWorktree("wt-a");
  sessions.startDraft(); // materialize 只承接草稿：先清掉 current 指针。
  const scoped = await sessions.materialize("scoped");
  assert.equal(scoped.worktree, "wt-a", "the draft materializes into the current scope");

  sessions.switchWorktree(undefined);
  assert.notEqual((await sessions.get(scoped.id))!.worktree, undefined, "the stamp never changes retroactively");
});

test("bind resolves the session's scope into the Pi session cwd", async () => {
  const worktrees = new Map([['wt-a', '/abs/wt-a']]);
  const { sessions, created, opened, dir } = await makeRegistry({ worktrees });

  sessions.switchWorktree("wt-a");
  const scoped = await sessions.create({ name: "scoped" });
  const pi = await sessions.bind(scoped.id);
  assert.equal(pi.getSessionId(), scoped.id);
  assert.equal(created.at(-1)?.cwd, "/abs/wt-a", "create receives the scope directory as cwd");

  sessions.switchWorktree(undefined);
  const main = await sessions.create({ name: "main" });
  await sessions.bind(main.id);
  assert.equal(created.at(-1)?.cwd, dir, "main-workspace sessions keep the startup cwd");
  assert.equal(opened.length, 0, "fresh sessions never take the open path");
});

test("bind falls back to open() for persisted sessions and keeps the scope cwd", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-swarm-scope-open-"));
  await mkdir(join(dir, "sessions"), { recursive: true });
  const persisted = join(dir, "sessions", "fixed.jsonl");
  await writeFile(persisted, "", "utf8");
  const created: createdPi[] = [];
  const opened: { path: string; cwd?: string }[] = [];
  const stub = () => ({
    getSessionId: () => "fixed-id",
    getSessionFile: () => persisted,
    isPersisted: () => true,
    getSessionName: () => undefined
  });
  const sessions = new SessionRegistry({
    cwd: dir,
    store: new InMemorySessionStore(),
    sessionDir: join(dir, "sessions"),
    resolveWorktreeCwd: () => Promise.resolve("/abs/wt-a"),
    createPiSession: (cwd) => {
      created.push({ cwd });
      return stub() as never;
    },
    openPiSession: (path, _dir, cwdOverride) => {
      opened.push({ path, ...(cwdOverride ? { cwd: cwdOverride } : {}) });
      return stub() as never;
    }
  });
  await sessions.initialize();

  sessions.switchWorktree("wt-a");
  const record = await sessions.create({ name: "scoped" });
  assert.equal(record.sessionFile, persisted, "the stub always reports the persisted path");
  await sessions.bind(record.id); // 文件真实存在 → open 路径，不再 create。
  assert.equal(created.length, 1, "no second create for a persisted session");
  assert.deepEqual(opened, [{ path: persisted, cwd: "/abs/wt-a" }], "open receives the scope directory as cwd override");
});

test("bind refuses sessions whose worktree directory vanished (no silent fallback)", async () => {
  const { sessions } = await makeRegistry({ worktrees: new Map() });
  sessions.switchWorktree("wt-gone");
  const record = await sessions.create({ name: "lost" });
  await assert.rejects(
    () => sessions.bind(record.id),
    WorktreeScopeMissingError
  );
});

test("worktree stamps survive the index round-trip (store save/load)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-swarm-scope-persist-"));
  const store = new InMemorySessionStore();
  const first = new SessionRegistry({
    cwd: dir,
    store,
    sessionDir: join(dir, "sessions"),
    now: () => new Date(T0),
    createPiSession: ((cwd: string) => ({
      getSessionId: () => "fixed-id",
      getSessionFile: () => join(cwd, "fixed-id.jsonl"),
      isPersisted: () => true,
      getSessionName: () => undefined
    })) as never
  });
  await first.initialize();
  first.switchWorktree("wt-persist");
  await first.create({ name: "stamped" });

  const second = new SessionRegistry({
    cwd: dir,
    store,
    sessionDir: join(dir, "sessions"),
    now: () => new Date(T0),
    resolveWorktreeCwd: (name) => Promise.resolve(join(dir, "wt", name))
  });
  await second.initialize();
  const list = await second.list();
  assert.equal(list[0].worktree, "wt-persist", "the scope stamp is part of the persisted record");
  assert.equal(second.currentScope(), undefined, "the scope pointer itself is NOT persisted");
});
