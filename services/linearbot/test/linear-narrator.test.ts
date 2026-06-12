import { describe, expect, test } from "bun:test";
import type { Thread } from "chat";
import { ackWorking, LinearNarrator } from "../src/linear-narrator";
import type { LinearAgentActivityContent } from "../src/types";
import { noopLogger } from "../src/utils";

type RecordedActivity = {
  agentSessionId: string;
  content: LinearAgentActivityContent;
  ephemeral?: boolean;
};

function fakeThread(threadId = "linear:issue-1:s:sess-1") {
  const activities: RecordedActivity[] = [];
  const typing: Array<{ status?: string; threadId: string }> = [];
  const thread = {
    id: threadId,
    adapter: {
      linearClient: {
        createAgentActivity: async (input: RecordedActivity) => {
          activities.push(input);
          return { success: true };
        },
      },
      startTyping: async (id: string, status?: string) => {
        typing.push({ status, threadId: id });
      },
    },
  } as unknown as Thread;
  return { activities, thread, typing };
}

function thinking(
  id: string,
  details: string,
  status: "in_progress" | "complete" = "in_progress",
) {
  return {
    type: "task_update" as const,
    id,
    title: "Thinking",
    status,
    details,
  };
}

describe("ackWorking", () => {
  test("fires an ephemeral working thought via startTyping", async () => {
    const { thread, typing } = fakeThread();
    ackWorking(thread, noopLogger);
    await Bun.sleep(0);
    expect(typing).toHaveLength(1);
    expect(typing[0]?.threadId).toBe("linear:issue-1:s:sess-1");
  });

  test("never throws when typing fails", async () => {
    const thread = {
      id: "linear:issue-1:s:sess-1",
      adapter: {
        startTyping: async () => {
          throw new Error("no session");
        },
      },
    } as unknown as Thread;
    expect(() => ackWorking(thread, noopLogger)).not.toThrow();
    await Bun.sleep(0);
  });
});

describe("LinearNarrator", () => {
  test("posts a completed thought as a persistent thought activity", async () => {
    const { activities, thread } = fakeThread();
    const narrator = LinearNarrator.start(thread, {
      logger: noopLogger,
      minPostGapMs: 0,
    });
    // Reasoning deltas carry unique chunk ids and concatenate (a same-id
    // commentary chunk would replace its body instead).
    narrator.update(thinking("t1", "Reading the issue and the linked PR"));
    narrator.update(
      thinking("t2", " to understand the failure mode.", "complete"),
    );
    await narrator.finish("done");
    expect(activities).toHaveLength(1);
    expect(activities[0]?.content).toEqual({
      type: "thought",
      body: "Reading the issue and the linked PR to understand the failure mode.",
    });
    expect(activities[0]?.ephemeral).toBeUndefined();
    expect(activities[0]?.agentSessionId).toBe("sess-1");
  });

  test("a tool task flushes the pending thought and posts an action", async () => {
    const { activities, thread } = fakeThread();
    const narrator = LinearNarrator.start(thread, {
      logger: noopLogger,
      minPostGapMs: 0,
    });
    narrator.update(thinking("t1", "I should inspect the failing test first"));
    narrator.update({
      type: "task_update",
      id: "cmd-1",
      title: "bun test session-api",
      status: "in_progress",
      details: "$ bun test session-api",
    });
    narrator.update({
      type: "task_update",
      id: "cmd-1",
      title: "bun test session-api",
      status: "complete",
      details: "$ bun test session-api",
      output: "12 pass, 0 fail",
    });
    await narrator.finish("done");
    const kinds = activities.map(
      (activity) => `${activity.content.type}:${activity.ephemeral === true}`,
    );
    expect(kinds).toEqual(["thought:false", "action:true", "action:false"]);
    const completed = activities[2]?.content;
    expect(completed?.type).toBe("action");
    if (completed?.type === "action") {
      expect(completed.action).toBe("bun test session-api");
      expect(completed.result).toBe("12 pass, 0 fail");
    }
  });

  test("merges thoughts queued within the min post gap into one activity", async () => {
    const { activities, thread } = fakeThread();
    const narrator = LinearNarrator.start(thread, {
      logger: noopLogger,
      minPostGapMs: 60_000,
    });
    narrator.update(
      thinking("t1", "First complete reflection on the issue", "complete"),
    );
    narrator.update(
      thinking("t2", "Second complete reflection on the issue", "complete"),
    );
    await narrator.finish("done");
    expect(activities).toHaveLength(1);
    expect(activities[0]?.content.type).toBe("thought");
    if (activities[0]?.content.type === "thought") {
      expect(activities[0].content.body).toContain("First complete reflection");
      expect(activities[0].content.body).toContain(
        "Second complete reflection",
      );
    }
  });

  test("drops persistent activities past the budget", async () => {
    const { activities, thread } = fakeThread();
    const narrator = LinearNarrator.start(thread, {
      logger: noopLogger,
      maxActivities: 2,
      minPostGapMs: 0,
    });
    for (let index = 0; index < 5; index++) {
      narrator.update(
        thinking(
          `t${index}`,
          `Standalone reflection number ${index} here`,
          "complete",
        ),
      );
      await Bun.sleep(1);
    }
    await narrator.finish("done");
    expect(activities.filter((a) => !a.ephemeral)).toHaveLength(2);
  });

  test("an error task downgrades done to a terminal error activity", async () => {
    const { activities, thread } = fakeThread();
    const narrator = LinearNarrator.start(thread, {
      logger: noopLogger,
      minPostGapMs: 0,
    });
    narrator.update({
      type: "task_update",
      id: "err-1",
      title: "Execution failed",
      status: "error",
      output: "sandbox spawn failed",
    });
    expect(narrator.failed).toBe(true);
    await narrator.finish("done", "Execution failed: sandbox spawn failed");
    const last = activities[activities.length - 1];
    expect(last?.content.type).toBe("error");
    if (last?.content.type === "error") {
      expect(last.content.body).toContain("sandbox spawn failed");
    }
  });

  test("retrying outcome posts no terminal activity", async () => {
    const { activities, thread } = fakeThread();
    const narrator = LinearNarrator.start(thread, {
      logger: noopLogger,
      minPostGapMs: 0,
    });
    narrator.update({
      type: "task_update",
      id: "err-1",
      title: "Stream broke",
      status: "error",
    });
    await narrator.finish("retrying");
    expect(activities.filter((a) => a.content.type === "error")).toHaveLength(
      0,
    );
  });

  test("is inert on plain comment threads", async () => {
    const { activities, thread } = fakeThread("linear:issue-1:c:comment-1");
    const narrator = LinearNarrator.start(thread, {
      logger: noopLogger,
      minPostGapMs: 0,
    });
    narrator.update(
      thinking("t1", "A reflection that would normally post", "complete"),
    );
    await narrator.finish("failed", "boom");
    expect(activities).toHaveLength(0);
  });

  test("activity failures are swallowed (narration is cosmetic)", async () => {
    const thread = {
      id: "linear:issue-1:s:sess-1",
      adapter: {
        linearClient: {
          createAgentActivity: async () => {
            throw new Error("linear 500");
          },
        },
      },
    } as unknown as Thread;
    const narrator = LinearNarrator.start(thread as Thread, {
      logger: noopLogger,
      minPostGapMs: 0,
    });
    narrator.update(
      thinking("t1", "A reflection that will fail to post", "complete"),
    );
    await narrator.finish("failed", "boom");
  });

  test("plan updates flush the pending thought", async () => {
    const { activities, thread } = fakeThread();
    const narrator = LinearNarrator.start(thread, {
      logger: noopLogger,
      minPostGapMs: 0,
    });
    narrator.update(thinking("t1", "Sketching out the implementation plan"));
    narrator.update({ type: "plan_update", title: "Implementation plan" });
    await narrator.finish("done");
    expect(activities).toHaveLength(1);
    expect(activities[0]?.content.type).toBe("thought");
  });
});
