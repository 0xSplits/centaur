import { describe, expect, test } from "bun:test";
import { hasLiveActiveExecution } from "../src/index";

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
