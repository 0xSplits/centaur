// Linear port of slackbotv2/discordbot's chat-sdk emulate harness. The
// `emulate` package has no Linear service, so this spins up a fake Linear
// GraphQL API (Bun.serve) that the REAL patched @chat-adapter/linear adapter
// talks to, plus a mock api-rs session API; ingress drives signed
// AgentSessionEvent webhooks through the bot's Hono route, so the full chat
// SDK pipeline (signature verification, dedupe, locks, handler routing) runs
// exactly as in production.
//
// Deliberate Linear deltas this harness encodes (NOT bugs):
// - The ack and reasoning surface is Linear agent activities (ephemeral
//   thought ack, persistent thought/action activities), not reactions.
// - The final answer posts exactly once: a `response` activity on success,
//   an `error` activity on failure. Nothing is ever edited.
// - One agent session = ONE thread key (linear:{issue}:s:{session}) across
//   created + prompted events — that is the adapter patch under test.
// - The initial context prepends the synthetic issue-context message built
//   from the webhook's promptContext.
import { createHmac } from "node:crypto";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import { createMemoryState } from "@chat-adapter/state-memory";
import {
  createLinearbot,
  type Linearbot,
  type LinearbotAppendMessagesRequest,
  type LinearbotCreateSessionRequest,
  type LinearbotExecuteSessionRequest,
  type LinearbotOptions,
  type LinearbotSessionMessage,
} from "../src/index";
import { noopLogger } from "../src/utils";

const WEBHOOK_SECRET = "linearbot-emulate-secret";
const ORG_ID = "org-1";
const BOT_USER_ID = "bot-user-1";
const USER_ID = "user-1";
const ISSUE_ID = "issue-1";

let linearApi: FakeLinearApi;
let codexApi: MockSessionApi;
let bot: Linearbot;

beforeAll(async () => {
  linearApi = startFakeLinearApi();
  codexApi = startMockCodexApi();
});

beforeEach(() => {
  linearApi.reset();
  codexApi.reset();
  bot = createTestBot();
});

afterAll(() => {
  codexApi?.close();
  linearApi?.close();
});

function createTestBot(overrides: Partial<LinearbotOptions> = {}): Linearbot {
  const state = overrides.state ?? createMemoryState();
  return createLinearbot({
    apiUrl: codexApi.url,
    linearAccessToken: "linear-emulate-token",
    linearApiUrl: linearApi.url,
    linearWebhookSecret: WEBHOOK_SECRET,
    logger: noopLogger,
    narratorMinPostGapMs: 1,
    recoverRenderObligationsOnStart: false,
    state,
    userName: "centaur",
    ...overrides,
  });
}

describe("linearbot comment-thread pipeline", () => {
  // Assertions filter by this thread's own key / parent comment id: a prior
  // test's detached run can post into the shared mock servers after reset.
  it("answers a comment @-mention with one comment (answer + collapsed CoT) on the comment-thread sandbox", async () => {
    const threadKey = `linear:${ISSUE_ID}:c:comment-q`;
    const res = await postWebhook(
      commentCreatedPayload({
        id: "comment-q",
        body: "@centaur how long will this take?",
      }),
    );
    expect(res.status).toBe(200);

    await waitFor(() =>
      codexApi.executes.some((e) => e.threadKey === threadKey),
    );
    // Issue context is fetched and seeded on the thread's first turn.
    const seeded = codexApi.appends
      .filter((a) => a.threadKey === threadKey)
      .flatMap((a) => sessionMessageTexts(a.body.messages));
    expect(seeded.some((t) => t.includes("[Linear issue context]"))).toBe(true);

    codexApi.emitOutputLines(threadKey, sampleCodexOutputLines("About a day."));

    await waitFor(() =>
      linearApi.botComments.some((c) => c.parentId === "comment-q"),
    );
    const reply = linearApi.botComments.find(
      (c) => c.parentId === "comment-q",
    )!;
    expect(reply.issueId).toBe(ISSUE_ID);
    expect(reply.body).toContain("About a day.");
    expect(reply.body).toContain(">>> Chain of thought");
    expect(reply.body).toContain("pnpm test");
    // The vestigial session is never the surface: no session-keyed execution.
    expect(codexApi.executes.some((e) => e.threadKey.includes(":s:"))).toBe(
      false,
    );
  });

  it("dedupes a redelivered mention comment", async () => {
    const threadKey = `linear:${ISSUE_ID}:c:comment-d`;
    await postWebhook(
      commentCreatedPayload({ id: "comment-d", body: "@centaur ping" }),
    );
    await waitFor(() =>
      codexApi.executes.some((e) => e.threadKey === threadKey),
    );
    codexApi.emitOutputLines(threadKey, sampleCodexOutputLines("Pong."));
    await waitFor(() =>
      linearApi.botComments.some((c) => c.parentId === "comment-d"),
    );

    await Bun.sleep(50);
    await postWebhook(
      commentCreatedPayload({ id: "comment-d", body: "@centaur ping" }),
    );
    await Bun.sleep(100);
    expect(
      linearApi.botComments.filter((c) => c.parentId === "comment-d"),
    ).toHaveLength(1);
  });

  it("ignores a comment that does not mention the bot", async () => {
    await postWebhook(
      commentCreatedPayload({ id: "comment-plain", body: "just a team note" }),
    );
    await Bun.sleep(100);
    expect(
      codexApi.executes.some(
        (e) => e.threadKey === `linear:${ISSUE_ID}:c:comment-plain`,
      ),
    ).toBe(false);
    expect(
      linearApi.botComments.some((c) => c.parentId === "comment-plain"),
    ).toBe(false);
  });

  it("ignores bot-authored comments (loop guard)", async () => {
    await postWebhook(
      commentCreatedPayload({
        id: "comment-self",
        body: "@centaur loop",
        user: null,
      }),
    );
    await Bun.sleep(100);
    expect(
      codexApi.executes.some(
        (e) => e.threadKey === `linear:${ISSUE_ID}:c:comment-self`,
      ),
    ).toBe(false);
  });

  it("runs an agent turn when the issue is assigned to the bot, posting a comment + applying status", async () => {
    const threadKey = `linear:${ISSUE_ID}`;
    const res = await postWebhook(
      issueAssignmentPayload({ updatedAt: "2026-06-16T00:00:00.000Z" }),
    );
    expect(res.status).toBe(200);

    await waitFor(() =>
      codexApi.executes.some((e) => e.threadKey === threadKey),
    );
    // The synthetic "work this issue" instruction is the execute prompt.
    const exec = codexApi.executes.find((e) => e.threadKey === threadKey)!;
    const inputLine = JSON.parse(exec.body.input_lines[0]!) as {
      message: { content: Array<{ text?: string }> };
    };
    expect(
      inputLine.message.content.some((c) =>
        (c.text ?? "").includes("work the task"),
      ),
    ).toBe(true);

    codexApi.emitOutputLines(
      threadKey,
      sampleCodexOutputLines("Shipped.\n\nLinear-Status: done"),
    );
    await waitFor(() =>
      linearApi.botComments.some((c) => c.issueId === ISSUE_ID && !c.parentId),
    );
    const reply = linearApi.botComments.find(
      (c) => c.issueId === ISSUE_ID && !c.parentId,
    )!;
    expect(reply.body).toContain("Shipped.");
    expect(reply.body).not.toContain("Linear-Status:");
    // Terminal marker moves the assigned issue to Done.
    await waitFor(() =>
      linearApi.issueStateUpdates.some((u) => u.stateId === "st-done"),
    );
  });

  it("dedupes a redelivered assignment webhook", async () => {
    const threadKey = `linear:${ISSUE_ID}`;
    await postWebhook(
      issueAssignmentPayload({ updatedAt: "2026-06-16T01:00:00.000Z" }),
    );
    await waitFor(() =>
      codexApi.executes.some((e) => e.threadKey === threadKey),
    );
    const before = codexApi.executes.filter(
      (e) => e.threadKey === threadKey,
    ).length;
    await Bun.sleep(50);
    await postWebhook(
      issueAssignmentPayload({ updatedAt: "2026-06-16T01:00:00.000Z" }),
    );
    await Bun.sleep(100);
    expect(
      codexApi.executes.filter((e) => e.threadKey === threadKey).length,
    ).toBe(before);
  });

  it("settles a vestigial agent session minimally (no widget render)", async () => {
    const sessionId = "sess-settle";
    linearApi.addAgentSession({ id: sessionId, rootCommentId: "comment-x" });
    const res = await postWebhook(
      agentSessionCreatedPayload({
        sessionId,
        commentId: "comment-x",
        commentBody: "@centaur hi",
        promptContext: "ENG-1: x",
      }),
    );
    expect(res.status).toBe(200);

    // A single terminal response activity settles the session — no run.
    await waitFor(() =>
      linearApi.activities.some((a) => a.content.type === "response"),
    );
    const responses = linearApi.activities.filter(
      (a) => a.content.type === "response",
    );
    expect(responses).toHaveLength(1);
    expect(
      responses[0]?.content.type === "response"
        ? responses[0].content.body
        : "",
    ).toContain("comment thread");
    expect(
      codexApi.executes.some(
        (e) => e.threadKey === `linear:${ISSUE_ID}:s:${sessionId}`,
      ),
    ).toBe(false);
  });

  it("rejects webhooks with an invalid signature", async () => {
    const payload = commentCreatedPayload({
      id: "comment-forged",
      body: "@centaur forged",
    });
    const body = JSON.stringify(payload);
    const response = await bot.app.request("/api/webhooks/linear", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-signature": createHmac("sha256", "wrong-secret")
          .update(body)
          .digest("hex"),
      },
      body,
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    await Bun.sleep(50);
    expect(codexApi.executes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Webhook driving
// ---------------------------------------------------------------------------

function agentSessionCreatedPayload(input: {
  appUserId?: string;
  commentBody?: string;
  commentId?: string;
  /** Creator user id; null omits the creator (automation-created session). */
  creatorId?: string | null;
  promptContext: string;
  sessionId: string;
}) {
  return {
    action: "created",
    type: "AgentSessionEvent",
    createdAt: new Date().toISOString(),
    organizationId: ORG_ID,
    webhookTimestamp: Date.now(),
    webhookId: "wh-1",
    promptContext: input.promptContext,
    agentSession: {
      id: input.sessionId,
      appUserId: input.appUserId ?? BOT_USER_ID,
      issueId: ISSUE_ID,
      url: `https://linear.app/acme/agent-session/${input.sessionId}`,
      ...(input.commentId
        ? { comment: { id: input.commentId, body: input.commentBody ?? "" } }
        : {}),
      ...(input.creatorId === null
        ? {}
        : {
            creator: {
              id: input.creatorId ?? USER_ID,
              name: "Ada Lovelace",
              email: "ada@example.com",
              url: "https://linear.app/acme/profiles/ada",
              avatarUrl: null,
            },
          }),
    },
  };
}

function commentCreatedPayload(input: {
  body: string;
  id: string;
  parentId?: string;
  user?: null;
}) {
  return {
    action: "create",
    type: "Comment",
    createdAt: new Date().toISOString(),
    organizationId: ORG_ID,
    webhookTimestamp: Date.now(),
    webhookId: "wh-3",
    url: `https://linear.app/acme/comment/${input.id}`,
    data: {
      id: input.id,
      body: input.body,
      issueId: ISSUE_ID,
      parentId: input.parentId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...(input.user === null
        ? {}
        : {
            user: {
              id: USER_ID,
              name: "Ada Lovelace",
              email: "ada@example.com",
              url: "https://linear.app/acme/profiles/ada",
              avatarUrl: null,
            },
          }),
    },
  };
}

function agentSessionPromptedPayload(input: {
  body: string;
  rootCommentId: string;
  sessionId: string;
  sourceCommentId: string;
}) {
  return {
    action: "prompted",
    type: "AgentSessionEvent",
    createdAt: new Date().toISOString(),
    organizationId: ORG_ID,
    webhookTimestamp: Date.now(),
    webhookId: "wh-2",
    promptContext: "fresh prompt context (already forwarded)",
    agentSession: {
      id: input.sessionId,
      appUserId: BOT_USER_ID,
      issueId: ISSUE_ID,
      url: `https://linear.app/acme/agent-session/${input.sessionId}`,
      comment: { id: input.rootCommentId, body: "root" },
    },
    agentActivity: {
      id: `aa-${input.sourceCommentId}`,
      sourceCommentId: input.sourceCommentId,
      createdAt: new Date().toISOString(),
      content: { type: "prompt", body: input.body },
      user: {
        id: USER_ID,
        name: "Ada Lovelace",
        email: "ada@example.com",
        url: "https://linear.app/acme/profiles/ada",
        avatarUrl: null,
      },
    },
  };
}

function issueAssignmentPayload(input: {
  updatedAt: string;
  assigneeId?: string;
}) {
  return {
    action: "update",
    type: "Issue",
    createdAt: new Date().toISOString(),
    organizationId: ORG_ID,
    webhookTimestamp: Date.now(),
    webhookId: "wh-issue",
    data: {
      id: ISSUE_ID,
      assigneeId: input.assigneeId ?? BOT_USER_ID,
      updatedAt: input.updatedAt,
    },
  };
}

async function postWebhook(payload: unknown): Promise<Response> {
  const body = JSON.stringify(payload);
  return bot.app.request("/api/webhooks/linear", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "linear-signature": createHmac("sha256", WEBHOOK_SECRET)
        .update(body)
        .digest("hex"),
    },
    body,
  });
}

function appendedTexts(): string[] {
  return codexApi.appends.flatMap((append) =>
    sessionMessageTexts(append.body.messages),
  );
}

function sessionMessageTexts(messages: LinearbotSessionMessage[]): string[] {
  return messages.flatMap((message) =>
    message.parts.flatMap((part) => {
      if (
        part &&
        typeof part === "object" &&
        !Array.isArray(part) &&
        part.type === "text" &&
        typeof part.text === "string"
      ) {
        return [part.text];
      }
      return [];
    }),
  );
}

async function waitFor(
  condition: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await Bun.sleep(10);
  }
}

// ---------------------------------------------------------------------------
// Codex App Server sample stream (mirrors the discordbot harness)
// ---------------------------------------------------------------------------

function sampleCodexOutputLines(answer: string): string[] {
  const notifications = [
    {
      method: "turn/started",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          items: [],
          itemsView: "full",
          status: "inProgress",
          error: null,
          startedAt: 1,
          completedAt: null,
          durationMs: null,
        },
      },
    },
    {
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        startedAtMs: 2,
        item: {
          type: "agentMessage",
          id: "answer-1",
          text: "",
          phase: "final_answer",
          memoryCitation: null,
        },
      },
    },
    {
      method: "item/reasoning/summaryTextDelta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "reasoning-1",
        summaryIndex: 0,
        delta: "Inspecting the event stream",
      },
    },
    {
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        startedAtMs: 2,
        item: {
          type: "commandExecution",
          id: "cmd-1",
          command: "pnpm test",
          cwd: "/repo",
          processId: "proc-1",
          source: "agent",
          status: "inProgress",
          commandActions: [],
          aggregatedOutput: null,
          exitCode: null,
          durationMs: null,
        },
      },
    },
    {
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        completedAtMs: 3,
        item: {
          type: "commandExecution",
          id: "cmd-1",
          command: "pnpm test",
          cwd: "/repo",
          processId: "proc-1",
          source: "agent",
          status: "completed",
          commandActions: [],
          aggregatedOutput: "tests passed\n",
          exitCode: 0,
          durationMs: 50,
        },
      },
    },
    {
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "answer-1",
        delta: answer,
      },
    },
  ];
  return [
    ...notifications.map((notification) => JSON.stringify(notification)),
    JSON.stringify({
      type: "turn.completed",
      turn: { id: "turn-1", items: [] },
    }),
  ];
}

// ---------------------------------------------------------------------------
// Fake Linear GraphQL API
// ---------------------------------------------------------------------------

type RecordedActivity = {
  agentSessionId: string;
  content:
    | { type: "thought"; body: string }
    | { type: "action"; action: string; parameter: string; result?: string }
    | { type: "response"; body: string }
    | { type: "error"; body: string };
  ephemeral?: boolean;
};

type FakeComment = {
  body: string;
  botActor?: { id: string; name: string };
  id: string;
  parentId?: string;
  userId?: string;
};

type RecordedBotComment = { issueId: string; body: string; parentId?: string };

type FakeLinearApi = {
  activities: RecordedActivity[];
  addAgentSession(input: { id: string; rootCommentId?: string }): void;
  addUserComment(input: { body: string; parentId?: string }): string;
  botComments: RecordedBotComment[];
  close(): void;
  issueStateUpdates: Array<{ issueId: string; stateId: string }>;
  reset(): void;
  setIssueDelegate(userId: string | null): void;
  unhandledOperations: string[];
  url: string;
};

const WORKFLOW_STATES = [
  { id: "st-triage", name: "Triage", position: 0, type: "triage" },
  { id: "st-todo", name: "Todo", position: 1, type: "unstarted" },
  { id: "st-progress", name: "In Progress", position: 2, type: "started" },
  { id: "st-done", name: "Done", position: 3, type: "completed" },
];

function startFakeLinearApi(): FakeLinearApi {
  const activities: RecordedActivity[] = [];
  const botComments: RecordedBotComment[] = [];
  const comments = new Map<string, FakeComment>();
  const sessions = new Map<string, { id: string; rootCommentId?: string }>();
  const unhandledOperations: string[] = [];
  const issueStateUpdates: Array<{ issueId: string; stateId: string }> = [];
  let issueDelegateId: string | null = null;
  let issueStateId = "st-todo";
  let idCounter = 0;
  const nextId = (prefix: string) => `${prefix}-${++idCounter}`;

  const commentNode = (comment: FakeComment) => ({
    id: comment.id,
    body: comment.body,
    createdAt: "2026-06-10T00:00:00.000Z",
    updatedAt: "2026-06-10T00:00:00.000Z",
    issueId: ISSUE_ID,
    parentId: comment.parentId ?? null,
    url: `https://linear.app/acme/comment/${comment.id}`,
    reactionData: [],
    reactions: [],
    botActor: comment.botActor
      ? {
          id: comment.botActor.id,
          name: comment.botActor.name,
          userDisplayName: comment.botActor.name,
          avatarUrl: null,
        }
      : null,
    user: comment.userId ? { id: comment.userId } : null,
  });

  const userNode = (id: string) => ({
    id,
    name: "Ada Lovelace",
    displayName: "ada",
    email: "ada@example.com",
    avatarUrl: null,
    active: true,
    admin: false,
    app: false,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
  });

  const handle = (query: string, variables: Record<string, unknown>) => {
    if (query.includes("LinearbotIssueStatus")) {
      const currentState = WORKFLOW_STATES.find(
        (state) => state.id === issueStateId,
      );
      return {
        issue: {
          id: String(variables.issueId ?? ISSUE_ID),
          delegate: issueDelegateId ? { id: issueDelegateId } : null,
          state: currentState
            ? { id: currentState.id, type: currentState.type }
            : null,
          team: { states: { nodes: WORKFLOW_STATES } },
        },
      };
    }
    if (query.includes("LinearbotIssueContext")) {
      return {
        issue: {
          identifier: "ENG-1",
          title: "Something broke",
          description: "The deploy fails on boot.",
          url: "https://linear.app/acme/issue/ENG-1",
          state: { name: "Todo" },
        },
      };
    }
    if (query.includes("LinearbotIssueStateUpdate")) {
      const issueId = String(variables.issueId ?? "");
      const stateId = String(variables.stateId ?? "");
      issueStateUpdates.push({ issueId, stateId });
      issueStateId = stateId;
      return { issueUpdate: { success: true } };
    }
    if (query.includes("LinearAdapterViewerOrganization")) {
      return {
        viewer: {
          id: BOT_USER_ID,
          displayName: "centaur",
          organization: { id: ORG_ID },
        },
      };
    }
    if (
      /mutation\s+(\w*[aA]gentActivityCreate|createAgentActivity)/.test(
        query,
      ) ||
      query.includes("agentActivityCreate(")
    ) {
      const input = variables.input as {
        agentSessionId: string;
        content: RecordedActivity["content"];
        ephemeral?: boolean;
      };
      activities.push({
        agentSessionId: input.agentSessionId,
        content: input.content,
        ...(input.ephemeral !== undefined
          ? { ephemeral: input.ephemeral }
          : {}),
      });
      const activityId = nextId("activity");
      const backingCommentId = nextId("bot-comment");
      comments.set(backingCommentId, {
        id: backingCommentId,
        body: "body" in input.content ? (input.content.body ?? "") : "",
        botActor: { id: BOT_USER_ID, name: "centaur" },
      });
      return {
        agentActivityCreate: {
          lastSyncId: idCounter,
          success: true,
          agentActivity: {
            id: activityId,
            createdAt: "2026-06-10T00:00:01.000Z",
            updatedAt: "2026-06-10T00:00:01.000Z",
            ephemeral: input.ephemeral ?? false,
            content: input.content,
            agentSession: { id: input.agentSessionId },
            sourceComment: { id: backingCommentId },
            user: { id: BOT_USER_ID },
          },
        },
      };
    }
    if (query.includes("agentSessionUpdate(")) {
      return { agentSessionUpdate: { success: true, lastSyncId: idCounter } };
    }
    if (query.includes("LinearbotCommentCreate")) {
      const id = nextId("bot-reply");
      const parentId = variables.parentId
        ? String(variables.parentId)
        : undefined;
      const body = String(variables.body ?? "");
      comments.set(id, {
        id,
        body,
        parentId,
        botActor: { id: BOT_USER_ID, name: "centaur" },
      });
      botComments.push({
        issueId: String(variables.issueId ?? ""),
        body,
        parentId,
      });
      return { commentCreate: { success: true } };
    }
    if (
      /query\s+agentActivity\b/i.test(query) ||
      query.includes("agentActivity(id:")
    ) {
      // The adapter re-fetches the created activity by id; the stored
      // backing comment id is the most recent one.
      const id = String(variables.id ?? "");
      const backingCommentId = Array.from(comments.keys())
        .filter((key) => key.startsWith("bot-comment"))
        .pop();
      return {
        agentActivity: {
          id,
          createdAt: "2026-06-10T00:00:01.000Z",
          updatedAt: "2026-06-10T00:00:01.000Z",
          ephemeral: false,
          content: { type: "response", body: "" },
          agentSession: {
            id: activities[activities.length - 1]?.agentSessionId ?? "",
          },
          sourceComment: backingCommentId ? { id: backingCommentId } : null,
          user: { id: BOT_USER_ID },
        },
      };
    }
    if (
      /query\s+agentSession\b/i.test(query) ||
      query.includes("agentSession(id:")
    ) {
      const id = String(variables.id ?? "");
      const session = sessions.get(id);
      if (!session) return { agentSession: null };
      return {
        agentSession: {
          id: session.id,
          issueId: ISSUE_ID,
          createdAt: "2026-06-10T00:00:00.000Z",
          updatedAt: "2026-06-10T00:00:00.000Z",
          externalLinks: [],
          externalUrls: null,
          context: null,
          status: "active",
          appUser: { id: BOT_USER_ID },
          comment: session.rootCommentId ? { id: session.rootCommentId } : null,
          creator: { id: USER_ID },
          issue: { id: ISSUE_ID },
        },
      };
    }
    if (/query\s+comments\b/i.test(query) || /\bcomments\(/.test(query)) {
      const filter = variables.filter as
        | { parent?: { id?: { eq?: string } } }
        | undefined;
      const parentId = filter?.parent?.id?.eq;
      const nodes = Array.from(comments.values())
        .filter((comment) => comment.parentId === parentId)
        .map(commentNode);
      return {
        comments: {
          nodes,
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      };
    }
    if (/query\s+comment\b/i.test(query) || /\bcomment\(/.test(query)) {
      const id = String(
        variables.id ?? (variables as { commentId?: string }).commentId ?? "",
      );
      const comment = comments.get(id);
      return { comment: comment ? commentNode(comment) : null };
    }
    if (/query\s+user\b/i.test(query) || /\buser\(/.test(query)) {
      return { user: userNode(String(variables.id ?? USER_ID)) };
    }
    return undefined;
  };

  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const body = (await request.json()) as {
        query: string;
        variables?: Record<string, unknown>;
      };
      const data = handle(body.query, body.variables ?? {});
      if (data === undefined) {
        const operation =
          /(query|mutation)\s+(\w+)/.exec(body.query)?.[2] ??
          body.query.slice(0, 120);
        unhandledOperations.push(operation);
        return Response.json(
          { errors: [{ message: `unhandled operation: ${operation}` }] },
          { status: 400 },
        );
      }
      return Response.json({ data });
    },
  });

  return {
    activities,
    botComments,
    issueStateUpdates,
    unhandledOperations,
    url: `http://127.0.0.1:${server.port}/graphql`,
    setIssueDelegate(userId) {
      issueDelegateId = userId;
    },
    addUserComment(input) {
      const id = nextId("comment");
      comments.set(id, {
        id,
        body: input.body,
        parentId: input.parentId,
        userId: USER_ID,
      });
      return id;
    },
    addAgentSession(input) {
      sessions.set(input.id, input);
    },
    close() {
      server.stop(true);
    },
    reset() {
      activities.length = 0;
      botComments.length = 0;
      comments.clear();
      sessions.clear();
      unhandledOperations.length = 0;
      issueStateUpdates.length = 0;
      issueDelegateId = null;
      issueStateId = "st-todo";
      idCounter = 0;
    },
  };
}

// ---------------------------------------------------------------------------
// Mock api-rs session API
// ---------------------------------------------------------------------------

type MockSessionRequest<T> = { body: T; threadKey: string };

type MockSessionApi = {
  appends: MockSessionRequest<LinearbotAppendMessagesRequest>[];
  close(): void;
  creates: MockSessionRequest<LinearbotCreateSessionRequest>[];
  emitOutputLines(
    threadKey: string,
    lines: string[],
    executionId?: string,
  ): void;
  emitSessionEvent(
    threadKey: string,
    event: string,
    data: unknown,
    executionId?: string,
  ): void;
  eventRequests: Array<{
    afterEventId: number;
    executionId?: string;
    threadKey: string;
  }>;
  executes: MockSessionRequest<LinearbotExecuteSessionRequest>[];
  reset(): void;
  url: string;
};

function startMockCodexApi(): MockSessionApi {
  const appends: MockSessionRequest<LinearbotAppendMessagesRequest>[] = [];
  const creates: MockSessionRequest<LinearbotCreateSessionRequest>[] = [];
  const executes: MockSessionRequest<LinearbotExecuteSessionRequest>[] = [];
  const eventRequests: Array<{
    afterEventId: number;
    executionId?: string;
    threadKey: string;
  }> = [];
  const idempotentExecutions = new Map<string, string>();
  type StreamHandle = {
    controller: ReadableStreamDefaultController<Uint8Array>;
    executionId?: string;
  };
  const streams = new Map<string, StreamHandle[]>();
  const pendingEvents = new Map<
    string,
    Array<{ data: string; event: string }>
  >();
  let eventId = 0;
  let executionCounter = 0;
  const encoder = new TextEncoder();

  const sseChunk = (event: string, data: string): Uint8Array => {
    eventId += 1;
    return encoder.encode(`id: ${eventId}\nevent: ${event}\ndata: ${data}\n\n`);
  };

  const emit = (
    threadKey: string,
    event: string,
    data: string,
    executionId?: string,
  ) => {
    const handles = (streams.get(threadKey) ?? []).filter(
      (handle) =>
        !executionId ||
        !handle.executionId ||
        handle.executionId === executionId,
    );
    if (handles.length === 0) {
      const queue = pendingEvents.get(threadKey) ?? [];
      queue.push({ data, event });
      pendingEvents.set(threadKey, queue);
      return;
    }
    for (const handle of handles) {
      try {
        handle.controller.enqueue(sseChunk(event, data));
      } catch {
        // Stream already closed.
      }
    }
  };

  const server = Bun.serve({
    port: 0,
    idleTimeout: 60,
    fetch: async (request) => {
      const url = new URL(request.url);
      const match = url.pathname.match(/^\/api\/session\/([^/]+)(?:\/(.+))?$/);
      if (!match) return Response.json({ error: "not found" }, { status: 404 });
      const threadKey = decodeURIComponent(match[1]!);
      const suffix = match[2];

      if (request.method === "POST" && !suffix) {
        const body = (await request.json()) as LinearbotCreateSessionRequest;
        creates.push({ body, threadKey });
        return Response.json({ ok: true });
      }
      if (request.method === "POST" && suffix === "messages") {
        const body = (await request.json()) as LinearbotAppendMessagesRequest;
        appends.push({ body, threadKey });
        return Response.json({ ok: true });
      }
      if (request.method === "POST" && suffix === "execute") {
        const body = (await request.json()) as LinearbotExecuteSessionRequest;
        executes.push({ body, threadKey });
        const idempotencyKey = `${threadKey}:${body.idempotency_key ?? ""}`;
        let executionId = idempotentExecutions.get(idempotencyKey);
        if (!executionId) {
          executionCounter += 1;
          executionId = `exec-${executionCounter}`;
          idempotentExecutions.set(idempotencyKey, executionId);
        }
        return Response.json({
          execution_id: executionId,
          ok: true,
          status: "running",
          thread_key: threadKey,
        });
      }
      if (request.method === "GET" && suffix === "events") {
        const executionId = url.searchParams.get("execution_id") ?? undefined;
        eventRequests.push({
          afterEventId: Number(url.searchParams.get("after_event_id") ?? 0),
          ...(executionId ? { executionId } : {}),
          threadKey,
        });
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const handle: StreamHandle = { controller, executionId };
            const handles = streams.get(threadKey) ?? [];
            handles.push(handle);
            streams.set(threadKey, handles);
            controller.enqueue(encoder.encode(": connected\n\n"));
            const queued = pendingEvents.get(threadKey) ?? [];
            pendingEvents.delete(threadKey);
            for (const item of queued) {
              controller.enqueue(sseChunk(item.event, item.data));
            }
          },
          cancel() {
            // Consumer cancelled; drop the handle on next emit.
          },
        });
        return new Response(stream, {
          headers: { "content-type": "text/event-stream" },
        });
      }
      return Response.json({ error: "unsupported" }, { status: 405 });
    },
  });

  return {
    appends,
    creates,
    eventRequests,
    executes,
    url: `http://127.0.0.1:${server.port}`,
    emitOutputLines(threadKey, lines, executionId) {
      for (const line of lines) {
        emit(threadKey, "session.output.line", line, executionId);
      }
    },
    emitSessionEvent(threadKey, event, data, executionId) {
      emit(threadKey, event, JSON.stringify(data), executionId);
    },
    close() {
      server.stop(true);
    },
    reset() {
      appends.length = 0;
      creates.length = 0;
      eventRequests.length = 0;
      executes.length = 0;
      idempotentExecutions.clear();
      pendingEvents.clear();
      for (const handles of streams.values()) {
        for (const handle of handles) {
          try {
            handle.controller.close();
          } catch {
            // already closed
          }
        }
      }
      streams.clear();
      eventId = 0;
      executionCounter = 0;
    },
  };
}
