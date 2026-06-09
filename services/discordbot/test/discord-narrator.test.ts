import { describe, expect, it } from "bun:test";
import type { Logger, Thread } from "chat";
import { DiscordNarrator } from "../src/discord-narrator";
import type {
  DiscordbotApiMessage,
  DiscordbotFetch,
  DiscordbotOptions,
} from "../src/types";

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};

const EYES = encodeURIComponent("👀");
const CHECK = encodeURIComponent("✅");
const CROSS = encodeURIComponent("❌");

function task(input: {
  id: string;
  title: string;
  status?: "pending" | "in_progress" | "complete" | "error";
  details?: string;
  output?: string;
}): {
  type: "task_update";
  id: string;
  title: string;
  status: "pending" | "in_progress" | "complete" | "error";
  details?: string;
  output?: string;
} {
  return {
    type: "task_update",
    id: input.id,
    title: input.title,
    status: input.status ?? "in_progress",
    ...(input.details ? { details: input.details } : {}),
    ...(input.output ? { output: input.output } : {}),
  };
}

function apiMessage(
  input?: Partial<DiscordbotApiMessage>,
): DiscordbotApiMessage {
  return {
    attachments: [],
    author: {
      fullName: "User",
      isBot: false,
      isMe: false,
      userId: "U1",
      userName: "user",
    },
    id: "M1",
    isMention: true,
    raw: {},
    text: "hello",
    threadId: "discord:G1:C1:T9",
    timestamp: "2026-06-07T00:00:00.000Z",
    ...input,
  };
}

type CapturedPost = {
  markdown: string;
  files: Array<{ filename: string; mimeType?: string; text: string }>;
};

type Harness = {
  thread: Thread;
  message: DiscordbotApiMessage;
  botOptions: DiscordbotOptions;
  posts: CapturedPost[];
  reactions: Array<{ method: string; url: string }>;
};

function harness(input?: {
  threadKey?: string;
  messageId?: string;
  failPosts?: boolean;
  failReactions?: boolean;
}): Harness {
  const posts: CapturedPost[] = [];
  const reactions: Array<{ method: string; url: string }> = [];
  const threadKey = input?.threadKey ?? "discord:G1:C1:T9";
  const adapter = {
    postMessage: async (_threadId: string, message: unknown) => {
      if (input?.failPosts) throw new Error("post failed");
      const postable = message as {
        markdown?: string;
        files?: Array<{
          data: Buffer;
          filename: string;
          mimeType?: string;
        }>;
      };
      posts.push({
        markdown: postable.markdown ?? "",
        files: (postable.files ?? []).map((file) => ({
          filename: file.filename,
          mimeType: file.mimeType,
          text: file.data.toString("utf8"),
        })),
      });
      return { id: `m${posts.length}`, raw: {}, threadId: threadKey };
    },
  };
  const fetchFn = (async (url: RequestInfo | URL, init?: RequestInit) => {
    if (input?.failReactions) throw new Error("network down");
    reactions.push({ method: init?.method ?? "GET", url: String(url) });
    return new Response(null, { status: 204 });
  }) as DiscordbotFetch;
  return {
    thread: { id: threadKey, adapter } as unknown as Thread,
    message: apiMessage({ id: input?.messageId ?? "M1", threadId: threadKey }),
    botOptions: {
      apiUrl: "http://localhost",
      applicationId: "app",
      botToken: "bot-token",
      publicKey: "key",
      discordApiUrl: "https://discord.com/api/v10",
      fetch: fetchFn,
    },
    posts,
    reactions,
  };
}

function startNarrator(h: Harness): DiscordNarrator {
  return DiscordNarrator.start(h.thread, h.message, h.botOptions, {
    logger: silentLogger,
  });
}

function traceOf(h: Harness): string {
  expect(h.posts).toHaveLength(1);
  expect(h.posts[0]?.files).toHaveLength(1);
  return h.posts[0]?.files[0]?.text ?? "";
}

describe("DiscordNarrator reactions", () => {
  it("adds 👀 to a message inside the thread via the thread channel", async () => {
    const h = harness();
    const narrator = startNarrator(h);
    await narrator.finish("done");

    expect(h.reactions[0]).toEqual({
      method: "PUT",
      url: `https://discord.com/api/v10/channels/T9/messages/M1/reactions/${EYES}/@me`,
    });
  });

  it("routes a thread-starter message's reaction to the parent channel", async () => {
    const h = harness({ messageId: "T9" });
    const narrator = startNarrator(h);
    await narrator.finish("done");

    expect(h.reactions[0]?.url).toBe(
      `https://discord.com/api/v10/channels/C1/messages/T9/reactions/${EYES}/@me`,
    );
  });

  it("settles done as ✅ added before 👀 is removed", async () => {
    const h = harness();
    const narrator = startNarrator(h);
    await narrator.finish("done");

    expect(h.reactions.map((r) => `${r.method} ${reactionOf(r.url)}`)).toEqual([
      `PUT ${EYES}`,
      `PUT ${CHECK}`,
      `DELETE ${EYES}`,
    ]);
  });

  it("settles as ❌ when an error task was seen", async () => {
    const h = harness();
    const narrator = startNarrator(h);
    narrator.update(
      task({ id: "err-1", title: "Execution failed", status: "error" }),
    );
    await narrator.finish("done");

    expect(h.reactions.map((r) => `${r.method} ${reactionOf(r.url)}`)).toEqual([
      `PUT ${EYES}`,
      `PUT ${CROSS}`,
      `DELETE ${EYES}`,
    ]);
  });

  it("leaves 👀 in place for a retrying outcome", async () => {
    const h = harness();
    const narrator = startNarrator(h);
    await narrator.finish("retrying");

    expect(h.reactions.map((r) => `${r.method} ${reactionOf(r.url)}`)).toEqual([
      `PUT ${EYES}`,
    ]);
  });

  it("swallows reaction failures", async () => {
    const h = harness({ failReactions: true });
    const narrator = startNarrator(h);
    await expect(narrator.finish("done")).resolves.toBeUndefined();
  });
});

describe("DiscordNarrator reasoning trace", () => {
  it("posts nothing mid-run and attaches the trace as reasoning.txt on finish", async () => {
    const h = harness();
    const narrator = startNarrator(h);
    narrator.update(
      task({
        id: "reasoning-1",
        title: "Thinking",
        status: "complete",
        details: "Comparing the deploy manifests against the defaults",
      }),
    );
    expect(h.posts).toEqual([]);
    await narrator.finish("done");

    expect(h.posts).toHaveLength(1);
    expect(h.posts[0]?.markdown).toBe("Full reasoning trace:");
    expect(h.posts[0]?.files).toEqual([
      {
        filename: "reasoning.txt",
        mimeType: "text/plain",
        text: "[thinking]\nComparing the deploy manifests against the defaults",
      },
    ]);
  });

  it("coalesces reasoning deltas into one thought", async () => {
    const h = harness();
    const narrator = startNarrator(h);
    narrator.update(
      task({ id: "reasoning-1", title: "Thinking", details: "Comparing the " }),
    );
    narrator.update(
      task({
        id: "reasoning-2",
        title: "Thinking",
        status: "complete",
        details: "deploy manifests against the defaults",
      }),
    );
    await narrator.finish("done");

    expect(traceOf(h)).toBe(
      "[thinking]\nComparing the deploy manifests against the defaults",
    );
  });

  it("includes tool calls with details and output, updated in place", async () => {
    const h = harness();
    const narrator = startNarrator(h);
    narrator.update(
      task({
        id: "reasoning-1",
        title: "Thinking",
        details: "Need to check the recent deploy history first",
      }),
    );
    narrator.update(
      task({ id: "cmd-1", title: "Command execution (1)", details: "git log" }),
    );
    narrator.update(
      task({
        id: "cmd-1",
        title: "Command execution (1)",
        status: "complete",
        details: "git log",
        output: "abc123 fix deploy",
      }),
    );
    narrator.update(
      task({
        id: "reasoning-3",
        title: "Thinking",
        status: "complete",
        details: "That commit looks suspicious",
      }),
    );
    await narrator.finish("done");

    expect(traceOf(h)).toBe(
      [
        "[thinking]\nNeed to check the recent deploy history first",
        "[Command execution (1)] (complete)\ngit log\n--- output ---\nabc123 fix deploy",
        "[thinking]\nThat commit looks suspicious",
      ].join("\n\n"),
    );
  });

  it("includes plan updates", async () => {
    const h = harness();
    const narrator = startNarrator(h);
    narrator.update({ type: "plan_update", title: "Investigate" });
    narrator.update(
      task({
        id: "thinking-1",
        title: "Thinking",
        status: "complete",
        details: "Starting with the logs",
      }),
    );
    await narrator.finish("done");

    expect(traceOf(h)).toBe(
      "[plan] Investigate\n\n[thinking]\nStarting with the logs",
    );
  });

  it("flushes the pending thought when the model moves on to a command", async () => {
    const h = harness();
    const narrator = startNarrator(h);
    narrator.update(
      task({
        id: "reasoning-1",
        title: "Thinking",
        details: "Need to check the recent deploy history first",
      }),
    );
    narrator.update(task({ id: "cmd-1", title: "Command execution (1)" }));
    await narrator.finish("done");

    expect(traceOf(h)).toBe(
      [
        "[thinking]\nNeed to check the recent deploy history first",
        "[Command execution (1)] (in_progress)",
      ].join("\n\n"),
    );
  });

  it("posts the partial trace on a retrying outcome", async () => {
    const h = harness();
    const narrator = startNarrator(h);
    narrator.update(
      task({
        id: "reasoning-1",
        title: "Thinking",
        details: "A thought interrupted by a retry",
      }),
    );
    await narrator.finish("retrying");

    expect(traceOf(h)).toBe("[thinking]\nA thought interrupted by a retry");
  });

  it("skips the trace post when nothing was traced", async () => {
    const h = harness();
    const narrator = startNarrator(h);
    await narrator.finish("done");

    expect(h.posts).toEqual([]);
  });

  it("posts the trace before settling reactions", async () => {
    const h = harness();
    const order: string[] = [];
    const originalPost = (h.thread.adapter as { postMessage: unknown })
      .postMessage as (t: string, m: unknown) => Promise<unknown>;
    (h.thread.adapter as { postMessage: unknown }).postMessage = async (
      t: string,
      m: unknown,
    ) => {
      order.push("post");
      return originalPost(t, m);
    };
    const narrator = startNarrator(h);
    narrator.update(
      task({
        id: "reasoning-1",
        title: "Thinking",
        details: "A final trailing thought",
      }),
    );
    await narrator.finish("done");

    expect(traceOf(h)).toBe("[thinking]\nA final trailing thought");
    // ✅ lands after the trace post (reactions chain behind posts).
    const checkIndex = h.reactions.findIndex((r) => r.url.includes(CHECK));
    expect(checkIndex).toBeGreaterThan(-1);
    expect(order).toEqual(["post"]);
  });

  it("ignores updates after finish", async () => {
    const h = harness();
    const narrator = startNarrator(h);
    await narrator.finish("done");
    narrator.update(
      task({
        id: "thinking-1",
        title: "Thinking",
        status: "complete",
        details: "Posthumous thought that should not post",
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.posts).toEqual([]);
  });

  it("swallows trace post failures", async () => {
    const h = harness({ failPosts: true });
    const narrator = startNarrator(h);
    narrator.update(
      task({
        id: "thinking-1",
        title: "Thinking",
        status: "complete",
        details: "A thought that will fail to post",
      }),
    );
    await expect(narrator.finish("done")).resolves.toBeUndefined();
  });
});

function reactionOf(url: string): string {
  const match = url.match(/reactions\/([^/]+)\/@me$/);
  return match?.[1] ?? "";
}
