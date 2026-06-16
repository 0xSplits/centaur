import { beforeEach, describe, expect, test } from "bun:test";
import type { Logger, Message as ChatMessage } from "chat";
import {
  clearConversationNameCacheForTests,
  hasLiveActiveExecution,
  resolveLinearConversationName,
} from "../src/index";

const noopLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return noopLogger;
  },
} as unknown as Logger;

function fakeMessage(
  threadId: string,
  subject: unknown,
  onSubjectAccess?: () => void,
): ChatMessage {
  return {
    threadId,
    get subject() {
      onSubjectAccess?.();
      return subject instanceof Error
        ? Promise.reject(subject)
        : Promise.resolve(subject);
    },
  } as unknown as ChatMessage;
}

describe("hasLiveActiveExecution", () => {
  const ttlMs = 30 * 60 * 1000;

  test("false when the flag is unset", () => {
    expect(hasLiveActiveExecution({}, ttlMs)).toBe(false);
    expect(hasLiveActiveExecution({ activeExecution: false }, ttlMs)).toBe(
      false,
    );
  });

  test("false when the flag has no timestamp (stale writer)", () => {
    expect(hasLiveActiveExecution({ activeExecution: true }, ttlMs)).toBe(
      false,
    );
    expect(
      hasLiveActiveExecution(
        { activeExecution: true, activeExecutionStartedAt: null },
        ttlMs,
      ),
    ).toBe(false);
  });

  test("true while the timestamp is within the TTL", () => {
    const now = 1_750_000_000_000;
    expect(
      hasLiveActiveExecution(
        { activeExecution: true, activeExecutionStartedAt: now - ttlMs + 1 },
        ttlMs,
        now,
      ),
    ).toBe(true);
  });

  test("false once the timestamp ages past the TTL", () => {
    const now = 1_750_000_000_000;
    expect(
      hasLiveActiveExecution(
        { activeExecution: true, activeExecutionStartedAt: now - ttlMs - 1 },
        ttlMs,
        now,
      ),
    ).toBe(false);
  });
});

describe("resolveLinearConversationName", () => {
  beforeEach(() => clearConversationNameCacheForTests());

  test("prefers the issue identifier", async () => {
    const message = fakeMessage("linear:issue-1:s:sess-1", {
      id: "ENG-123",
      title: "Fix login",
    });
    expect(await resolveLinearConversationName(message, noopLogger)).toBe(
      "ENG-123",
    );
  });

  test("falls back to the title when there is no identifier", async () => {
    const message = fakeMessage("linear:issue-2:s:sess-1", {
      title: "Untriaged issue",
    });
    expect(await resolveLinearConversationName(message, noopLogger)).toBe(
      "Untriaged issue",
    );
  });

  test("returns undefined (never throws) when the subject lookup fails", async () => {
    const message = fakeMessage(
      "linear:issue-3:s:sess-1",
      new Error("Entity not found"),
    );
    expect(
      await resolveLinearConversationName(message, noopLogger),
    ).toBeUndefined();
  });

  test("caches by issue so a second session does not re-fetch", async () => {
    let fetches = 0;
    const first = fakeMessage(
      "linear:issue-9:s:sess-a",
      { id: "ENG-9" },
      () => (fetches += 1),
    );
    const second = fakeMessage(
      "linear:issue-9:s:sess-b",
      { id: "ENG-9" },
      () => (fetches += 1),
    );
    expect(await resolveLinearConversationName(first, noopLogger)).toBe(
      "ENG-9",
    );
    expect(await resolveLinearConversationName(second, noopLogger)).toBe(
      "ENG-9",
    );
    expect(fetches).toBe(1);
  });
});
