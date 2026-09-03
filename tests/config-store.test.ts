import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonFileConfigStore } from "../src/core/config/json-file-config-store.ts";

test("roundtrips a snapshot through the json file", async () => {
  const store = new JsonFileConfigStore(join(await mkdtemp(join(tmpdir(), "config-store-")), "config.json"));
  assert.deepEqual(await store.load(), {});
  const snapshot = {
    providerId: "anthropic",
    model: "anthropic/claude-sonnet-4",
    thinkingLevel: "high",
    providerConfig: { api: "anthropic-messages", models: [{ id: "claude-sonnet-4" }] }
  };
  await store.save(snapshot);
  assert.deepEqual(await store.load(), snapshot);
});

test("missing or corrupt files load as an empty snapshot", async () => {
  const dir = await mkdtemp(join(tmpdir(), "config-store-"));
  const missing = new JsonFileConfigStore(join(dir, "missing.json"));
  assert.deepEqual(await missing.load(), {});
  const corrupt = new JsonFileConfigStore(join(dir, "corrupt.json"));
  await writeFile(join(dir, "corrupt.json"), "{not json", "utf8");
  assert.deepEqual(await corrupt.load(), {});
});

test("save creates parent directories and leaves no temp files behind", async () => {
  const dir = await mkdtemp(join(tmpdir(), "config-store-"));
  const file = join(dir, "nested", "dir", "config.json");
  const store = new JsonFileConfigStore(file);
  await store.save({ thinkingLevel: "off" });
  await store.save({ thinkingLevel: "high" });
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { thinkingLevel: "high" });
  assert.deepEqual(await readdir(join(dir, "nested", "dir")), ["config.json"]);
});
