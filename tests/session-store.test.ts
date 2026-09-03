import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemorySessionStore } from "../src/core/session/session-store.ts";
import { JsonFileSessionStore } from "../src/core/session/json-file-session-store.ts";
import type { SessionRecord } from "../src/core/session/session-types.ts";

function makeRecord(id: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
    messageCount: 0,
    ...overrides
  };
}

test("InMemorySessionStore starts empty and roundtrips records", async () => {
  const store = new InMemorySessionStore();
  assert.deepEqual(await store.load(), []);
  const records = [makeRecord("a"), makeRecord("b", { name: "beta", messageCount: 3 })];
  await store.save(records);
  assert.deepEqual(await store.load(), records);
});

test("InMemorySessionStore hands out and keeps defensive copies", async () => {
  const original = makeRecord("a");
  const store = new InMemorySessionStore([original]);

  const loaded = await store.load();
  loaded[0].name = "mutated";
  assert.equal((await store.load())[0].name, undefined, "mutating a loaded record must not leak into the store");

  const saved = [makeRecord("b")];
  await store.save(saved);
  saved[0].messageCount = 99;
  assert.equal((await store.load())[0].messageCount, 0, "mutating a saved array must not leak into the store");
});

test("JsonFileSessionStore roundtrips records through the file", async () => {
  const file = join(await mkdtemp(join(tmpdir(), "session-store-")), "index.json");
  const store = new JsonFileSessionStore(file);
  assert.deepEqual(await store.load(), []);
  const records = [makeRecord("a", { name: "alpha", sessionFile: "D:/tmp/a.jsonl" }), makeRecord("b")];
  await store.save(records);
  assert.deepEqual(await store.load(), records);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), records);
});

test("missing files load as an empty index", async () => {
  const store = new JsonFileSessionStore(join(await mkdtemp(join(tmpdir(), "session-store-")), "missing.json"));
  assert.deepEqual(await store.load(), []);
});

test("corrupt or non-array files degrade to an empty index", async () => {
  const dir = await mkdtemp(join(tmpdir(), "session-store-"));
  const corrupt = new JsonFileSessionStore(join(dir, "corrupt.json"));
  await writeFile(join(dir, "corrupt.json"), "{not json", "utf8");
  assert.deepEqual(await corrupt.load(), []);

  const object = new JsonFileSessionStore(join(dir, "object.json"));
  await writeFile(join(dir, "object.json"), JSON.stringify({ records: [makeRecord("a")] }), "utf8");
  assert.deepEqual(await object.load(), []);
});

test("invalid records are filtered out on load", async () => {
  const dir = await mkdtemp(join(tmpdir(), "session-store-"));
  const file = join(dir, "index.json");
  const store = new JsonFileSessionStore(file);
  const entries: unknown[] = [
    makeRecord("valid", { name: "keep me" }),
    { id: "", createdAt: "x", updatedAt: "x", messageCount: 0 }, // blank id
    { id: "no-count", createdAt: "x", updatedAt: "x" }, // missing messageCount
    { id: "bad-count", createdAt: "x", updatedAt: "x", messageCount: "three" }, // non-number count
    null,
    "just a string"
  ];
  await writeFile(file, JSON.stringify(entries), "utf8");
  assert.deepEqual(await store.load(), [makeRecord("valid", { name: "keep me" })]);
});

test("save replaces prior content, creates parent dirs, and leaves no temp files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "session-store-"));
  const file = join(dir, "nested", "index.json");
  const store = new JsonFileSessionStore(file);
  await store.save([makeRecord("first")]);
  await store.save([makeRecord("second")]);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), [makeRecord("second")]);
  assert.deepEqual(await readdir(join(dir, "nested")), ["index.json"]);
});

test("the default store path lives under PI_SWARM_USERDATA/sessions", async () => {
  const previous = process.env.PI_SWARM_USERDATA;
  const dir = await mkdtemp(join(tmpdir(), "session-store-userdata-"));
  try {
    process.env.PI_SWARM_USERDATA = dir;
    const store = new JsonFileSessionStore();
    // Reads <dir>/sessions/index.json: missing → [] without touching the real user data dir.
    assert.deepEqual(await store.load(), []);
  } finally {
    if (previous === undefined) delete process.env.PI_SWARM_USERDATA;
    else process.env.PI_SWARM_USERDATA = previous;
  }
});
