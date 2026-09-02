import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { resolve } from "node:path";

test("main agent stays alive until an explicit exit command", async () => {
  const child = spawn(process.execPath, [
    resolve("node_modules/tsx/dist/cli.mjs"),
    resolve("src/cli/main.ts")
  ], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PI_SWARM_WORKER: "mock" }
  });

  let output = "";
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });

  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(child.exitCode, null, "the interactive main agent must not exit after startup");
  child.stdin.write("/exit\n");
  const [result] = await once(child, "exit");
  assert.equal(result, 0);
  assert.match(output, /主 agent 已启动/);
  assert.match(output, /pi-swarm 已退出/);
});
