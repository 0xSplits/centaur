import type { ChatSDKStreamChunk } from "@centaur/rendering";
import { describe, expect, it } from "bun:test";
import {
  buildCommentReplyBody,
  collapsibleSection,
  CommentReplyCollector,
  commentMentionsBot,
} from "../src/comment-bot";

describe("commentMentionsBot", () => {
  it("matches an @-mention of any of the bot names, case-insensitively", () => {
    expect(commentMentionsBot("hey @Gerard can you look?", ["Gerard"])).toBe(
      true,
    );
    expect(commentMentionsBot("@centaur ping", ["centaur", "Gerard"])).toBe(
      true,
    );
    expect(commentMentionsBot("CC @GERARD", ["gerard"])).toBe(true);
  });

  it("does not match the bare name without an @ (avoids prose false positives)", () => {
    expect(
      commentMentionsBot("the centaur library is great", ["centaur"]),
    ).toBe(false);
    expect(commentMentionsBot("no mention here", ["Gerard"])).toBe(false);
  });

  it("ignores blank names", () => {
    expect(commentMentionsBot("@Gerard", ["", "  "])).toBe(false);
  });
});

function markdown(text: string): ChatSDKStreamChunk {
  return { type: "markdown_text", text };
}

function task(
  input: Partial<Extract<ChatSDKStreamChunk, { type: "task_update" }>> & {
    id: string;
    status: "pending" | "in_progress" | "complete" | "error";
  },
): ChatSDKStreamChunk {
  return {
    type: "task_update",
    title: input.title ?? "Command execution",
    ...input,
  };
}

describe("CommentReplyCollector", () => {
  it("accumulates answer markdown and a chain-of-thought from settled tasks", () => {
    const collector = new CommentReplyCollector();
    collector.update(
      task({ id: "t1", status: "in_progress", title: "Thinking" }),
    );
    collector.update(
      task({
        id: "t1",
        status: "complete",
        title: "Thinking",
        details: "Checking the deploy logs",
      }),
    );
    collector.update(
      task({
        id: "t2",
        status: "complete",
        title: "Command execution",
        details: "pnpm test",
      }),
    );
    collector.update(markdown("All "));
    collector.update(markdown("good."));

    expect(collector.answer).toBe("All good.");
    expect(collector.cotLines).toEqual([
      "Checking the deploy logs",
      "Command execution: pnpm test",
    ]);
    expect(collector.failed).toBe(false);
  });

  it("keeps one line per task id even when terminal updates re-emit", () => {
    const collector = new CommentReplyCollector();
    collector.update(task({ id: "t1", status: "complete", details: "ls" }));
    collector.update(task({ id: "t1", status: "complete", details: "ls" }));
    expect(collector.cotLines).toHaveLength(1);
  });

  it("flags failure and captures the error text from an error task", () => {
    const collector = new CommentReplyCollector();
    collector.update(
      task({
        id: "t1",
        status: "error",
        title: "Command execution",
        output: "sandbox exploded",
      }),
    );
    expect(collector.failed).toBe(true);
    expect(collector.errorText).toContain("sandbox exploded");
  });
});

describe("buildCommentReplyBody", () => {
  it("returns the answer alone when there is no chain-of-thought", () => {
    expect(buildCommentReplyBody({ answer: "Yes.", cotLines: [] })).toBe(
      "Yes.",
    );
  });

  it("folds the chain-of-thought into a collapsed section after the answer", () => {
    const body = buildCommentReplyBody({
      answer: "Done.",
      cotLines: ["thought one", "ran a command"],
    });
    expect(body).toBe(
      [
        "Done.",
        "",
        ">>> Chain of thought",
        "- thought one",
        "- ran a command",
      ].join("\n"),
    );
  });

  it("falls back when the answer is empty", () => {
    expect(
      buildCommentReplyBody({ answer: "", cotLines: [], fallback: "terminal" }),
    ).toBe("terminal");
    expect(buildCommentReplyBody({ answer: "  ", cotLines: [] })).toContain(
      "no final text",
    );
  });
});

describe("collapsibleSection", () => {
  it("uses Linear's >>> collapsible shortcut", () => {
    expect(collapsibleSection("Summary", "body")).toBe(">>> Summary\nbody");
  });
});
