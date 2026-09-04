/**
 * Test runner wrapper: adds one overall wall-clock timeout around the whole
 * `tsx --test` run. Node's --test-timeout only caps individual tests; without
 * an outer guard a slow/hung suite (or orphaned handle) blocks CI forever.
 *
 * Usage:
 *   node scripts/run-tests.mjs            # runs the suite, 5 min overall cap
 *   TEST_TIMEOUT_MS=120000 node scripts/run-tests.mjs
 *   node scripts/run-tests.mjs tests/tui-repl.test.ts   # extra args go to the runner
 */
import { spawn } from "node:child_process";

const OVERALL_TIMEOUT_MS = Number(process.env.TEST_TIMEOUT_MS ?? 5 * 60_000);
const PER_TEST_TIMEOUT_MS = 30_000;

const forwardedArgs = process.argv.slice(2);
const fileArgs = forwardedArgs.length > 0 ? forwardedArgs : ["tests/*.test.{ts,tsx}"];

const IS_WIN = process.platform === "win32";
// shell:true so the glob reaches tsx unexpanded (same quoting semantics as npm scripts)
const child = spawn(
  "npx",
  ["tsx", "--test", `--test-timeout=${PER_TEST_TIMEOUT_MS}`, "--test-force-exit", ...fileArgs],
  { shell: IS_WIN, stdio: "inherit" }
);

let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  console.error(`\n[run-tests] 整体超时（${Math.round(OVERALL_TIMEOUT_MS / 1000)}s），强制终止测试进程。`);
  if (IS_WIN) spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else child.kill("SIGKILL");
  process.exitCode = 124;
}, OVERALL_TIMEOUT_MS);
timer.unref();

child.on("exit", (code) => {
  clearTimeout(timer);
  if (!timedOut) process.exitCode = code ?? 1;
});
