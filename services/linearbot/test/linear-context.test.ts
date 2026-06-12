import { describe, expect, test } from "bun:test";
import type { Message as ChatMessage, MessageSubject } from "chat";
import { buildLinearContextMessage } from "../src/linear-context";
import { noopLogger } from "../src/utils";

function fakeMessage(input: {
  raw?: unknown;
  subject?: MessageSubject | null;
  subjectError?: Error;
  threadId?: string;
}): ChatMessage {
  return {
    id: "comment-1",
    threadId: input.threadId ?? "linear:issue-1:s:sess-1",
    raw: input.raw ?? {},
    metadata: { dateSent: new Date("2026-06-10T00:00:00.000Z") },
    get subject() {
      if (input.subjectError) return Promise.reject(input.subjectError);
      return Promise.resolve(input.subject ?? null);
    },
  } as unknown as ChatMessage;
}

describe("buildLinearContextMessage", () => {
  test("prefers Linear's promptContext blob from the webhook", async () => {
    const message = fakeMessage({
      raw: {
        kind: "agent_session_comment",
        agentSessionId: "sess-1",
        agentSessionPromptContext:
          "Issue ENG-1: Fix the bug\n\nDescription...\n\nComments...",
      },
      subject: {
        type: "issue",
        id: "ENG-1",
        title: "should not be used",
      } as MessageSubject,
    });
    const context = await buildLinearContextMessage(message, noopLogger);
    expect(context).not.toBeNull();
    expect(context?.text).toContain("[Linear issue context]");
    expect(context?.text).toContain("Issue ENG-1: Fix the bug");
    expect(context?.text).not.toContain("should not be used");
    expect(context?.id).toBe("linear-context-sess-1");
    expect(context?.author.isBot).toBe(true);
    expect(context?.author.isMe).toBe(false);
    expect(context?.isMention).toBe(false);
    expect(context?.timestamp).toBe("2026-06-10T00:00:00.000Z");
  });

  test("falls back to the issue subject when promptContext is absent", async () => {
    const message = fakeMessage({
      raw: { kind: "comment" },
      threadId: "linear:issue-1:c:comment-1",
      subject: {
        type: "issue",
        id: "ENG-42",
        title: "Streaming breaks on long answers",
        description: "Steps to reproduce...",
        status: "In Progress",
        url: "https://linear.app/acme/issue/ENG-42",
        assignee: { id: "u1", name: "ada" },
        labels: ["bug", "p1"],
      } as MessageSubject,
    });
    const context = await buildLinearContextMessage(message, noopLogger);
    expect(context).not.toBeNull();
    expect(context?.text).toContain("ENG-42: Streaming breaks on long answers");
    expect(context?.text).toContain("Status: In Progress");
    expect(context?.text).toContain("Assignee: ada");
    expect(context?.text).toContain("Labels: bug, p1");
    expect(context?.text).toContain("Description:\nSteps to reproduce...");
    expect(context?.id).toBe("linear-context-issue-1");
  });

  test("returns null when neither promptContext nor subject is available", async () => {
    const message = fakeMessage({ raw: { kind: "comment" }, subject: null });
    expect(await buildLinearContextMessage(message, noopLogger)).toBeNull();
  });

  test("never throws when the subject fetch fails", async () => {
    const message = fakeMessage({
      raw: { kind: "comment" },
      subjectError: new Error("graphql down"),
    });
    expect(await buildLinearContextMessage(message, noopLogger)).toBeNull();
  });

  test("truncates oversized context with an honest notice", async () => {
    const message = fakeMessage({
      raw: {
        kind: "agent_session_comment",
        agentSessionId: "sess-1",
        agentSessionPromptContext: "x".repeat(200_000),
      },
    });
    const context = await buildLinearContextMessage(message, noopLogger);
    expect(context?.text.length).toBeLessThanOrEqual(100_000);
    expect(context?.text).toContain("[truncated");
  });
});
