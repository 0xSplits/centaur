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
  commentMentionsBot,
  CommentReplyCollector,
} from "./comment-bot";
import {
  EMPTY_PROMPT_INSTRUCTION,
  fetchIssueContextText,
} from "./linear-context";
import { ackWorking } from "./linear-narrator";
import { postIssueReply } from "./linear-reply";
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
import { errorMessage, noopLogger, nowMs, traceLog } from "./utils";

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
  // Init once, lazily, on the first webhook — idempotent and best-effort.
  let chatInitialized = false;
  const ensureChatInitialized = async (): Promise<void> => {
    if (chatInitialized) return;
    try {
      await chat.initialize();
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

type ThreadHandlerInput = {
  botUserId: string | undefined;
  chat: Chat<Record<string, Adapter>, LinearbotThreadState>;
  options: LinearbotOptions;
  state: StateAdapter;
};

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
  if (!commentMentionsBot(event.body, names, input.botUserId)) return null;
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
        thread,
        threadKey,
        trace,
      }),
    );
  })();
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
 * Runs one agent turn on a thread's sandbox and posts the result as a single
 * comment (answer + collapsed chain-of-thought). Seeds the issue context on the
 * thread's first turn. Best-effort with a bounded retry on transient
 * (cold-start) failures; a hard failure posts an error comment.
 */
async function runThreadTurn(input: {
  applyStatus: boolean;
  client: LinearSessionCapableAdapter["linearClient"];
  executeMessage: LinearbotApiMessage;
  issueId: string;
  options: LinearbotOptions;
  overrides: { harnessType?: string; model?: string };
  parentCommentId?: string;
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
    thread,
    threadKey,
    trace,
  } = input;
  const logger = options.logger ?? noopLogger;
  const threadState = (await thread.state) ?? {};
  const contextMessages: LinearbotApiMessage[] = [];
  if (!threadState.historyForwarded && client) {
    const contextText = await fetchIssueContextText(client, issueId, logger);
    if (contextText) {
      contextMessages.push(
        issueContextMessage(contextText, threadKey, executeMessage.timestamp),
      );
    }
  }
  let lastEventId = threadState.lastEventId ?? 0;
  const forwardInput: ForwardSessionInput = {
    afterEventId: lastEventId,
    executeMessage,
    harnessType: overrides.harnessType,
    messages: contextMessages,
    model: overrides.model,
    onEventId: (eventId) => {
      lastEventId = Math.max(lastEventId, eventId);
    },
    openStream: false,
    threadId: threadKey,
    trace,
  };
  let body: string | undefined;
  let marker: LinearStatusMarker | undefined;
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
      }
      await thread.setState({ historyForwarded: true });
      if (collector.failed) {
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
      body = `⚠️ I ran into an error before finishing: ${errorMessage(error)}`;
      break;
    }
  }
  if (client && body !== undefined) {
    try {
      await postIssueReply(client, { body, issueId, parentCommentId });
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
  traceLog(options, "linearbot_thread_turn_complete", trace, {
    chars: body?.length ?? 0,
  });
}

/** Synthetic issue-context message seeding a thread's first turn. */
function issueContextMessage(
  text: string,
  threadKey: string,
  timestamp: string,
): LinearbotApiMessage {
  return {
    attachments: [],
    author: {
      fullName: "Linear",
      isBot: true,
      isMe: false,
      userId: "linear",
      userName: "linear",
    },
    id: `linear-context-${threadKey}`,
    isMention: false,
    raw: { linearbotSyntheticContext: true },
    text,
    threadId: threadKey,
    timestamp,
  };
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
