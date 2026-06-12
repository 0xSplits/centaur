import { describe, expect, it } from "bun:test";
import {
  isSessionThreadComment,
  issueSessionsKey,
  parseIssueCommentWebhook,
} from "../src/issue-comments";

function commentPayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    action: "create",
    type: "Comment",
    organizationId: "org-1",
    url: "https://linear.app/acme/comment/comment-9",
    data: {
      id: "comment-9",
      body: "actually, hold off on this",
      issueId: "issue-1",
      createdAt: "2026-06-12T00:00:00.000Z",
      updatedAt: "2026-06-12T00:00:00.000Z",
      user: {
        id: "user-1",
        name: "Ada Lovelace",
        email: "ada@example.com",
        url: "https://linear.app/acme/profiles/ada",
      },
      ...overrides,
    },
  });
}

describe("parseIssueCommentWebhook", () => {
  it("parses a user comment-created webhook", () => {
    expect(parseIssueCommentWebhook(commentPayload())).toEqual({
      authorId: "user-1",
      authorName: "Ada Lovelace",
      body: "actually, hold off on this",
      commentId: "comment-9",
      createdAt: "2026-06-12T00:00:00.000Z",
      issueId: "issue-1",
      parentId: undefined,
      url: "https://linear.app/acme/comment/comment-9",
    });
  });

  it("keeps the parent id for thread replies", () => {
    expect(
      parseIssueCommentWebhook(commentPayload({ parentId: "comment-root" }))
        ?.parentId,
    ).toBe("comment-root");
  });

  it("rejects non-comment, non-create, and malformed payloads", () => {
    expect(
      parseIssueCommentWebhook(
        JSON.stringify({ action: "create", type: "AgentSessionEvent" }),
      ),
    ).toBeNull();
    expect(
      parseIssueCommentWebhook(
        JSON.stringify({ action: "update", type: "Comment", data: {} }),
      ),
    ).toBeNull();
    expect(parseIssueCommentWebhook("not json")).toBeNull();
  });

  it("rejects bot/agent comments (botActor, no user) and empty bodies", () => {
    expect(
      parseIssueCommentWebhook(commentPayload({ user: undefined })),
    ).toBeNull();
    expect(parseIssueCommentWebhook(commentPayload({ body: "  " }))).toBeNull();
    expect(
      parseIssueCommentWebhook(commentPayload({ issueId: undefined })),
    ).toBeNull();
  });
});

describe("isSessionThreadComment", () => {
  it("matches the session root comment and replies under it", () => {
    expect(
      isSessionThreadComment(
        { commentId: "comment-root", parentId: undefined },
        "comment-root",
      ),
    ).toBe(true);
    expect(
      isSessionThreadComment(
        { commentId: "comment-9", parentId: "comment-root" },
        "comment-root",
      ),
    ).toBe(true);
  });

  it("does not match foreign comments or unknown roots", () => {
    expect(
      isSessionThreadComment(
        { commentId: "comment-9", parentId: undefined },
        "comment-root",
      ),
    ).toBe(false);
    expect(
      isSessionThreadComment(
        { commentId: "comment-9", parentId: undefined },
        undefined,
      ),
    ).toBe(false);
  });
});

describe("issueSessionsKey", () => {
  it("is namespaced per issue", () => {
    expect(issueSessionsKey("issue-1")).toBe(
      "linearbot:issue-sessions:issue-1",
    );
  });
});
