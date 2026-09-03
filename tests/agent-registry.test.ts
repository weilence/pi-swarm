import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry, defaultAgentDirs } from "../src/core/agent-registry.ts";

async function makeDirs(): Promise<{ globalDir: string; projectDir: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "pi-swarm-agents-"));
  const globalDir = join(root, "global");
  const projectDir = join(root, "project");
  await mkdir(globalDir, { recursive: true });
  await mkdir(projectDir, { recursive: true });
  return { globalDir, projectDir, cleanup: () => rm(root, { recursive: true, force: true }) };
}

const doc = (name: string, description = `负责 ${name} 相关任务的能力描述`): string =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${name} 的 system prompt。`;

test("loads agents from both directories and lists them sorted", async () => {
  const dirs = await makeDirs();
  try {
    await writeFile(join(dirs.globalDir, "zeta.md"), doc("zeta"));
    await writeFile(join(dirs.projectDir, "alpha.md"), doc("alpha"));
    const registry = await AgentRegistry.load(dirs);
    assert.deepEqual(registry.list().map((agent) => agent.name), ["alpha", "zeta"]);
    assert.equal(registry.get("alpha")?.sourceFile, join(dirs.projectDir, "alpha.md"));
  } finally {
    await dirs.cleanup();
  }
});

test("project definition shadows the global one on name collision", async () => {
  const dirs = await makeDirs();
  try {
    await writeFile(join(dirs.globalDir, "shared.md"), doc("shared", "全局版本描述"));
    await writeFile(join(dirs.projectDir, "shared.md"), doc("shared", "项目版本描述"));
    const registry = await AgentRegistry.load(dirs);
    assert.equal(registry.size, 1);
    assert.equal(registry.get("shared")?.description, "项目版本描述");
    assert.equal(registry.get("shared")?.sourceFile, join(dirs.projectDir, "shared.md"));
  } finally {
    await dirs.cleanup();
  }
});

test("corrupt files are skipped with warnings, never thrown", async () => {
  const dirs = await makeDirs();
  try {
    await writeFile(join(dirs.projectDir, "broken.md"), "没有 frontmatter 的损坏文档");
    await writeFile(join(dirs.projectDir, "good.md"), doc("good"));
    let notified = 0;
    const registry = await AgentRegistry.load(dirs, () => {
      notified += 1;
    });
    assert.equal(registry.size, 1);
    assert.equal(registry.get("good")?.name, "good");
    assert.ok(notified >= 1);
    assert.ok(registry.warnings.some((warning) => warning.file.includes("broken.md")));
  } finally {
    await dirs.cleanup();
  }
});

test("missing directories yield an empty registry", async () => {
  const registry = await AgentRegistry.load({ globalDir: join(tmpdir(), "does-not-exist-g"), projectDir: join(tmpdir(), "does-not-exist-p") });
  assert.equal(registry.size, 0);
  assert.deepEqual(registry.list(), []);
});

test("defaultAgentDirs points at user data dir and project .pi-swarm/agents", () => {
  const dirs = defaultAgentDirs("/repo");
  assert.ok(dirs.globalDir.includes("pi-swarm"));
  assert.ok(dirs.projectDir.replace(/\\/g, "/").endsWith(".pi-swarm/agents"));
});
