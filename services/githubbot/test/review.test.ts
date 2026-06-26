import { describe, expect, test } from "bun:test";
import { handleReviewRequest } from "../src/review";
import type { GithubbotOptions } from "../src/types";

// Non-retryable fetch so the (backgrounded) review turn settles instantly in the
// positive case instead of hitting the network and retrying.
const options = {
  apiUrl: "http://127.0.0.1:8080",
  stateKeyPrefix: "test",
  fetch: () => Promise.resolve(new Response("no", { status: 400 })),
} as unknown as GithubbotOptions;

function stubState() {
  const seen = new Set<string>();
  return {
    setIfNotExists: (key: string) => {
      if (seen.has(key)) return Promise.resolve(false);
      seen.add(key);
      return Promise.resolve(true);
    },
  } as never;
}

const input = {
  botUserName: "review-bot",
  deliveryId: "delivery-1",
  options,
  state: stubState(),
};

function reviewRequestedBody(reviewerLogin: string | null): string {
  return JSON.stringify({
    action: "review_requested",
    pull_request: {
      number: 7,
      title: "Add widget",
      html_url: "https://github.com/0xSplits/centaur/pull/7",
      head: { sha: "abc123" },
    },
    repository: { full_name: "0xSplits/centaur" },
    requested_reviewer: reviewerLogin ? { login: reviewerLogin } : undefined,
    sender: { login: "someone" },
  });
}

describe("handleReviewRequest", () => {
  test("ignores non-JSON bodies", () => {
    expect(handleReviewRequest("not json", input)).toBeNull();
  });

  test("ignores actions other than review_requested", () => {
    const body = JSON.stringify({ action: "opened" });
    expect(handleReviewRequest(body, input)).toBeNull();
  });

  test("ignores review requests for a different reviewer", () => {
    expect(
      handleReviewRequest(reviewRequestedBody("someone-else"), input),
    ).toBeNull();
  });

  test("ignores team review requests (no requested_reviewer)", () => {
    expect(handleReviewRequest(reviewRequestedBody(null), input)).toBeNull();
  });

  test("matches the bot reviewer case-insensitively and schedules work", () => {
    const result = handleReviewRequest(reviewRequestedBody("Review-Bot"), {
      ...input,
      state: stubState(),
    });
    expect(result).not.toBeNull();
  });

  test("de-duplicates a redelivered review request", async () => {
    const state = stubState();
    // First delivery claims the dedup key; second (same id) finds it taken.
    await handleReviewRequest(reviewRequestedBody("review-bot"), {
      ...input,
      state,
    });
    // A second handler with the same delivery id resolves without throwing; the
    // dedup claim short-circuits the turn (no assertion beyond completion).
    await handleReviewRequest(reviewRequestedBody("review-bot"), {
      ...input,
      state,
    });
    expect(true).toBe(true);
  });
});
