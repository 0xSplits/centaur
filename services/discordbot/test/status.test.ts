import { describe, expect, it } from "bun:test";
import {
  collectStatus,
  formatStatus,
  isStatusCommand,
  type StatusDb,
  type StatusReport,
} from "../src/status";
import type { DiscordbotFetch } from "../src/types";

describe("isStatusCommand", () => {
  it("matches bare status/health requests with mention markup", () => {
    expect(isStatusCommand("status")).toBe(true);
    expect(isStatusCommand("Status?")).toBe(true);
    expect(isStatusCommand("health!")).toBe(true);
    expect(isStatusCommand("<@123456> status")).toBe(true);
    expect(isStatusCommand("<@!123456> health")).toBe(true);
    expect(isStatusCommand("<@&987> status")).toBe(true);
    expect(isStatusCommand("@gerard status")).toBe(true);
    expect(isStatusCommand("  @gerard   STATUS  ")).toBe(true);
  });

  it("rejects real questions and ordinary messages", () => {
    expect(isStatusCommand("status of the deploy")).toBe(false);
    expect(isStatusCommand("@gerard what's the status?")).toBe(false);
    expect(isStatusCommand("can you check the health of api-rs")).toBe(false);
    expect(isStatusCommand("hello")).toBe(false);
    expect(isStatusCommand("")).toBe(false);
    expect(isStatusCommand("<@123456>")).toBe(false);
  });
});

function healthyFetch(status = 200): DiscordbotFetch {
  return async () => new Response("ok", { status });
}

function stubDb(handler: (sql: string) => Record<string, unknown>[]): StatusDb {
  return {
    async query(sql: string) {
      return { rows: handler(sql) };
    },
  };
}

const NOW = Date.parse("2026-08-12T12:00:00Z");

function fullDb(): StatusDb {
  return stubDb((sql) => {
    if (sql.includes("interval '24 hours'")) {
      return [
        { status: "completed", count: 41 },
        { status: "failed", count: 2 },
      ];
    }
    if (sql.includes("IN ('queued', 'running')")) {
      return [
        {
          created_at: new Date(NOW - 120_000),
          duration_seconds: null,
          error: "",
          status: "running",
          thread_key: "discord:1:2:3",
        },
      ];
    }
    if (sql.includes("FROM session_executions")) {
      return [
        {
          created_at: new Date(NOW - 300_000),
          duration_seconds: "63",
          error: "",
          status: "completed",
          thread_key: "github-manage:0xSplits/splits-teams:1799",
        },
        {
          created_at: new Date(NOW - 1_900_000),
          duration_seconds: "12",
          error: "sandbox spawn timeout after 120s",
          status: "failed",
          thread_key: "discord:1:2:9",
        },
      ];
    }
    if (sql.includes("FROM sessions")) {
      return [
        {
          sandbox_id: "asbx-1755000000-1",
          sandbox_last_active_at: new Date(NOW - 60_000),
          thread_key: "discord:1:2:3",
        },
      ];
    }
    if (sql.includes("session_warm_sandboxes")) {
      return [{ status: "ready", count: 2 }];
    }
    return [];
  });
}

describe("collectStatus", () => {
  it("assembles a full report when everything is up", async () => {
    const report = await collectStatus({
      apiUrl: "http://api",
      db: fullDb(),
      fetchFn: healthyFetch(),
      nowMs: NOW,
    });
    expect(report.apiHealthy).toBe(true);
    expect(report.apiReady).toBe(true);
    expect(report.dbOk).toBe(true);
    expect(report.tally).toEqual({ completed: 41, failed: 2 });
    expect(report.recent).toHaveLength(2);
    expect(report.recent[1]?.error).toContain("sandbox spawn timeout");
    expect(report.inFlight).toHaveLength(1);
    expect(report.sandboxes[0]?.sandboxId).toBe("asbx-1755000000-1");
    expect(report.warmPool).toEqual({ ready: 2 });
    expect(report.collectedNotes).toEqual([]);
  });

  it("still reports DB data when api-rs is down", async () => {
    const report = await collectStatus({
      apiUrl: "http://api",
      db: fullDb(),
      fetchFn: async () => {
        throw new Error("connect ECONNREFUSED");
      },
      nowMs: NOW,
    });
    expect(report.apiHealthy).toBe(false);
    expect(report.apiReady).toBe(false);
    expect(report.dbOk).toBe(true);
    expect(report.recent).toHaveLength(2);
  });

  it("still reports api-rs health when the DB is down", async () => {
    const report = await collectStatus({
      apiUrl: "http://api",
      db: stubDb(() => {
        throw new Error("password authentication failed");
      }),
      fetchFn: healthyFetch(),
      nowMs: NOW,
    });
    expect(report.apiHealthy).toBe(true);
    expect(report.dbOk).toBe(false);
    expect(report.collectedNotes.length).toBeGreaterThan(0);
    expect(report.recent).toEqual([]);
  });

  it("handles a missing database configuration", async () => {
    const report = await collectStatus({
      apiUrl: "http://api",
      db: null,
      fetchFn: healthyFetch(),
      nowMs: NOW,
    });
    expect(report.dbOk).toBe(false);
    expect(report.recent).toEqual([]);
  });
});

describe("formatStatus", () => {
  const baseReport = (): StatusReport => ({
    apiHealthy: true,
    apiReady: true,
    collectedNotes: [],
    dbOk: true,
    inFlight: [],
    recent: [],
    sandboxes: [],
    tally: {},
    warmPool: {},
  });

  it("renders a code-block table with tags, tallies, and sandboxes", async () => {
    const report = await collectStatus({
      apiUrl: "http://api",
      db: fullDb(),
      fetchFn: healthyFetch(),
      nowMs: NOW,
    });
    const text = formatStatus(report);
    // Header outside the block, data inside one fenced block.
    expect(text.startsWith("**gerard status** · api-rs ✅")).toBe(true);
    expect(text).toContain("```");
    expect(text).toContain("24h: 41 ok · 2 FAIL");
    // In-flight row first, no duration yet.
    const lines = text.split("\n");
    const runLine = lines.find((line) => line.startsWith("run"));
    expect(runLine).toContain("discord 1:2:3");
    expect(runLine?.trimEnd().endsWith("-")).toBe(true);
    // Settled rows keep the platform on over-wide keys and carry age+duration.
    expect(text).toContain("github-manage …");
    expect(text).toMatch(/ok\s+github-manage .*\s5m\s+1m/);
    // Errors land on their own indented line.
    expect(text).toContain("└ sandbox spawn timeout");
    expect(text).toContain("sandboxes: 1 active · warm: 2 ready");
    expect(text.length).toBeLessThanOrEqual(2000);
  });

  it("keeps thread rows within the column budget", () => {
    const report = baseReport();
    report.recent = [
      {
        ageSeconds: 60,
        durationSeconds: 30,
        error: "",
        status: "completed",
        threadKey: `discord:${"9".repeat(60)}`,
      },
    ];
    const text = formatStatus(report);
    const row = text.split("\n").find((line) => line.startsWith("ok"));
    expect(row).toBeDefined();
    expect(row).toContain("discord …");
    expect(row?.length ?? 0).toBeLessThanOrEqual(50);
  });

  it("marks a down api-rs and unreachable DB honestly", () => {
    const report = baseReport();
    report.apiHealthy = false;
    report.apiReady = false;
    report.dbOk = false;
    const text = formatStatus(report);
    expect(text).toContain("api-rs ❌");
    expect(text).toContain("db ❌");
    expect(text).toContain("session database unreachable");
  });

  it("stays under the Discord cap with oversized errors", () => {
    const report = baseReport();
    report.recent = Array.from({ length: 30 }, (_, index) => ({
      ageSeconds: 60 * index,
      durationSeconds: 5,
      error: "x".repeat(150),
      status: "failed",
      threadKey: `discord:${"y".repeat(80)}:${index}`,
    }));
    const text = formatStatus(report);
    expect(text.length).toBeLessThanOrEqual(2000);
    expect(text.endsWith("```")).toBe(true);
    expect(text).toContain("[truncated]");
  });
});
