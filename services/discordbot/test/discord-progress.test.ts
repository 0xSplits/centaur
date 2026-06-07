import { describe, expect, it } from "bun:test";
import type { Logger, Thread } from "chat";
import {
  DiscordProgressMessage,
  DiscordProgressTimeline,
  isCommandExecutionTask,
} from "../src/discord-progress";

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};

function task(input: {
  id: string;
  title: string;
  status?: "pending" | "in_progress" | "complete" | "error";
  details?: string;
}): {
  type: "task_update";
  id: string;
  title: string;
  status: "pending" | "in_progress" | "complete" | "error";
  details?: string;
} {
  return {
    type: "task_update",
    id: input.id,
    title: input.title,
    status: input.status ?? "in_progress",
    ...(input.details ? { details: input.details } : {}),
  };
}

describe("DiscordProgressTimeline", () => {
  it("renders just the placeholder before any steps", () => {
    const timeline = new DiscordProgressTimeline("✨ thinking...");
    expect(timeline.render()).toBe("✨ thinking...");
  });

  it("renders steps with status emoji and updates them in place by id", () => {
    const timeline = new DiscordProgressTimeline("✨ thinking...");
    timeline.update(task({ id: "t1", title: "Searching documents" }));
    expect(timeline.render()).toBe("✨ thinking...\n\n⏳ Searching documents");

    timeline.update(
      task({ id: "t1", title: "Searching documents", status: "complete" }),
    );
    expect(timeline.render()).toBe("✨ thinking...\n\n✅ Searching documents");
  });

  it("merges consecutive Thinking updates into one step with a quoted snippet", () => {
    const timeline = new DiscordProgressTimeline("✨ thinking...");
    timeline.update(
      task({ id: "reasoning-1", title: "Thinking", details: "Comparing the " }),
    );
    timeline.update(
      task({
        id: "reasoning-2",
        title: "Thinking",
        details: "deploy manifests",
      }),
    );

    expect(timeline.render()).toBe(
      "✨ thinking...\n\n⏳ Thinking\n> Comparing the deploy manifests",
    );
  });

  it("starts a fresh Thinking step after another task and quotes only the latest", () => {
    const timeline = new DiscordProgressTimeline("✨ thinking...");
    timeline.update(
      task({
        id: "reasoning-1",
        title: "Thinking",
        status: "complete",
        details: "First thought",
      }),
    );
    timeline.update(
      task({ id: "cmd-1", title: "Command execution", status: "complete" }),
    );
    timeline.update(
      task({ id: "reasoning-2", title: "Thinking", details: "Second thought" }),
    );

    expect(timeline.render()).toBe(
      [
        "✨ thinking...",
        "",
        "✅ Thinking",
        "✅ Command execution",
        "⏳ Thinking",
        "> Second thought",
      ].join("\n"),
    );
  });

  it("shows a one-line command preview from fenced details", () => {
    const timeline = new DiscordProgressTimeline("✨ thinking...");
    timeline.update(
      task({
        id: "cmd-1",
        title: "Command execution (1)",
        details: "```sh\ngit log --oneline\n```",
      }),
    );
    expect(timeline.render()).toBe(
      "✨ thinking...\n\n⏳ Command execution (1): `git log --oneline`",
    );
  });

  it("renders the latest plan title under the header", () => {
    const timeline = new DiscordProgressTimeline("✨ thinking...");
    timeline.update({ type: "plan_update", title: "Investigate the bug" });
    timeline.update(task({ id: "t1", title: "Thinking" }));
    expect(timeline.render()).toBe(
      "✨ thinking...\n*Investigate the bug*\n\n⏳ Thinking",
    );
  });

  it("drops oldest steps and counts them once the message would overflow", () => {
    const timeline = new DiscordProgressTimeline("✨ thinking...");
    for (let index = 0; index < 60; index++) {
      timeline.update(
        task({
          id: `t${index}`,
          title: `Step ${index} ${"x".repeat(60)}`,
          status: "complete",
        }),
      );
    }
    const content = timeline.render();
    expect(content.length).toBeLessThanOrEqual(1_900);
    expect(content).toMatch(/\*… \d+ earlier steps\*/);
    expect(content).toContain("Step 59");
    expect(content).not.toContain("Step 0 ");
  });

  it("finish('done') completes open steps and flips the header", () => {
    const timeline = new DiscordProgressTimeline("✨ thinking...");
    timeline.update(task({ id: "t1", title: "Thinking" }));
    timeline.finish("done", 42_000);
    expect(timeline.render()).toBe("✅ **Done** · 42s\n\n✅ Thinking");
  });

  it("finish('done') downgrades to failed when a step errored", () => {
    const timeline = new DiscordProgressTimeline("✨ thinking...");
    timeline.update(
      task({ id: "t1", title: "Execution failed", status: "error" }),
    );
    timeline.finish("done", 90_500);
    expect(timeline.render()).toBe(
      "❌ **Failed** · 1m 31s\n\n❌ Execution failed",
    );
  });

  it("finish('retrying') keeps step statuses as they were", () => {
    const timeline = new DiscordProgressTimeline("✨ thinking...");
    timeline.update(task({ id: "t1", title: "Thinking" }));
    timeline.finish("retrying", 5_000);
    expect(timeline.render()).toBe(
      "🔁 **Stream interrupted — retrying...**\n\n⏳ Thinking",
    );
  });

  it("ignores updates after finish", () => {
    const timeline = new DiscordProgressTimeline("✨ thinking...");
    timeline.finish("done", 1_000);
    timeline.update(task({ id: "t1", title: "Thinking" }));
    expect(timeline.render()).toBe("✅ **Done** · 1s");
  });
});

type FakeCall =
  | { kind: "post"; threadId: string; message: unknown }
  | { kind: "edit"; threadId: string; messageId: string; message: unknown };

function fakeThread(input?: { failEdits?: boolean }): {
  thread: Thread;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];
  const adapter = {
    postMessage: async (threadId: string, message: unknown) => {
      calls.push({ kind: "post", threadId, message });
      return { id: "m1", raw: {}, threadId };
    },
    editMessage: async (
      threadId: string,
      messageId: string,
      message: unknown,
    ) => {
      if (input?.failEdits) throw new Error("edit failed");
      calls.push({ kind: "edit", threadId, messageId, message });
      return { id: messageId, raw: {}, threadId };
    },
  };
  return {
    thread: { id: "thread-1", adapter } as unknown as Thread,
    calls,
  };
}

describe("DiscordProgressMessage", () => {
  it("posts the placeholder immediately and finalizes via edit", async () => {
    const { thread, calls } = fakeThread();
    const progress = await DiscordProgressMessage.post(thread, {
      editIntervalMs: 1,
      logger: silentLogger,
      placeholderText: "✨ thinking...",
    });
    expect(calls).toEqual([
      { kind: "post", threadId: "thread-1", message: "✨ thinking..." },
    ]);

    progress.update(task({ id: "t1", title: "Thinking" }));
    await progress.finish("done");

    const edits = calls.filter((call) => call.kind === "edit");
    expect(edits.length).toBeGreaterThanOrEqual(1);
    const lastEdit = edits.at(-1);
    expect(lastEdit?.messageId).toBe("m1");
    expect(lastEdit?.message).toEqual({
      markdown: expect.stringContaining("✅ **Done**"),
    });
  });

  it("throttles edits to one per interval", async () => {
    const { thread, calls } = fakeThread();
    const progress = await DiscordProgressMessage.post(thread, {
      editIntervalMs: 30,
      logger: silentLogger,
      placeholderText: "✨ thinking...",
    });
    for (let index = 0; index < 10; index++) {
      progress.update(task({ id: `t${index}`, title: `Step ${index}` }));
    }
    await new Promise((resolve) => setTimeout(resolve, 45));
    const editsBeforeFinish = calls.filter((call) => call.kind === "edit");
    expect(editsBeforeFinish).toHaveLength(1);
    await progress.finish("done");
  });

  it("swallows edit failures", async () => {
    const { thread } = fakeThread({ failEdits: true });
    const progress = await DiscordProgressMessage.post(thread, {
      editIntervalMs: 1,
      logger: silentLogger,
      placeholderText: "✨ thinking...",
    });
    progress.update(task({ id: "t1", title: "Thinking" }));
    await expect(progress.finish("done")).resolves.toBeUndefined();
  });

  it("ignores updates after finish", async () => {
    const { thread, calls } = fakeThread();
    const progress = await DiscordProgressMessage.post(thread, {
      editIntervalMs: 1,
      logger: silentLogger,
      placeholderText: "✨ thinking...",
    });
    await progress.finish("done");
    const editCount = calls.filter((call) => call.kind === "edit").length;
    progress.update(task({ id: "t1", title: "Thinking" }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls.filter((call) => call.kind === "edit")).toHaveLength(
      editCount,
    );
  });
});

describe("isCommandExecutionTask", () => {
  it("matches call_ ids and command execution titles", () => {
    expect(isCommandExecutionTask({ id: "call_1", title: "Tool" })).toBe(true);
    expect(
      isCommandExecutionTask({ id: "x", title: "Command execution (2)" }),
    ).toBe(true);
    expect(isCommandExecutionTask({ id: "x", title: "Thinking" })).toBe(false);
  });
});
