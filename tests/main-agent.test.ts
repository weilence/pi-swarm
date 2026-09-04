import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("main agent stays alive until an explicit exit command", async () => {
  // Point every userdata-backed file (config.json, agent definitions, session
  // dirs) at a throwaway directory so the test never touches or depends on
  // real user data.
  const userData = await mkdtemp(join(tmpdir(), "pi-swarm-main-agent-"));
  const child = spawn(process.execPath, [
    resolve("node_modules/tsx/dist/cli.mjs"),
    resolve("src/cli/main.ts")
  ], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PI_SWARM_USERDATA: userData }
  });

  let output = "";
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });

  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(child.exitCode, null, "the interactive main agent must not exit after startup");
  child.stdin.write("/exit\r");
  const [result] = await once(child, "exit");
  assert.equal(result, 0);
  assert.match(output, /主 agent 已启动/);
  assert.match(output, /未加载任何子 agent|已加载子 agent/);
  assert.match(output, /pi-swarm 已退出/);
});
