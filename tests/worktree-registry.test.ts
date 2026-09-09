import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorktreeRegistry } from "../src/core/worktree/worktree-registry.ts";
import { normalizeWorktreeName, randomWorktreeName, WorktreeError } from "../src/core/worktree/worktree-types.ts";

/** 搭一个假 git 仓库：仓库根是真实临时目录，git 命令由桩应答。 */
async function makeRepo(options: { registered?: string[]; branches?: string[] } = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-swarm-wt-"));
  const added: string[][] = [];
  const registered = options.registered ?? [];
  const branches = new Set(options.branches ?? []);
  const worktrees = new WorktreeRegistry({
    cwd: root,
    runGit: async (args) => {
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return { stdout: root };
      if (args[0] === "rev-parse" && args[1] === "--verify") {
        if (!args.includes("--quiet")) throw new Error("unexpected non-quiet verify");
        const ref = args[args.length - 1];
        if (ref.startsWith("refs/heads/") && branches.has(ref.slice("refs/heads/".length))) return { stdout: ref };
        throw new Error(`no such ref: ${ref}`);
      }
      if (args[0] === "worktree" && args[1] === "list") {
        const lines = registered.map((name) => `worktree ${join(root, ".pi-swarm", "worktrees", name)}\nbranch refs/heads/${name}`);
        return { stdout: lines.join("\n") };
      }
      if (args[0] === "worktree" && args[1] === "add") {
        added.push(args);
        return { stdout: "" };
      }
      throw new Error(`unexpected git call: ${args.join(" ")}`);
    }
  });
  return { worktrees, root, added, branches, registered };
}

test("normalizeWorktreeName validates the safe subset and rejects reserved/invalid names", () => {
  assert.equal(normalizeWorktreeName("fix-auth"), "fix-auth");
  assert.equal(normalizeWorktreeName("  wt-1.2  "), "wt-1.2");
  assert.equal(normalizeWorktreeName(undefined), undefined);
  assert.equal(normalizeWorktreeName(""), undefined);
  assert.equal(normalizeWorktreeName("   "), undefined);
  assert.throws(() => normalizeWorktreeName("."), WorktreeError, "the dot is reserved for the main workspace");
  assert.throws(() => normalizeWorktreeName("-lead"), WorktreeError);
  assert.throws(() => normalizeWorktreeName("a/b"), WorktreeError);
  assert.throws(() => normalizeWorktreeName("空格 名"), WorktreeError);
});

test("randomWorktreeName matches the name rules and avoids the dot collision", () => {
  for (let i = 0; i < 20; i += 1) {
    const name = randomWorktreeName();
    assert.match(name, /^wt-[0-9a-z]{6}$/);
    assert.equal(normalizeWorktreeName(name), name);
  }
});

test("ensureRoot resolves and caches the repo root; non-repos raise WorktreeError", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-swarm-wt-nogit-"));
  const failing = new WorktreeRegistry({
    cwd: dir,
    runGit: async () => {
      throw new Error("not a git repository");
    }
  });
  await assert.rejects(() => failing.ensureRoot(), /git 仓库/);
  await assert.rejects(() => failing.createOrResolve("x"), /git 仓库/);

  const { worktrees } = await makeRepo();
  const first = await worktrees.ensureRoot();
  const second = await worktrees.ensureRoot();
  assert.equal(first, second, "the resolved root is cached");
});

test("createOrResolve creates a branch+worktree for a fresh name and stamps .gitignore", async () => {
  const { worktrees, root, added } = await makeRepo();
  const info = await worktrees.createOrResolve("fix-auth");
  assert.equal(info.created, true);
  assert.equal(info.name, "fix-auth");
  assert.equal(info.path, join(root, ".pi-swarm", "worktrees", "fix-auth"));
  assert.deepEqual(added, [["worktree", "add", "-b", "fix-auth", info.path]]);
  const gitignore = await readFile(join(root, ".gitignore"), "utf8");
  assert.ok(gitignore.includes(".pi-swarm/worktrees/"), "the worktrees dir is gitignored");
});

test("createOrResolve reuses registered worktrees without adding, and remounts known branches", async () => {
  const { worktrees, added, registered } = await makeRepo({ registered: ["shared"], branches: ["orphan-branch"] });

  const reused = await worktrees.createOrResolve("shared");
  assert.equal(reused.created, false, "registered worktrees are shared, not recreated");
  assert.deepEqual(added, [], "no git worktree add runs for a registered path");

  const remounted = await worktrees.createOrResolve("orphan-branch");
  assert.equal(remounted.created, true);
  assert.deepEqual(added, [["worktree", "add", remounted.path, "orphan-branch"]], "an existing branch is remounted without -b");
  void registered;
});

test("createOrResolve invents a random name when omitted, and rejects existing unregistered dirs", async () => {
  const { worktrees, root, added } = await makeRepo();
  const info = await worktrees.createOrResolve();
  assert.match(info.name, /^wt-[0-9a-z]{6}$/);
  assert.equal(info.created, true);
  assert.equal(added.length, 1);

  const busy = join(root, ".pi-swarm", "worktrees", "taken");
  await mkdir(busy, { recursive: true });
  await assert.rejects(
    () => worktrees.createOrResolve("taken"),
    /目录已存在但不是注册的 worktree/
  );
});

test("list reports only managed worktrees under the pi-swarm root", async () => {
  const { worktrees } = await makeRepo({ registered: ["a", "b"] });
  const infos = await worktrees.list();
  assert.deepEqual(infos.map((info) => info.name).sort(), ["a", "b"]);
});

test("pathOf resolves names under the managed root", async () => {
  const { worktrees, root } = await makeRepo();
  assert.equal(await worktrees.pathOf("fix"), join(root, ".pi-swarm", "worktrees", "fix"));
});

test(".gitignore entries are never duplicated across creations", async () => {
  const { worktrees, root } = await makeRepo();
  await writeFile(join(root, ".gitignore"), ".pi-swarm/worktrees/\nnode_modules/\n", "utf8");
  await worktrees.createOrResolve("x");
  const content = await readFile(join(root, ".gitignore"), "utf8");
  assert.equal(content.split(".pi-swarm/worktrees/").length - 1, 1, "the entry is written at most once");
});
