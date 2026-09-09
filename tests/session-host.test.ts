import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager as PiSessionManager } from "@earendil-works/pi-coding-agent";
import { SessionHost } from "../src/pi/session-host.ts";
import { StreamMetrics } from "../src/pi/stream-metrics.ts";

function makeHost(sessionManager?: PiSessionManager): SessionHost {
  return new SessionHost({
    cwd: process.cwd(),
    agentDir: "not-created-in-tests",
    ...(sessionManager ? { sessionManager } : {}),
    sinks: { onText: () => undefined, onThinking: () => undefined, onToolStart: () => undefined, onToolEnd: () => undefined },
    metrics: new StreamMetrics()
  });
}

/**
 * 回归：Agent 重构时把 sessionManager 装配挪进 SessionHost，注入的持久
 * 会话管理器必须仍是首个 open() 的默认绑定对象（否则 ensureSession 会
 * 永远落在 inMemory 上，注入形同虚设）。
 */
test("SessionHost adopts an injected session manager as the initial binding", () => {
  const injected = PiSessionManager.inMemory(process.cwd());
  const host = makeHost(injected);
  assert.equal(host.sessionManager, injected, "injected session manager must be the default binding target");

  const hostWithoutInjection = makeHost();
  assert.equal(hostWithoutInjection.sessionManager, undefined, "without injection, binding falls back at open() time");
});
