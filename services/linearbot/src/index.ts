import { AsyncLocalStorage } from "node:async_hooks";
import {
  codexAppServerToChatSdkStream,
  type CodexAppServerToChatStreamOptions,
  type RendererEvent,
} from "@centaur/rendering";
import { createLinearAdapter } from "@chat-adapter/linear";
import { createPostgresState } from "@chat-adapter/state-pg";
import {
  Chat,
  type Adapter,
  type Logger,
  type Message as ChatMessage,
  type StateAdapter,
  type Thread,
} from "chat";
import { Hono, type Context } from "hono";
import pg from "pg";
import {
  parseIssueAssignmentWebhook,
  parseIssueCommentWebhook,
  type IssueAssignmentEvent,
  type IssueCommentEvent,
} from "./issue-comments";
import {
  buildCommentReplyBody,
  buildThinkingReplyBody,
  commentMentionsBot,
  CommentReplyCollector,
} from "./comment-bot";
import {
  EMPTY_PROMPT_INSTRUCTION,
  fetchLinearIssueContext,
  formatIssueContext,
  formatIssueContextHeader,
} from "./linear-context";
import { ackWorking } from "./linear-narrator";
import {
  addCommentReaction,
  removeCommentReaction,
  REACTION_DONE,
  REACTION_FAILED,
  REACTION_WORKING,
} from "./linear-reactions";
import { postIssueReply, updateIssueReply } from "./linear-reply";
import {
  extractStatusMarker,
  fetchIssueStatus,
  markerTargetState,
  statusTraceFields,
  updateIssueState,
  type LinearStatusMarker,
} from "./linear-status";
import { parseLinearThreadKey } from "./linear-threading";
import { extractMessageOverrides } from "./overrides";
import {
  executeSessionTurn,
  forwardToSessionApi,
  isRetryableSessionApiError,
  openSessionEventStream,
  serializeMessage,
  sessionStreamError,
  startingStreamNotification,
} from "./session-api";
import type {
  ForwardSessionInput,
  Linearbot,
  LinearbotApiMessage,
  LinearbotExecuteSessionResponse,
  LinearbotOptions,
  LinearbotRendererSource,
  LinearbotThreadState,
  LinearbotTrace,
  LinearSessionCapableAdapter,
} from "./types";
import {
  errorMessage,
  noopLogger,
  nowMs,
  stringValue,
  traceLog,
} from "./utils";

export type {
  Linearbot,
  LinearbotApiAttachment,
  LinearbotApiAuthor,
  LinearbotApiMessage,
  LinearbotAppendMessagesRequest,
  LinearbotCreateSessionRequest,
  LinearbotExecuteSessionRequest,
  LinearbotExecuteSessionResponse,
  LinearbotFetch,
  LinearbotOptions,
  LinearbotSessionMessage,
  LinearbotSessionMessageRole,
} from "./types";

type WaitUntilContext = {
  waitUntil(promise: Promise<unknown>): void;
};

type LinearbotRequestContext = {
  retryableErrors: unknown[];
  waitUntil(promise: Promise<unknown>): void;
};

const requestContext = new AsyncLocalStorage<LinearbotRequestContext>();
// Backoff for the comment-bot's bounded cold-start retry (renderRetryDelayMs).
const RENDER_RETRY_INITIAL_DELAY_MS = 250;
const RENDER_RETRY_MAX_DELAY_MS = 5_000;
const POSTGRES_CONNECT_INITIAL_DELAY_MS = 250;
const POSTGRES_CONNECT_MAX_DELAY_MS = 10_000;

// The resolved issue name becomes the session principal's display name in
// iron-control (see api-rs derive_principal). api-rs re-upserts the principal on
// every create, so the name must ride every create to stay stable — cache the
// per-issue lookup (mirrors slackbotv2's channel-name cache). Misses expire
// sooner so a transient subject-fetch failure self-heals.
const CONVERSATION_NAME_CACHE_SUCCESS_TTL_MS = 6 * 60 * 60 * 1000;
const CONVERSATION_NAME_CACHE_MISS_TTL_MS = 10 * 60 * 1000;
type ConversationNameCacheEntry = {
  expiresAtMs: number;
  name: string | undefined;
};
const conversationNameCache = new Map<string, ConversationNameCacheEntry>();

export function clearConversationNameCacheForTests(): void {
  conversationNameCache.clear();
}

/**
 * Resolve a human-readable name for a Linear issue thread (the issue identifier,
 * e.g. "ENG-123", falling back to the title) to name the session principal.
 * Cached per issue and never throws — the name is cosmetic, so a fetch failure
 * just falls back to the synthetic id-based principal name in api-rs.
 */
export async function resolveLinearConversationName(
  message: ChatMessage,
  logger: Logger,
): Promise<string | undefined> {
  const { issueId } = parseLinearThreadKey(message.threadId);
  const cacheKey = issueId ?? message.threadId;
  const cached = conversationNameCache.get(cacheKey);
  if (cached && cached.expiresAtMs > Date.now()) return cached.name;

  let name: string | undefined;
  try {
    const subject = await message.subject;
    name = subject?.id ?? subject?.title ?? undefined;
  } catch (error) {
    logger.warn("linearbot_conversation_name_failed", {
      error: errorMessage(error),
    });
    name = undefined;
  }
  conversationNameCache.set(cacheKey, {
    expiresAtMs:
      Date.now() +
      (name
        ? CONVERSATION_NAME_CACHE_SUCCESS_TTL_MS
        : CONVERSATION_NAME_CACHE_MISS_TTL_MS),
    name,
  });
  return name;
}

export function createLinearbot(options: LinearbotOptions): Linearbot {
  const userName = options.userName ?? "centaur";
  const logger = options.logger ?? noopLogger;
  const linear = createLinearAdapter({
    ...(options.linearAccessToken
      ? { accessToken: options.linearAccessToken }
      : options.linearApiKey
        ? { apiKey: options.linearApiKey }
        : {}),
    ...(options.linearApiUrl ? { apiUrl: options.linearApiUrl } : {}),
    mode: options.linearMode ?? "agent-sessions",
    userName,
    webhookSecret: options.linearWebhookSecret,
    logger,
  });
  const state = options.state ?? createDefaultState(options, logger);
  const chat = new Chat<{ linear: typeof linear }, LinearbotThreadState>({
    userName,
    adapters: { linear },
    state,
    onLockConflict: "force",
    // No SDK-level streaming placeholder: instant feedback is the ephemeral
    // working thought (ackWorking / the narrator), and the final answer posts
    // exactly once as the session's response activity — agent sessions are
    // append-only, so the SDK's post+edit fallback streaming cannot work.
    fallbackStreamingPlaceholderText: null,
    logger,
  });

  // Centaur-forward model: the agent session an @-mention creates is vestigial.
  // Both session handlers just settle it (so it never shows "did not respond");
  // the real answer is posted in the comment thread by handleCommentMention,
  // driven by the Comment webhook. (Defense-in-depth: never act on isMe — the
  // agent creates comments/delegates issues itself via the sandbox linear tool.)
  const settleSession = async (
    thread: Thread<LinearbotThreadState>,
    message: ChatMessage,
  ): Promise<void> => {
    if (message.author.isMe) {
      traceLog(options, "linearbot_self_message_skipped", undefined, {
        message_id: message.id,
        thread_id: thread.id,
      });
      return;
    }
    await settleVestigialSession(thread, options);
  };
  chat.onNewMention(settleSession);
  chat.onSubscribedMessage(settleSession);

  // The Linear adapter resolves the bot's user id during chat.initialize();
  // assignment (an Issue webhook the adapter doesn't otherwise touch) needs it.
  // We also resolve the bot's profile handle here: Linear renders a mention as
  // the mentioned profile's plain URL, so commentMentionsBot matches that handle
  // (linear.app/.../profiles/{handle}) in the body. Init once, lazily, on the
  // first webhook — idempotent and best-effort.
  let chatInitialized = false;
  let botProfileHandle: string | undefined;
  const ensureChatInitialized = async (): Promise<void> => {
    if (chatInitialized) return;
    try {
      await chat.initialize();
      botProfileHandle = await resolveBotProfileHandle(linear, logger);
    } catch (error) {
      logger.warn("linearbot_chat_initialize_failed", {
        error: errorMessage(error),
      });
    }
    chatInitialized = true;
  };

  const app = new Hono();
  app.get("/health", (c) => c.json({ ok: true, service: "linearbot" }));
  const handleLinearWebhook = async (c: Context) => {
    const rawBody = await c.req.raw.clone().text();
    await ensureChatInitialized();
    const awaitHandoff = shouldAwaitLinearHandoff(rawBody);
    const handoffTasks: Promise<unknown>[] = [];
    const context: LinearbotRequestContext = {
      retryableErrors: [],
      waitUntil: (promise) => waitUntil(c, promise),
    };
    const response = await requestContext.run(context, () => {
      return chat.webhooks.linear(c.req.raw, {
        waitUntil: (promise) => {
          if (awaitHandoff) {
            handoffTasks.push(promise);
          } else {
            waitUntil(c, promise);
          }
        },
      });
    });
    if (awaitHandoff && response.ok) {
      // Centaur-forward model: respond to mentions (Comment webhook) and
      // assignments (Issue webhook) — thread = sandbox. The bot's user id is
      // read here, after chat.webhooks.linear initialized the adapter.
      let botUserId: string | undefined;
      try {
        botUserId = (linear as unknown as LinearSessionCapableAdapter)
          .botUserId;
      } catch {
        botUserId = undefined;
      }
      const handlerInput: ThreadHandlerInput = {
        botProfileHandle,
        botUserId,
        chat,
        options,
        state,
      };
      const handled =
        requestContext.run(context, () =>
          handleCommentMention(rawBody, handlerInput),
        ) ??
        requestContext.run(context, () =>
          handleThreadFollowup(rawBody, handlerInput),
        ) ??
        requestContext.run(context, () =>
          handleIssueAssignment(rawBody, handlerInput),
        );
      if (handled) handoffTasks.push(handled);
      try {
        await Promise.all(handoffTasks);
      } catch (error) {
        if (isRetryableSessionApiError(error))
          context.retryableErrors.push(error);
      }
      if (context.retryableErrors.length > 0) {
        traceLog(options, "linearbot_webhook_retry_requested", undefined, {
          error: errorMessage(context.retryableErrors[0]),
        });
        return new globalThis.Response("temporary upstream unavailable", {
          status: 503,
        });
      }
    }
    return new globalThis.Response(await response.text(), {
      headers: response.headers,
      status: response.status,
    });
  };
  app.post("/api/webhooks/linear", handleLinearWebhook);

  // Connect the Postgres state at startup (retrying past the pod's network
  // race) and initialize the adapter, so the message path is live before the
  // first webhook. Fire-and-forget; webhooks also init lazily as a backstop.
  if (options.connectStateOnStart !== false) {
    void ensureStateConnected(state, options).then(ensureChatInitialized);
  }

  return { app, chat };
}

function createDefaultState(
  options: LinearbotOptions,
  logger: Logger,
): StateAdapter {
  const stateLogger = logger.child("postgres-state");
  // Own the pool so we can attach an error handler. pg.Pool emits 'error' for
  // idle clients whose connection drops (Postgres restart, or a transient blip
  // while the pod's network is still being programmed at startup). With no
  // listener, node-postgres rethrows it as an uncaught exception and the process
  // crashes/spews. Logging and swallowing lets the pool reconnect on the next query.
  const pool = new pg.Pool({ connectionString: options.postgresUrl });
  pool.on("error", (error) => {
    stateLogger.warn("postgres pool error", { error: errorMessage(error) });
  });
  return createPostgresState({
    client: pool,
    keyPrefix: options.stateKeyPrefix ?? "centaur-linearbot",
    logger: stateLogger,
  });
}

/**
 * Blocks until the state backend accepts a connection, retrying with exponential
 * backoff. The first DB connection fires within milliseconds of process start and
 * can lose a race with the pod's network programming (a one-off ECONNREFUSED).
 * Retrying instead of throwing absorbs that race; the first successful connect
 * also flips the adapter's `connected` flag, so the message path comes alive too.
 */
async function ensureStateConnected(
  state: StateAdapter,
  options: LinearbotOptions,
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await state.connect();
      if (attempt > 0) {
        traceLog(options, "linearbot_postgres_connected", undefined, {
          attempts: attempt + 1,
        });
      }
      return;
    } catch (error) {
      const delayMs = Math.min(
        POSTGRES_CONNECT_INITIAL_DELAY_MS * 2 ** attempt,
        POSTGRES_CONNECT_MAX_DELAY_MS,
      );
      traceLog(options, "linearbot_postgres_connect_retry", undefined, {
        attempt: attempt + 1,
        delay_ms: delayMs,
        error: errorMessage(error),
      });
      await sleep(delayMs);
    }
  }
}

function issueCommentMessage(
  event: IssueCommentEvent,
  threadId: string,
): ChatMessage {
  return {
    attachments: [],
    author: {
      fullName: event.authorName,
      isBot: false,
      isMe: false,
      userId: event.authorId,
      userName: event.authorName,
    },
    id: event.commentId,
    isMention: false,
    metadata: {
      dateSent: event.createdAt ? new Date(event.createdAt) : new Date(),
    },
    raw: { linearbotIssueComment: true, url: event.url },
    text: event.body,
    threadId,
  } as unknown as ChatMessage;
}

const THREAD_TURN_MAX_RETRIES = 3;
// Min gap between live edits of the streaming "Thinking…" comment. The first
// thought posts immediately; subsequent thoughts coalesce to stay well under
// Linear's mutation rate limits. The final answer always writes regardless.
const LIVE_THINKING_EDIT_MIN_INTERVAL_MS = 2_500;
// Cap on the full issue-context preamble seeded on a thread's first turn. The
// description rides inline in the execute, so keep it bounded (the whole issue
// description, untruncated, could be huge).
const ISSUE_CONTEXT_PREAMBLE_MAX_CHARS = 8_000;
const PROFILE_HANDLE_PATTERN = /\/profiles\/([^/?#]+)/;

type ThreadHandlerInput = {
  botProfileHandle: string | undefined;
  botUserId: string | undefined;
  chat: Chat<Record<string, Adapter>, LinearbotThreadState>;
  options: LinearbotOptions;
  state: StateAdapter;
};

/**
 * Resolves the bot's profile handle (the `{handle}` in its
 * linear.app/.../profiles/{handle} URL) so commentMentionsBot can match the
 * mention Linear renders into the comment body. Best-effort; returns undefined
 * on failure (detection falls back to user id / @name).
 */
async function resolveBotProfileHandle(
  linear: unknown,
  logger: Logger,
): Promise<string | undefined> {
  const client = (linear as LinearSessionCapableAdapter).linearClient;
  if (!client?.client?.rawRequest) return undefined;
  try {
    const response = await client.client.rawRequest<{
      viewer?: { url?: unknown };
    }>("query LinearbotBotProfile { viewer { id url } }");
    const url = stringValue(response.data?.viewer?.url);
    return url
      ? (PROFILE_HANDLE_PATTERN.exec(url)?.[1] ?? undefined)
      : undefined;
  } catch (error) {
    logger.debug("linearbot_bot_profile_resolve_failed", {
      error: errorMessage(error),
    });
    return undefined;
  }
}

/**
 * Centaur-forward model: the Linear agent session an @-mention creates is
 * vestigial — the real answer is posted in the comment thread
 * (handleCommentMention). This just acks and posts a one-line terminal response
 * so the session never shows "did not respond". Once agent-session events are
 * turned off on the webhook, this stops firing. Best-effort.
 */
async function settleVestigialSession(
  thread: Thread<LinearbotThreadState>,
  options: LinearbotOptions,
): Promise<void> {
  const logger = options.logger ?? noopLogger;
  ackWorking(thread, logger);
  try {
    await thread.post("On it — I'll reply in the comment thread.");
  } catch (error) {
    logger.debug("linearbot_session_settle_failed", {
      error: errorMessage(error),
    });
  }
}

/**
 * Comment-thread responder (primary). A comment that @-mentions the bot is
 * answered as one visible comment in its thread — the answer with the
 * chain-of-thought in a collapsed section — running on the thread's sandbox
 * (1 thread === 1 context stack). Returns null when the webhook is not a
 * bot-mention comment. Fires whether or not a session was also created, so it
 * works before and after agent-session events are turned off.
 */
function handleCommentMention(
  rawBody: string,
  input: ThreadHandlerInput,
): Promise<void> | null {
  const event = parseIssueCommentWebhook(rawBody);
  if (!event) return null;
  const names = [input.options.userName ?? "centaur"];
  if (
    !commentMentionsBot(event.body, names, {
      botUserId: input.botUserId,
      profileHandle: input.botProfileHandle,
    })
  ) {
    return null;
  }
  const { chat, options } = input;
  const rootCommentId = event.parentId ?? event.commentId;
  const threadKey = `linear:${event.issueId}:c:${rootCommentId}`;
  const trace: LinearbotTrace = {
    includeContext: false,
    messageId: event.commentId,
    mode: "execute",
    openStream: true,
    startedAtMs: nowMs(),
    threadId: threadKey,
  };
  return (async () => {
    const thread = chat.thread(threadKey);
    const threadState = (await thread.state) ?? {};
    if ((threadState.repliedCommentIds ?? []).includes(event.commentId)) {
      traceLog(options, "linearbot_comment_duplicate_skipped", trace, {
        comment_id: event.commentId,
      });
      return;
    }
    // Claim before the background run so a redelivery never double-replies.
    await thread.setState({
      repliedCommentIds: [
        ...(threadState.repliedCommentIds ?? []),
        event.commentId,
      ].slice(-200),
    });
    const client = (thread.adapter as unknown as LinearSessionCapableAdapter)
      .linearClient;
    const serialized = await serializeMessage(
      issueCommentMessage(event, threadKey),
    );
    const overrides = extractMessageOverrides(serialized.text);
    serialized.text = overrides.cleanedText;
    backgroundWaitUntil(
      runThreadTurn({
        applyStatus: false,
        client,
        executeMessage: serialized,
        issueId: event.issueId,
        options,
        overrides: {
          harnessType: overrides.harnessType,
          model: overrides.model,
        },
        parentCommentId: rootCommentId,
        reactCommentId: event.commentId,
        thread,
        threadKey,
        trace,
      }),
    );
  })();
}

/**
 * Thread-followup ingester (context only). A comment that does NOT mention the
 * bot but lands in a comment thread the bot is already active in (the root
 * thread key has run a turn) is appended to that thread's session as context —
 * so the next mention turn sees it — without running a turn or posting a reply.
 * Mirrors slackbotv2's onSubscribedMessage append for non-mention messages,
 * scoped to active threads (a Linear issue can host many unrelated threads).
 * Returns null when the webhook is not such a comment.
 */
function handleThreadFollowup(
  rawBody: string,
  input: ThreadHandlerInput,
): Promise<void> | null {
  const event = parseIssueCommentWebhook(rawBody);
  if (!event) return null;
  // Mentions are answered by handleCommentMention; only ingest the rest here.
  const names = [input.options.userName ?? "centaur"];
  if (
    commentMentionsBot(event.body, names, {
      botUserId: input.botUserId,
      profileHandle: input.botProfileHandle,
    })
  ) {
    return null;
  }
  // Loop guard: never ingest the bot's own comments. (parseIssueCommentWebhook
  // already drops botActor-authored comments; this covers app-user authorship.)
  if (input.botUserId && event.authorId === input.botUserId) return null;
  const { chat, options } = input;
  const rootCommentId = event.parentId ?? event.commentId;
  const threadKey = `linear:${event.issueId}:c:${rootCommentId}`;
  const trace: LinearbotTrace = {
    includeContext: false,
    messageId: event.commentId,
    mode: "execute",
    openStream: false,
    startedAtMs: nowMs(),
    threadId: threadKey,
  };
  return (async () => {
    const thread = chat.thread(threadKey);
    const threadState = (await thread.state) ?? {};
    // Only ingest into threads the bot is active in: a turn has finished there
    // (historyForwarded) OR a mention turn has been claimed (repliedCommentIds)
    // and may still be streaming. The latter captures a followup that lands
    // mid-run — the session already exists, so the append targets it (and is
    // seen by the next turn). createSession is idempotent, so even if the
    // followup wins a race against the first turn's create, it's harmless.
    const isActiveThread =
      threadState.historyForwarded === true ||
      (threadState.repliedCommentIds ?? []).length > 0;
    if (!isActiveThread) {
      traceLog(options, "linearbot_followup_inactive_thread_skipped", trace, {
        comment_id: event.commentId,
      });
      return;
    }
    if ((threadState.ingestedCommentIds ?? []).includes(event.commentId)) {
      traceLog(options, "linearbot_followup_duplicate_skipped", trace, {
        comment_id: event.commentId,
      });
      return;
    }
    // Claim before the background append so a redelivery never double-appends.
    await thread.setState({
      ingestedCommentIds: [
        ...(threadState.ingestedCommentIds ?? []),
        event.commentId,
      ].slice(-200),
    });
    const serialized = await serializeMessage(
      issueCommentMessage(event, threadKey),
    );
    backgroundWaitUntil(
      appendThreadFollowup({ options, serialized, threadKey, trace }),
    );
  })();
}

/**
 * Appends a non-mention thread followup to its session as context (create is
 * idempotent on an active thread; no execute, no stream, no reply). Best-effort
 * — context enrichment must not surface errors to the thread.
 */
async function appendThreadFollowup(input: {
  options: LinearbotOptions;
  serialized: LinearbotApiMessage;
  threadKey: string;
  trace: LinearbotTrace;
}): Promise<void> {
  const { options, serialized, threadKey, trace } = input;
  try {
    await forwardToSessionApi(
      options,
      {
        afterEventId: 0,
        executeMessage: undefined,
        messages: [serialized],
        onEventId: () => undefined,
        openStream: false,
        threadId: threadKey,
        trace,
      },
      {},
    );
    traceLog(options, "linearbot_followup_appended", trace, {
      message_id: serialized.id,
    });
  } catch (error) {
    (options.logger ?? noopLogger).warn("linearbot_followup_append_failed", {
      error: errorMessage(error),
    });
  }
}

/**
 * Assignment turn. When an issue is assigned/delegated to the bot, run a turn
 * on the issue's sandbox and post the result as a comment. Uses the Issue
 * webhook (not an AgentSessionEvent) so it survives agent sessions being off.
 */
function handleIssueAssignment(
  rawBody: string,
  input: ThreadHandlerInput,
): Promise<void> | null {
  if (!input.botUserId) return null;
  const event = parseIssueAssignmentWebhook(rawBody, input.botUserId);
  if (!event) return null;
  const { chat, options } = input;
  const threadKey = `linear:${event.issueId}`;
  const trace: LinearbotTrace = {
    includeContext: false,
    messageId: `assign-${event.issueId}-${event.updatedAt}`,
    mode: "execute",
    openStream: true,
    startedAtMs: nowMs(),
    threadId: threadKey,
  };
  return (async () => {
    const thread = chat.thread(threadKey);
    const threadState = (await thread.state) ?? {};
    if (
      event.updatedAt &&
      threadState.lastAssignmentTrigger === event.updatedAt
    ) {
      traceLog(options, "linearbot_assignment_duplicate_skipped", trace, {
        issue_id: event.issueId,
      });
      return;
    }
    await thread.setState({ lastAssignmentTrigger: event.updatedAt });
    const client = (thread.adapter as unknown as LinearSessionCapableAdapter)
      .linearClient;
    backgroundWaitUntil(
      runThreadTurn({
        applyStatus: true,
        client,
        executeMessage: assignmentInstructionMessage(event, threadKey),
        issueId: event.issueId,
        options,
        overrides: {},
        thread,
        threadKey,
        trace,
      }),
    );
  })();
}

/**
 * Runs one agent turn on a thread's sandbox in a single, live comment. The
 * comment is posted with the first thought as a collapsed "Thinking…" section
 * that logs thoughts as the run streams (throttled), then swapped in place to
 * the final answer above a "Chain of thought" section when the run settles.
 * Seeds the issue context on the thread's first turn. Best-effort with a bounded
 * retry on transient (cold-start) failures; a hard failure shows an error.
 */
async function runThreadTurn(input: {
  applyStatus: boolean;
  client: LinearSessionCapableAdapter["linearClient"];
  executeMessage: LinearbotApiMessage;
  issueId: string;
  options: LinearbotOptions;
  overrides: { harnessType?: string; model?: string };
  parentCommentId?: string;
  /** Comment to react to (👀 → ✅/❌); the triggering mention, if any. */
  reactCommentId?: string;
  thread: Thread<LinearbotThreadState>;
  threadKey: string;
  trace: LinearbotTrace;
}): Promise<void> {
  const {
    applyStatus,
    client,
    executeMessage,
    issueId,
    options,
    overrides,
    parentCommentId,
    reactCommentId,
    thread,
    threadKey,
    trace,
  } = input;
  const logger = options.logger ?? noopLogger;
  // Instant 👀 ack on the triggering comment while the bot works (best-effort).
  let workingReactionId: string | undefined;
  if (client && reactCommentId) {
    try {
      workingReactionId = await addCommentReaction(
        client,
        reactCommentId,
        REACTION_WORKING,
      );
    } catch (error) {
      logger.debug("linearbot_reaction_ack_failed", {
        error: errorMessage(error),
      });
    }
  }
  const threadState = (await thread.state) ?? {};
  // Tell the agent what task it's on by riding the issue context inline in the
  // execute (contextPreamble lands directly in the prompt's input lines) rather
  // than as a one-time appended session message — so a recycled sandbox or a
  // single failed fetch never leaves the agent guessing what "this task" is.
  // Full context (with description) on the thread's first turn; a compact
  // id/title header thereafter, when the session already carries the rest.
  let contextPreamble: string | undefined;
  let seededFullContext = false;
  if (client) {
    const issueContext = await fetchLinearIssueContext(client, issueId, logger);
    if (issueContext) {
      if (threadState.contextSeeded) {
        contextPreamble = formatIssueContextHeader(issueContext);
      } else {
        contextPreamble = formatIssueContext(
          issueContext,
          ISSUE_CONTEXT_PREAMBLE_MAX_CHARS,
        );
        seededFullContext = true;
      }
    }
  }
  let lastEventId = threadState.lastEventId ?? 0;
  const forwardInput: ForwardSessionInput = {
    afterEventId: lastEventId,
    contextPreamble,
    executeMessage,
    harnessType: overrides.harnessType,
    messages: [],
    model: overrides.model,
    onEventId: (eventId) => {
      lastEventId = Math.max(lastEventId, eventId);
    },
    openStream: false,
    threadId: threadKey,
    trace,
  };
  // The live reply: posted with the first thought as a "Thinking…" section,
  // edited (throttled) as more thoughts settle, then swapped to the final
  // answer. `liveCommentId` persists across retries so a transient failure
  // mid-stream keeps editing the same comment.
  let liveCommentId: string | undefined;
  let livePostStarted = false;
  let lastLiveRenderAtMs = 0;
  let lastLiveLineCount = 0;
  const renderThinking = async (
    collector: CommentReplyCollector,
  ): Promise<void> => {
    if (!client) return;
    const cotLines = collector.cotLines;
    if (cotLines.length === 0) return;
    try {
      if (!livePostStarted) {
        livePostStarted = true;
        lastLiveLineCount = cotLines.length;
        lastLiveRenderAtMs = nowMs();
        liveCommentId = await postIssueReply(client, {
          body: buildThinkingReplyBody(cotLines, collector.latestThought),
          issueId,
          parentCommentId,
        });
        return;
      }
      if (!liveCommentId || cotLines.length === lastLiveLineCount) return;
      if (nowMs() - lastLiveRenderAtMs < LIVE_THINKING_EDIT_MIN_INTERVAL_MS)
        return;
      lastLiveLineCount = cotLines.length;
      lastLiveRenderAtMs = nowMs();
      await updateIssueReply(client, {
        body: buildThinkingReplyBody(cotLines, collector.latestThought),
        commentId: liveCommentId,
      });
    } catch (error) {
      logger.debug("linearbot_live_render_failed", {
        error: errorMessage(error),
      });
    }
  };

  let body: string | undefined;
  let marker: LinearStatusMarker | undefined;
  let failed = false;
  for (let attempt = 0; attempt <= THREAD_TURN_MAX_RETRIES; attempt++) {
    try {
      // create + append context (idempotent), then execute + stream.
      await forwardToSessionApi(
        options,
        { ...forwardInput, executeMessage: undefined, openStream: false },
        {},
      );
      const collector = new CommentReplyCollector();
      const fallback = new LinearRenderFallback();
      for await (const chunk of codexAppServerToChatSdkStream(
        fallback.collectSource(
          streamSessionAfterHandoff(options, forwardInput),
        ),
        rendererOptions(options),
      )) {
        collector.update(chunk);
        await renderThinking(collector);
      }
      await thread.setState({
        historyForwarded: true,
        // Only mark seeded once the full context actually rode a turn, so a
        // failed first fetch re-seeds (not just the compact header) next time.
        ...(seededFullContext ? { contextSeeded: true } : {}),
      });
      if (collector.failed) {
        failed = true;
        body = buildCommentReplyBody({
          answer: `⚠️ I ran into an error before finishing:\n\n${collector.errorText || "unknown error"}`,
          cotLines: collector.cotLines,
        });
      } else {
        const extracted = extractStatusMarker(
          collector.answer || fallback.text(),
        );
        marker = extracted.marker;
        body = buildCommentReplyBody({
          answer: extracted.text,
          cotLines: collector.cotLines,
          fallback: fallback.text(),
        });
      }
      break;
    } catch (error) {
      if (
        isRetryableSessionApiError(error) &&
        attempt < THREAD_TURN_MAX_RETRIES
      ) {
        traceLog(options, "linearbot_thread_turn_retry", trace, {
          retry_attempt: attempt + 1,
        });
        await sleep(renderRetryDelayMs(attempt));
        continue;
      }
      logger.warn("linearbot_thread_turn_failed", {
        error: errorMessage(error),
      });
      failed = true;
      body = `⚠️ I ran into an error before finishing: ${errorMessage(error)}`;
      break;
    }
  }
  if (client && body !== undefined) {
    try {
      // Swap the live "Thinking…" comment to the final answer in place; if no
      // thought ever streamed (no live comment), post the answer fresh.
      if (liveCommentId) {
        await updateIssueReply(client, { body, commentId: liveCommentId });
      } else {
        await postIssueReply(client, { body, issueId, parentCommentId });
      }
    } catch (error) {
      logger.warn("linearbot_thread_reply_failed", {
        error: errorMessage(error),
      });
    }
    if (applyStatus && marker) {
      backgroundWaitUntil(
        applyAssignmentStatusMarker(client, issueId, marker, options, trace),
      );
    }
  }
  // Settle the reaction: add ✅/❌ then drop 👀, so the comment always carries
  // an indicator (best-effort, mirrors discordbot).
  if (client && reactCommentId) {
    try {
      await addCommentReaction(
        client,
        reactCommentId,
        failed ? REACTION_FAILED : REACTION_DONE,
      );
      if (workingReactionId) {
        await removeCommentReaction(client, workingReactionId);
      }
    } catch (error) {
      logger.debug("linearbot_reaction_settle_failed", {
        error: errorMessage(error),
      });
    }
  }
  traceLog(options, "linearbot_thread_turn_complete", trace, {
    chars: body?.length ?? 0,
    failed,
  });
}

/** Synthetic "work this assigned issue" prompt for an assignment turn. */
function assignmentInstructionMessage(
  event: IssueAssignmentEvent,
  threadKey: string,
): LinearbotApiMessage {
  return {
    attachments: [],
    author: {
      fullName: "Linear",
      isBot: false,
      isMe: false,
      userId: "linear-assignment",
      userName: "linear-assignment",
    },
    id: `assign-${event.issueId}-${event.updatedAt}`,
    isMention: true,
    raw: { linearbotAssignment: true },
    text: EMPTY_PROMPT_INSTRUCTION,
    threadId: threadKey,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Applies the agent's terminal `Linear-Status:` marker to an assigned issue
 * (the bot owns issues delegated to it). Best-effort; never throws.
 */
async function applyAssignmentStatusMarker(
  client: LinearSessionCapableAdapter["linearClient"],
  issueId: string,
  marker: LinearStatusMarker,
  options: LinearbotOptions,
  trace: LinearbotTrace,
): Promise<void> {
  if (!client) return;
  try {
    const status = await fetchIssueStatus(client, issueId);
    if (!status) return;
    const target = markerTargetState(status, marker);
    if (!target) return;
    await updateIssueState(client, issueId, target.id);
    traceLog(
      options,
      "linearbot_assignment_status_applied",
      trace,
      statusTraceFields(issueId, target),
    );
  } catch (error) {
    (options.logger ?? noopLogger).warn("linearbot_assignment_status_failed", {
      error: errorMessage(error),
    });
  }
}

class LinearRenderFallback {
  private terminalText = "";

  async *collectSource(
    stream: AsyncIterable<LinearbotRendererSource>,
  ): AsyncIterable<LinearbotRendererSource> {
    for await (const event of stream) {
      this.captureTerminalText(event);
      yield event;
    }
  }

  text(): string {
    return this.terminalText.trim();
  }

  private captureTerminalText(event: LinearbotRendererSource): void {
    if (!event || typeof event !== "object") return;
    const eventKind = String(
      "eventKind" in event
        ? event.eventKind
        : "event" in event
          ? event.event
          : "",
    );
    if (
      eventKind !== "session.execution_completed" &&
      eventKind !== "session.execution_cancelled" &&
      !isTerminalCodexAppServerEvent(event)
    ) {
      return;
    }
    const data =
      "data" in event && event.data && typeof event.data === "object"
        ? event.data
        : event;
    const text = terminalResultText(data);
    if (text) this.terminalText = text;
  }
}

function isTerminalCodexAppServerEvent(event: unknown): boolean {
  if (!event || typeof event !== "object") return false;
  const type = (event as { type?: unknown }).type;
  return type === "result" || type === "turn.done" || type === "turn.completed";
}

function terminalResultText(event: unknown): string {
  if (!event || typeof event !== "object") return "";
  for (const key of ["result", "result_text", "text", "final_text"]) {
    const value = (event as Record<string, unknown>)[key];
    if (typeof value !== "string") continue;
    const resultText = value.trim();
    if (resultText) return resultText;
  }
  return "";
}

async function* streamSessionAfterHandoff(
  options: LinearbotOptions,
  input: ForwardSessionInput,
  onExecutionStarted?: (
    execution: LinearbotExecuteSessionResponse,
  ) => Promise<void>,
): AsyncIterable<LinearbotRendererSource> {
  // The working ack is already visible before this generator is consumed, so
  // the user has instant feedback while the cold sandbox spends seconds
  // spinning up. Execute runs here, inside the render stream, so a
  // sandbox-spawn failure surfaces in the same render rather than leaving the
  // run looking alive forever (api-rs writes no event if the spawn itself
  // fails). The synthetic starting item primes the mapper's task state so
  // answer deltas stream without the pre-stream grace delay.
  yield startingStreamNotification(input.threadId);
  traceLog(options, "linearbot_stream_heartbeat_emitted", input.trace);

  if (input.executeMessage) {
    try {
      const execution = await executeSessionTurn(options, input);
      if (execution) {
        // Scope the event stream we open below to this execution.
        input.executionId = execution.execution_id;
        await onExecutionStarted?.(execution);
      }
    } catch (error) {
      traceLog(options, "linearbot_forward_failed", input.trace, {
        error: errorMessage(error),
      });
      if (isRetryableSessionApiError(error)) throw error;
      yield sessionStreamError(error);
      return;
    }
  }

  let stream: AsyncIterable<LinearbotRendererSource>;
  try {
    stream = await openSessionEventStream(options, input);
  } catch (error) {
    traceLog(options, "linearbot_forward_failed", input.trace, {
      error: errorMessage(error),
    });
    if (isRetryableSessionApiError(error)) throw error;
    yield sessionStreamError(error);
    return;
  }

  for await (const event of stream) yield event;
}

function backgroundWaitUntil(promise: Promise<unknown>): void {
  const context = requestContext.getStore();
  if (context) {
    context.waitUntil(promise);
    return;
  }
  void promise.catch(() => undefined);
}

/**
 * Awaits the create/append handoff before acknowledging the webhook only for
 * the payloads that carry user messages, so a retryable session-api failure
 * can answer 503 and Linear redelivers.
 */
function shouldAwaitLinearHandoff(rawBody: string): boolean {
  try {
    const payload = JSON.parse(rawBody) as { action?: unknown; type?: unknown };
    if (payload.type === "AgentSessionEvent") return true;
    if (payload.type === "Comment" && payload.action === "create") return true;
    return payload.type === "Issue" && payload.action === "update";
  } catch {
    return false;
  }
}

// Vestigial wrapper kept so call sites diff cleanly against slackbotv2, whose
// rendererOptions hooks onRendererEvent to update the Slack assistant title
// (no Linear analog). Today it only forwards the configured mapper.
function rendererOptions(
  options: LinearbotOptions,
): CodexAppServerToChatStreamOptions {
  const mapper = options.mapper;
  return {
    ...mapper,
    async onRendererEvent(event: RendererEvent) {
      await mapper?.onRendererEvent?.(event);
    },
  };
}

function renderRetryDelayMs(attempt: number): number {
  return Math.min(
    RENDER_RETRY_INITIAL_DELAY_MS * 2 ** attempt,
    RENDER_RETRY_MAX_DELAY_MS,
  );
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function waitUntil(
  c: { executionCtx: WaitUntilContext },
  promise: Promise<unknown>,
): void {
  try {
    c.executionCtx.waitUntil(promise);
  } catch {
    void promise.catch(() => undefined);
  }
}
