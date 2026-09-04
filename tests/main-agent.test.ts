import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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

  try {
    // Wait for the startup banner instead of a fixed sleep: tsx cold boot can
    // take longer than any hardcoded delay.
    await waitFor(() => output, /主 agent 已启动/);
    assert.equal(child.exitCode, null, "the interactive main agent must not exit after startup");

    // Send the text and the Enter key as separate stdin chunks. The editor
    // submits only when a chunk is exactly "\r"; "/exit\r" in one write would
    // be treated as literal text and never submit (flake source).
    child.stdin.write("/exit");
    await sleep(50);
    child.stdin.write("\r");

    const [code] = await once(child, "exit");
    assert.equal(code, 0, `clean exit expected; output:\n${output}`);
    assert.match(output, /未加载任何子 agent|已加载子 agent/);
    assert.match(output, /pi-swarm 已退出/);
  } finally {
    // Never leak the interactive child: a survivor would keep the runner's
    // event loop alive and hang the whole suite.
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit").catch(() => undefined);
    }
  }
});

/** Resolves once `matcher` matches the accumulated output; fails after 15s. */
async function waitFor(buffer: () => string, matcher: RegExp, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (matcher.test(buffer())) return;
    await sleep(25);
  }
  assert.fail(`timed out waiting for ${matcher}; output so far:\n${buffer()}`);
}
