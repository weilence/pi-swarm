import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SessionManager as PiSessionManager } from "@earendil-works/pi-coding-agent";
import { JsonFileSessionStore } from "../src/core/session/json-file-session-store.ts";
import { InMemorySessionStore } from "../src/core/session/session-store.ts";
import { DEFAULT_CLEANUP_TTL_MS, SessionManager } from "../src/core/session/session-manager.ts";
import {
  SessionClosedError,
  SessionError,
  SessionNotFoundError,
  type SessionRecord
} from "../src/core/session/session-types.ts";

const T0 = Date.parse("2025-01-01T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

/** ISO timestamp at T0 + offsetMs, mirroring the injected clock. */
function recordAt(offsetMs: number): string {
  return new Date(T0 + offsetMs).toISOString();
}

function seedRecord(id: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id,
    createdAt: recordAt(0),
    updatedAt: recordAt(0),
    messageCount: 0,
    ...overrides
  };
}

/** Path equality that tolerates the SDK's windows path normalization. */
function samePath(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return a === b;
  const posix = (p: string) => p.replaceAll("\\", "/").replace(/\/+$/, "");
  return process.platform === "win32" ? posix(a).toLowerCase() === posix(b).toLowerCase() : posix(a) === posix(b);
}

interface OpenCall {
  path: string;
  sessionDir?: string;
  cwd?: string;
}

interface Harness {
  manager: SessionManager;
  store: InMemorySessionStore;
  dir: string;
  sessionDir: string;
  advance(ms: number): void;
  opened: OpenCall[];
}

/** A SessionManager over a temp dir + in-memory index, with an injected clock. */
async function makeHarness(options: { cleanupTtlMs?: number } = {}): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "pi-swarm-session-"));
  const sessionDir = join(dir, "sessions");
  const store = new InMemorySessionStore();
  let clockMs = T0;
  const opened: OpenCall[] = [];
  const manager = new SessionManager({
    cwd: dir,
    store,
    sessionDir,
    ...(options.cleanupTtlMs !== undefined ? { cleanupTtlMs: options.cleanupTtlMs } : {}),
    now: () => new Date(clockMs),
    openPiSession: (path, sessionDir, cwd) => {
      opened.push({ path, sessionDir, cwd });
      return PiSessionManager.open(path, sessionDir, cwd);
    }
  });
  await manager.initialize();
  return {
    manager,
    store,
    dir,
    sessionDir,
    advance: (ms) => {
      clockMs += ms;
    },
    opened
  };
}

// ---------------------------------------------------------------------------
// constructor / initialize
// ---------------------------------------------------------------------------

test("constructor rejects a blank cwd", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-swarm-session-"));
  assert.throws(
    () => new SessionManager({ cwd: "   ", store: new InMemorySessionStore(), sessionDir: join(dir, "sessions") }),
    SessionError
  );
});

test("initialize on an empty index starts with no current session", async () => {
  const { manager } = await makeHarness();
  assert.equal(manager.current(), undefined);
  assert.deepEqual(await manager.list(), []);
});

test("initialize loads records but never resumes the current pointer", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-swarm-session-"));
  const store = new InMemorySessionStore([
    seedRecord("active-old", { updatedAt: recordAt(-5 * DAY_MS) }),
    seedRecord("closed-newer", { updatedAt: recordAt(-1 * DAY_MS), closedAt: recordAt(-1 * DAY_MS) }),
    seedRecord("active-new", { updatedAt: recordAt(-2 * DAY_MS) })
  ]);
  const manager = new SessionManager({ cwd: dir, store, sessionDir: join(dir, "sessions"), now: () => new Date(T0) });
  await manager.initialize();
  assert.equal(manager.current(), undefined, "startup has no current session; the first dispatch auto-creates one");
  const listed = (await manager.list()).map((summary) => summary.id);
  assert.deepEqual(listed, ["closed-newer", "active-new", "active-old"], "records are loaded (updatedAt desc), closed ones skipped for /switch only");
});

test("initialize with only closed sessions leaves no current session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-swarm-session-"));
  const store = new InMemorySessionStore([seedRecord("closed", { closedAt: recordAt(-1) })]);
  const manager = new SessionManager({ cwd: dir, store, sessionDir: join(dir, "sessions"), now: () => new Date(T0) });
  await manager.initialize();
  assert.equal(manager.current(), undefined);
  assert.equal((await manager.list()).length, 1);
});

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

test("create registers a fresh current session with a unique id and reserved jsonl path", async () => {
  const { manager, store, sessionDir, advance } = await makeHarness();
  const first = await manager.create({ name: "alpha", model: "anthropic/claude-sonnet-4" });
  advance(5);
  const second = await manager.create();

  assert.notEqual(first.id, second.id);
  assert.ok(first.id.length > 0);
  assert.equal(first.name, "alpha");
  assert.equal(first.model, "anthropic/claude-sonnet-4");
  assert.equal(first.createdAt, recordAt(0));
  assert.equal(first.updatedAt, recordAt(0));
  assert.equal(first.messageCount, 0);
  assert.ok(first.sessionFile, "a persisted session reserves a jsonl path");
  assert.ok(first.sessionFile!.endsWith(".jsonl"));
  assert.ok(samePath(dirname(first.sessionFile!), sessionDir), "the reserved path lives inside sessionDir");
  assert.equal(second.name, undefined);
  assert.equal(second.model, undefined);

  assert.equal(manager.current()?.id, second.id, "a newly created session becomes current");
  assert.deepEqual((await store.load()).map((record) => record.id), [first.id, second.id]);
});

test("create treats blank names and models as absent", async () => {
  const { manager } = await makeHarness();
  const record = await manager.create({ name: "   ", model: "" });
  assert.equal(record.name, undefined);
  assert.equal(record.model, undefined);
});

test("create returns defensive copies", async () => {
  const { manager } = await makeHarness();
  const record = await manager.create({ name: "alpha" });
  record.name = "mutated";
  record.messageCount = 42;
  assert.equal(manager.get(record.id)?.name, "alpha");
  assert.equal(manager.get(record.id)?.messageCount, 0);
});

test("create fails cleanly when the pi session cannot provide a usable id", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-swarm-session-"));
  const store = new InMemorySessionStore([seedRecord("existing")]);
  const manager = new SessionManager({
    cwd: dir,
    store,
    sessionDir: join(dir, "sessions"),
    now: () => new Date(T0),
    createPiSession: () =>
      ({ isPersisted: () => false, getSessionFile: () => undefined, getSessionId: () => "" }) as unknown as PiSessionManager
  });
  await manager.initialize();
  await manager.switch("existing");
  assert.equal(manager.current()?.id, "existing");
  await assert.rejects(
    () => manager.create(),
    (error: unknown) => error instanceof SessionError && error.message.includes("新建会话失败")
  );
  assert.equal((await store.load()).length, 1, "the failed create persists nothing");
  assert.equal(manager.current()?.id, "existing", "the pointer stays on the previous session");
});

// ---------------------------------------------------------------------------
// switch
// ---------------------------------------------------------------------------

test("switch moves the current pointer and returns the target record", async () => {
  const { manager, advance } = await makeHarness();
  const first = await manager.create({ name: "first" });
  advance(1);
  const second = await manager.create({ name: "second" });
  assert.equal(manager.current()?.id, second.id);

  const switched = await manager.switch(first.id);
  assert.equal(switched.id, first.id);
  assert.equal(switched.name, "first");
  assert.equal(manager.current()?.id, first.id);

  // ids are normalized: surrounding whitespace still resolves
  assert.equal((await manager.switch(`  ${second.id}  `)).id, second.id);
  assert.equal(manager.current()?.id, second.id);
});

test("switch rejects unknown and blank ids without moving the pointer", async () => {
  const { manager } = await makeHarness();
  const record = await manager.create();
  for (const bad of ["", "   ", "ghost-id", " ghost-id "]) {
    await assert.rejects(() => manager.switch(bad), SessionNotFoundError);
  }
  assert.equal(manager.current()?.id, record.id);
});

test("switch refuses closed sessions", async () => {
  const { manager, advance } = await makeHarness();
  const first = await manager.create();
  advance(1);
  const second = await manager.create();
  await manager.close(first.id);
  await assert.rejects(() => manager.switch(first.id), SessionClosedError);
  assert.equal(manager.current()?.id, second.id, "the pointer stays on the open session");
});

// ---------------------------------------------------------------------------
// bind
// ---------------------------------------------------------------------------

test("bind opens the on-disk jsonl when the file exists", async () => {
  const { manager, dir, sessionDir, opened } = await makeHarness();
  const record = await manager.create();
  // Simulate the SDK flush: write a valid session header into the reserved file.
  const header = JSON.stringify({ type: "session", version: 3, id: record.id, timestamp: record.createdAt, cwd: dir });
  await writeFile(record.sessionFile!, `${header}\n`, "utf8");

  const pi = await manager.bind(record.id);
  assert.equal(opened.length, 1);
  assert.ok(samePath(opened[0].path, record.sessionFile));
  assert.ok(samePath(opened[0].sessionDir, sessionDir));
  assert.ok(samePath(opened[0].cwd, dir));
  assert.equal(pi.getSessionId(), record.id);
  assert.ok(samePath(pi.getSessionFile(), record.sessionFile));
});

test("bind re-creates an unflushed session with the same id and syncs the index path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-swarm-session-"));
  const ghost = join(dir, "sessions", "ghost-path.jsonl");
  const store = new InMemorySessionStore([seedRecord("11111111-1111-4111-8111-111111111111", { sessionFile: ghost })]);
  const manager = new SessionManager({ cwd: dir, store, sessionDir: join(dir, "sessions"), now: () => new Date(T0) });
  await manager.initialize();

  const pi = await manager.bind("11111111-1111-4111-8111-111111111111");
  assert.equal(pi.getSessionId(), "11111111-1111-4111-8111-111111111111", "the session is rebuilt with the record id");
  assert.ok(pi.isPersisted());
  assert.notEqual(pi.getSessionFile(), ghost, "the stale path is replaced by the newly reserved one");
  assert.ok(samePath(manager.get("11111111-1111-4111-8111-111111111111")?.sessionFile, pi.getSessionFile()));
  assert.ok(samePath((await store.load())[0].sessionFile, pi.getSessionFile()), "the rewritten path is persisted");
});

test("bind rejects unknown ids and closed sessions", async () => {
  const { manager } = await makeHarness();
  await assert.rejects(() => manager.bind("ghost"), SessionNotFoundError);
  await assert.rejects(() => manager.bind(""), SessionNotFoundError);
  const record = await manager.create();
  await manager.close(record.id);
  await assert.rejects(() => manager.bind(record.id), SessionClosedError);
});

// ---------------------------------------------------------------------------
// get / list / current
// ---------------------------------------------------------------------------

test("get returns defensive copies and undefined for unusable ids", async () => {
  const { manager } = await makeHarness();
  const record = await manager.create({ name: "alpha" });
  const fetched = manager.get(record.id);
  assert.deepEqual(fetched, record);
  fetched!.name = "mutated";
  assert.equal(manager.get(record.id)?.name, "alpha");

  assert.equal(manager.get(undefined), undefined);
  assert.equal(manager.get(""), undefined);
  assert.equal(manager.get("   "), undefined);
  assert.equal(manager.get("ghost"), undefined);
});

test("list sorts by updatedAt descending and flags the current session", async () => {
  const { manager, advance } = await makeHarness();
  const a = await manager.create({ name: "a", model: "anthropic/claude-sonnet-4" });
  advance(1);
  const b = await manager.create({ name: "b" });
  advance(1);
  const c = await manager.create({ name: "c" });

  let list = await manager.list();
  assert.deepEqual(list.map((summary) => summary.id), [c.id, b.id, a.id]);
  assert.deepEqual(list.map((summary) => summary.current), [true, false, false]);
  assert.equal(list.find((summary) => summary.id === a.id)?.model, "anthropic/claude-sonnet-4");

  advance(1);
  await manager.touch(a.id, { messages: 4 });
  list = await manager.list();
  assert.deepEqual(list.map((summary) => summary.id), [a.id, c.id, b.id], "touch re-ranks the touched session first");
  assert.equal(list.find((summary) => summary.id === a.id)?.messageCount, 4);
});

test("list breaks updatedAt ties by reverse insertion order for stable numbering", async () => {
  const { manager } = await makeHarness(); // clock frozen: both records share one updatedAt
  const first = await manager.create();
  const second = await manager.create();

  assert.deepEqual((await manager.list()).map((summary) => summary.id), [second.id, first.id]);
});

test("list shows closed status, never flags closed sessions current, and falls back to the id as name", async () => {
  const { manager, advance } = await makeHarness();
  const first = await manager.create(); // unnamed
  advance(1);
  const second = await manager.create({ name: "second" });
  await manager.close(second.id);

  const list = await manager.list();
  const closed = list.find((summary) => summary.id === second.id)!;
  assert.equal(closed.status, "closed");
  assert.equal(closed.current, false);
  assert.equal(list.find((summary) => summary.id === first.id)?.name, first.id, "unnamed sessions display the id");
  assert.equal(list.every((summary) => !summary.current), true, "no session is current after closing the current one");
});

// ---------------------------------------------------------------------------
// close
// ---------------------------------------------------------------------------

test("close without id closes the current session and clears the pointer", async () => {
  const { manager, store, advance } = await makeHarness();
  const record = await manager.create({ name: "work" });
  advance(10);
  const closed = await manager.close();
  assert.equal(closed.id, record.id);
  assert.equal(closed.closedAt, recordAt(10));
  assert.equal(manager.current(), undefined);

  const persisted = (await store.load()).find((candidate) => candidate.id === record.id);
  assert.equal(persisted?.closedAt, recordAt(10), "the closed timestamp is persisted");
});

test("close of a non-current session keeps the current pointer", async () => {
  const { manager, advance } = await makeHarness();
  const first = await manager.create();
  advance(1);
  const second = await manager.create();
  await manager.close(first.id);
  assert.equal(manager.current()?.id, second.id);
  assert.equal(manager.get(first.id)?.closedAt, recordAt(1));
});

test("close is idempotent for already closed sessions", async () => {
  const { manager, advance } = await makeHarness();
  const record = await manager.create();
  advance(10);
  await manager.close(record.id);
  advance(10);
  const again = await manager.close(record.id);
  assert.equal(again.closedAt, recordAt(10), "closedAt keeps its first value");
  assert.equal(manager.get(record.id)?.closedAt, recordAt(10));
});

test("close rejects unknown ids and reports when there is no current session", async () => {
  const { manager } = await makeHarness();
  for (const bad of ["ghost", "", "   "]) {
    await assert.rejects(() => manager.close(bad), SessionNotFoundError);
  }
  await manager.create();
  await manager.close();
  await assert.rejects(
    () => manager.close(),
    (error: unknown) => error instanceof SessionNotFoundError && error.message.includes("没有当前会话")
  );
});

// ---------------------------------------------------------------------------
// touch
// ---------------------------------------------------------------------------

test("touch advances updatedAt and accumulates messageCount", async () => {
  const { manager, store, advance } = await makeHarness();
  const record = await manager.create();
  advance(100);
  await manager.touch(record.id, { messages: 2 });
  assert.equal(manager.get(record.id)?.updatedAt, recordAt(100));
  assert.equal(manager.get(record.id)?.messageCount, 2);

  advance(100);
  await manager.touch(record.id); // no delta: still advances updatedAt
  assert.equal(manager.get(record.id)?.updatedAt, recordAt(200));
  assert.equal(manager.get(record.id)?.messageCount, 2);
  assert.equal((await store.load()).find((candidate) => candidate.id === record.id)?.messageCount, 2);
});

test("touch clamps messageCount at zero and rejects unknown ids", async () => {
  const { manager } = await makeHarness();
  const record = await manager.create();
  await manager.touch(record.id, { messages: -5 });
  assert.equal(manager.get(record.id)?.messageCount, 0);
  await assert.rejects(() => manager.touch("ghost"), SessionNotFoundError);
});

// ---------------------------------------------------------------------------
// cleanup
// ---------------------------------------------------------------------------

test("initialize + cleanup remove only closed records past the ttl; active ones never expire", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-swarm-session-"));
  const store = new InMemorySessionStore([
    seedRecord("expired-closed", { closedAt: recordAt(-31 * DAY_MS), updatedAt: recordAt(-31 * DAY_MS) }),
    seedRecord("boundary-closed", { closedAt: recordAt(-DEFAULT_CLEANUP_TTL_MS), updatedAt: recordAt(-DEFAULT_CLEANUP_TTL_MS) }),
    seedRecord("fresh-closed", { closedAt: recordAt(-29 * DAY_MS), updatedAt: recordAt(-29 * DAY_MS) }),
    seedRecord("ancient-active", { updatedAt: recordAt(-365 * DAY_MS) }),
    seedRecord("invalid-closedAt", { closedAt: "not-a-date", updatedAt: recordAt(-31 * DAY_MS) })
  ]);
  const manager = new SessionManager({ cwd: dir, store, sessionDir: join(dir, "sessions"), now: () => new Date(T0) });
  await manager.initialize();

  const remaining = (await manager.list()).map((summary) => summary.id);
  assert.ok(!remaining.includes("expired-closed"), "closed 31 days ago is removed");
  assert.ok(!remaining.includes("boundary-closed"), "closed exactly at the ttl boundary is removed");
  assert.ok(remaining.includes("fresh-closed"), "closed within the ttl stays");
  assert.ok(remaining.includes("ancient-active"), "active sessions never expire regardless of age");
  assert.ok(remaining.includes("invalid-closedAt"), "unparseable closedAt is kept and never cleaned");
  assert.equal(manager.current(), undefined, "initialize never restores the pointer");
  assert.ok(!(await store.load()).some((candidate) => candidate.id === "expired-closed"), "removals are persisted");
  assert.equal(await manager.cleanup(), 0, "a second cleanup run is a no-op");
});

test("cleanup is disabled when the ttl is zero or negative", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-swarm-session-"));
  for (const cleanupTtlMs of [0, -1]) {
    const store = new InMemorySessionStore([
      seedRecord(`ancient-${cleanupTtlMs}`, { closedAt: recordAt(-400 * DAY_MS), updatedAt: recordAt(-400 * DAY_MS) })
    ]);
    const manager = new SessionManager({ cwd: dir, store, sessionDir: join(dir, "sessions"), cleanupTtlMs, now: () => new Date(T0) });
    await manager.initialize();
    assert.ok(manager.get(`ancient-${cleanupTtlMs}`));
    assert.equal(await manager.cleanup(), 0);
  }
});

// ---------------------------------------------------------------------------
// concurrency / restart
// ---------------------------------------------------------------------------

test("mutations are serialized and a failure does not block the queue", async () => {
  const { manager, advance } = await makeHarness();
  const one = await manager.create({ name: "one" });
  advance(1);
  const two = await manager.create({ name: "two" });

  // The failing switch is enqueued first; the following create must still run.
  const failing = manager.switch("ghost");
  const succeeding = manager.create({ name: "three" });
  await assert.rejects(() => failing, SessionNotFoundError);
  const three = await succeeding;
  assert.equal(manager.get(three.id)?.name, "three");

  // Concurrent switch + create resolve in enqueue order: the later create wins the pointer.
  const [switched, created] = await Promise.all([manager.switch(one.id), manager.create({ name: "four" })]);
  assert.equal(switched.id, one.id);
  assert.equal(manager.current()?.id, created.id);
  assert.equal((await manager.list()).length, 4);
});

test("sessions survive a restart through the json file store", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-swarm-session-"));
  const file = join(dir, "sessions", "index.json");
  const sessionDir = join(dir, "sessions");
  let clockMs = T0;

  const first = new SessionManager({
    cwd: dir,
    store: new JsonFileSessionStore(file),
    sessionDir,
    now: () => new Date(clockMs)
  });
  await first.initialize();
  const alpha = await first.create({ name: "alpha" });
  clockMs += 1;
  await first.create({ name: "beta" });
  await first.close(alpha.id);

  const second = new SessionManager({
    cwd: dir,
    store: new JsonFileSessionStore(file),
    sessionDir,
    now: () => new Date(clockMs)
  });
  await second.initialize();
  assert.equal(second.current(), undefined, "restart starts with no current session");
  assert.ok(second.get(alpha.id)?.closedAt, "the closed session is still listed after restart");
  assert.deepEqual((await second.list()).map((summary) => summary.name), ["beta", "alpha"]);
});

test("startDraft opens a draft without touching the index; materialize creates for real", async () => {
  const { manager, store } = await makeHarness();
  await manager.initialize();

  manager.startDraft();
  assert.equal(manager.isDraft(), true, "the pointer enters the draft state");
  assert.equal(manager.current(), undefined);
  assert.deepEqual(await store.load(), [], "the index stays untouched");

  const record = await manager.materialize();
  assert.equal(manager.isDraft(), false, "materialize consumes the draft");
  assert.equal(manager.current()?.id, record.id);
  const stored = await store.load();
  assert.ok(stored.some((entry) => entry.id === record.id), "the record is persisted");
});

test("materialize prefers the draft name over the fallback, and the fallback over nothing", async () => {
  const { manager } = await makeHarness();
  await manager.initialize();

  manager.startDraft("显式名");
  const named = await manager.materialize("消息摘要");
  assert.equal(named.name, "显式名", "the draft name wins");
  assert.equal(manager.isDraft(), false);

  manager.startDraft();
  const fallback = await manager.materialize("消息摘要");
  assert.equal(fallback.name, "消息摘要", "the fallback names an unnamed draft");
});

test("repeated startDraft keeps the draft name; switching to a real session discards it", async () => {
  const { manager } = await makeHarness();
  await manager.initialize();
  const alpha = await manager.create({ name: "alpha" });

  manager.startDraft("draft-a");
  manager.startDraft();
  assert.equal(manager.isDraft(), true, "still the same draft");

  await manager.switch(alpha.id);
  assert.equal(manager.isDraft(), false, "switching away leaves the draft");
  assert.equal(manager.current()?.id, alpha.id);

  manager.startDraft();
  const fresh = await manager.materialize("summary");
  assert.equal(fresh.name, "summary", "the discarded draft name does not leak into a later draft");
});

test("materialize is idempotent when a current session already exists", async () => {
  const { manager } = await makeHarness();
  await manager.initialize();
  const alpha = await manager.create({ name: "alpha" });

  // Defensive branch: materialize with a live current session returns it as-is
  // instead of creating a second one.
  const record = await manager.materialize("summary");
  assert.equal(record.id, alpha.id, "the current session is returned untouched");
  assert.equal(manager.isDraft(), false, "no draft state lingers");
});

test("delete removes the record, the current pointer, and the jsonl file", async () => {
  const { manager } = await makeHarness();
  await manager.initialize();
  const alpha = await manager.create({ name: "alpha" });
  await writeFile(alpha.sessionFile!, "fake jsonl content");
  const beta = await manager.create({ name: "beta" }); // becomes current, no file flushed yet

  const removed = await manager.delete(alpha.id);
  assert.equal(removed.id, alpha.id, "the removed record is returned");
  await assert.rejects(() => stat(alpha.sessionFile!), "the jsonl file is deleted");
  assert.deepEqual((await manager.list()).map((summary) => summary.name), ["beta"]);
  assert.equal(manager.current()?.id, beta.id, "a non-current delete keeps the pointer");
  await assert.rejects(() => manager.delete(alpha.id), /不存在/, "deleting again reports not-found");

  // Deleting the current session clears the pointer; a missing file is fine.
  await manager.delete(beta.id);
  assert.equal(manager.current(), undefined);
  assert.deepEqual(await manager.list(), []);
});
