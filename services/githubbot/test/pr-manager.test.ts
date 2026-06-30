import { describe, expect, test } from "bun:test";
import {
  decideMerge,
  evaluateCi,
  isOwnedPr,
  type CiCheck,
} from "../src/pr-manager";

describe("evaluateCi", () => {
  test("not settled while any check is in progress", () => {
    const checks: CiCheck[] = [
      { name: "build", status: "completed", conclusion: "success" },
      { name: "test", status: "in_progress", conclusion: null },
    ];
    expect(evaluateCi(checks, [])).toMatchObject({ settled: false });
  });

  test("settled + green when all checks succeed", () => {
    const checks: CiCheck[] = [
      { name: "build", status: "completed", conclusion: "success" },
      { name: "test", status: "completed", conclusion: "skipped" },
    ];
    expect(evaluateCi(checks, [])).toEqual({
      settled: true,
      failed: false,
      failingNames: [],
    });
  });

  test("settled + red, collecting failing names from checks and statuses", () => {
    const checks: CiCheck[] = [
      { name: "build", status: "completed", conclusion: "success" },
      { name: "lint", status: "completed", conclusion: "failure" },
      { name: "e2e", status: "completed", conclusion: "timed_out" },
    ];
    const result = evaluateCi(checks, [
      { state: "success", context: "coverage" },
      { state: "error", context: "deploy-preview" },
    ]);
    expect(result.settled).toBe(true);
    expect(result.failed).toBe(true);
    expect(result.failingNames.sort()).toEqual(["deploy-preview", "e2e", "lint"]);
  });

  test("pending legacy status keeps it unsettled", () => {
    const result = evaluateCi(
      [{ name: "build", status: "completed", conclusion: "success" }],
      [{ state: "pending", context: "deploy" }],
    );
    expect(result.settled).toBe(false);
  });
});

describe("isOwnedPr", () => {
  test("owned when the bot is an assignee (case-insensitive)", () => {
    expect(
      isOwnedPr({
        assignees: ["someone-else", "Centaur-Bot"],
        userName: "centaur-bot",
      }),
    ).toBe(true);
  });

  test("not owned when the bot is not an assignee", () => {
    expect(
      isOwnedPr({
        assignees: ["someone-else"],
        userName: "centaur-bot",
      }),
    ).toBe(false);
  });

  test("not owned when there are no assignees", () => {
    expect(isOwnedPr({ assignees: [], userName: "centaur-bot" })).toBe(false);
  });
});

describe("decideMerge", () => {
  const base = {
    autoMerge: true,
    draft: false,
    holdLabel: "do-not-merge",
    labels: [] as string[],
    merged: false,
    mergeableState: "clean",
    state: "open",
  };

  test("merges a clean, open, non-draft PR", () => {
    expect(decideMerge(base)).toBe("merge");
  });

  test("respects the global disable switch", () => {
    expect(decideMerge({ ...base, autoMerge: false })).toBe("skip_disabled");
  });

  test("respects the per-PR hold label (case-insensitive)", () => {
    expect(decideMerge({ ...base, labels: ["Do-Not-Merge"] })).toBe("skip_hold");
  });

  test("does not merge drafts or closed/merged PRs", () => {
    expect(decideMerge({ ...base, draft: true })).toBe("skip_draft");
    expect(decideMerge({ ...base, merged: true })).toBe("skip_closed");
    expect(decideMerge({ ...base, state: "closed" })).toBe("skip_closed");
  });

  test("routes dirty -> conflict and behind -> update", () => {
    expect(decideMerge({ ...base, mergeableState: "dirty" })).toBe("resolve_conflict");
    expect(decideMerge({ ...base, mergeableState: "behind" })).toBe("update_branch");
  });

  test("waits on blocked/unstable/unknown states", () => {
    expect(decideMerge({ ...base, mergeableState: "blocked" })).toBe("wait");
    expect(decideMerge({ ...base, mergeableState: "unstable" })).toBe("wait");
    expect(decideMerge({ ...base, mergeableState: "unknown" })).toBe("wait");
  });
});
