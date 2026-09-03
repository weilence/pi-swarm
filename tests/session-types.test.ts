import assert from "node:assert/strict";
import { test } from "node:test";
import {
  normalizeOptionalText,
  SessionClosedError,
  SessionError,
  SessionNotFoundError,
  SessionBusyError,
  sessionStatus,
  type SessionRecord
} from "../src/core/session/session-types.ts";

function makeRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "record-1",
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
    messageCount: 0,
    ...overrides
  };
}

test("sessionStatus derives closed from the presence of closedAt", () => {
  assert.equal(sessionStatus(makeRecord()), "active");
  assert.equal(sessionStatus(makeRecord({ closedAt: "2025-01-02T00:00:00.000Z" })), "closed");
});

test("normalizeOptionalText trims and blanks become undefined", () => {
  assert.equal(normalizeOptionalText("  alpha  "), "alpha");
  assert.equal(normalizeOptionalText("alpha"), "alpha");
  assert.equal(normalizeOptionalText(""), undefined);
  assert.equal(normalizeOptionalText("   \t\n "), undefined);
  assert.equal(normalizeOptionalText(undefined), undefined);
});

test("session errors form a distinguishable hierarchy", () => {
  const notFound = new SessionNotFoundError("会话不存在");
  assert.ok(notFound instanceof SessionError);
  assert.ok(notFound instanceof Error);
  assert.equal(notFound.name, "SessionNotFoundError");

  const closed = new SessionClosedError("会话已关闭");
  assert.ok(closed instanceof SessionError);
  assert.ok(!(closed instanceof SessionNotFoundError));
  assert.equal(closed.name, "SessionClosedError");

  const busy = new SessionBusyError("会话正在输出");
  assert.ok(busy instanceof SessionError);
  assert.ok(!(busy instanceof SessionNotFoundError));
  assert.ok(!(busy instanceof SessionClosedError));
  assert.equal(busy.name, "SessionBusyError");
});
