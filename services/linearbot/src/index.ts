import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
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
  issueSessionsKey,
  isSessionThreadComment,
  parseIssueCommentWebhook,
  type IssueCommentEvent,
} from "./issue-comments";
import {
  buildLinearContextMessage,
  EMPTY_PROMPT_INSTRUCTION,
} from "./linear-context";
import { ackWorking, LinearNarrator } from "./linear-narrator";
import {
  extractStatusMarker,
  fetchIssueStatus,
  kickoffTargetState,
  markerTargetState,
  statusTraceFields,
  updateIssueState,
  type LinearIssueStatus,
  type LinearStatusMarker,
  type LinearWorkflowState,
} from "./linear-status";
import { parseLinearThreadKey } from "./linear-threading";
import { extractMessageOverrides } from "./overrides";
import {
  collectInitialContext,
  executeSessionTurn,
  forwardToSessionApi,
  harnessRestartPreamble,
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
  LinearbotMessageMode,
  LinearbotOptions,
  LinearbotRenderObligation,
  LinearbotRendererSource,
  LinearbotThreadState,
  LinearbotTrace,
  LinearSessionCapableAdapter,
} from "./types";
import {
  elapsedMs,
  errorMessage,
  isJsonObject,
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
const RENDER_OBLIGATION_INDEX_KEY = "linearbot:render:index";
const RENDER_OBLIGATION_INDEX_MAX_LENGTH = 2000;
// Linear delta: agent-session threads per issue, for routing plain issue
// comments into the session as context. Issues rarely host many sessions.
const SESSION_INDEX_MAX_LENGTH = 100;
const RENDER_INDEX_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const RENDER_RECOVERY_LEASE_TTL_MS = 2 * 60 * 1000;
const RENDER_LEASE_REFRESH_INTERVAL_MS = 60 * 1000;
const RENDER_RECOVERY_THREAD_TIMEOUT_MS = 2 * 60 * 1000;
const RENDER_RECOVERY_MAX_THREAD_FAILURES = 5;
const RENDER_RETRY_INITIAL_DELAY_MS = 250;
const RENDER_RETRY_MAX_DELAY_MS = 5_000;
// Linear delta (adopted from discordbot): cap the render retry loop. An
// unbounded loop replays the render from the original afterEventId forever
// (duplicating activities) whenever the error keeps classifying retryable.
// The persisted render obligation still lets the next restart retry.
const RENDER_RETRY_MAX_ATTEMPTS = 10;
// Linear comment/activity bodies are large (~100KB) but not unbounded; keep
// the final answer well under the cap with an honest truncation notice.
const LINEAR_FINAL_TEXT_MAX_CHARS = 50_000;
const POSTGRES_CONNECT_INITIAL_DELAY_MS = 250;
const POSTGRES_CONNECT_MAX_DELAY_MS = 10_000;
// Linear delta (adopted from discordbot): `activeExecution` persisted before
// the execution commit is only cleared by the render finally; a crash/SIGTERM
// in between would wedge the thread (Linear redelivers a failed webhook only
// a handful of times), so the flag is ignored once older than this TTL.
const ACTIVE_EXECUTION_TTL_MS = 30 * 60 * 1000;

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

  chat.onNewMention(async (thread, message) => {
    // Defense-in-depth (the chat SDK already drops isMe at intake): the
    // agent can create comments and delegate issues itself via the sandbox
    // linear tool, and its own activity must never start an execution.
    if (message.author.isMe) {
      traceLog(options, "linearbot_self_message_skipped", undefined, {
        message_id: message.id,
        thread_id: thread.id,
      });
      return;
    }
    // Linear requires a thought within 10s of the session starting; fire the
    // ephemeral working ack before any session-api work.
    ackWorking(thread, logger);
    await thread.subscribe();
    await recordSessionThread(state, thread, message, options);
    await syncThreadMessageToSession(thread, message, {
      mode: "execute",
      options,
      state,
    });
  });

  chat.onSubscribedMessage(async (thread, message) => {
    if (message.author.isMe) {
      traceLog(options, "linearbot_self_message_skipped", undefined, {
        message_id: message.id,
        thread_id: thread.id,
      });
      return;
    }
    const mode = message.isMention === true ? "execute" : "append";
    if (mode === "execute") ackWorking(thread, logger);
    await recordSessionThread(state, thread, message, options);
    await syncThreadMessageToSession(thread, message, {
      mode,
      options,
      state,
    });
  });

  const app = new Hono();
  app.get("/health", (c) => c.json({ ok: true, service: "linearbot" }));
  const handleLinearWebhook = async (c: Context) => {
    const rawBody = await c.req.raw.clone().text();
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
      // Linear delta: plain issue comments (outside any session thread) are
      // invisible to agent sessions — the adapter ignores Comment webhooks in
      // agent-sessions mode. Route them into the issue's known session
      // threads as append-only context. Runs inside the request context so a
      // retryable session-api failure 503s for redelivery, and only after the
      // adapter accepted the delivery (signature verified).
      const commentForward = requestContext.run(context, () =>
        forwardIssueCommentToSessions(rawBody, { chat, options, state }),
      );
      if (commentForward) handoffTasks.push(commentForward);
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

  if (options.recoverRenderObligationsOnStart !== false) {
    scheduleRenderObligationRecovery(chat, state, options);
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

/**
 * Persists a Linear thread update into the session API. In execute mode the
 * create/append handoff completes before the webhook is acknowledged; the
 * execute call and SSE rendering continue in background (the execute blocks on
 * cold sandbox spin-up, far past Linear's webhook deadline).
 */
async function syncThreadMessageToSession(
  thread: Thread<LinearbotThreadState>,
  message: ChatMessage,
  input: {
    mode: LinearbotMessageMode;
    options: LinearbotOptions;
    state: StateAdapter;
  },
): Promise<void> {
  const traceStartedAtMs = nowMs();
  const logger = input.options.logger ?? noopLogger;
  const state = (await thread.state) ?? {};
  const messageIds = new Set(state.forwardedMessageIds ?? []);
  const executedMessageIds = new Set(state.executedMessageIds ?? []);
  // Linear delta (adopted from discordbot): `state.activeExecution !== true`
  // upstream — a stale flag (crash before the render finally cleared it) must
  // not wedge the thread.
  const shouldStartExecution =
    input.mode === "execute" &&
    !hasLiveActiveExecution(
      state,
      input.options.activeExecutionTtlMs ?? ACTIVE_EXECUTION_TTL_MS,
    ) &&
    !executedMessageIds.has(message.id);
  const shouldIncludeContext =
    shouldStartExecution && state.historyForwarded !== true;
  const isDuplicateIncrementalMessage =
    messageIds.has(message.id) &&
    !shouldStartExecution &&
    !shouldIncludeContext;
  const trace: LinearbotTrace = {
    includeContext: shouldIncludeContext,
    messageId: message.id,
    mode: input.mode,
    openStream: shouldStartExecution,
    startedAtMs: traceStartedAtMs,
    threadId: thread.id,
  };
  if (isDuplicateIncrementalMessage) {
    traceLog(input.options, "linearbot_forward_duplicate_skipped", trace);
    return;
  }
  traceLog(input.options, "linearbot_forward_started", trace, {
    active_execution: state.activeExecution === true,
    history_forwarded: state.historyForwarded === true,
  });

  const serializeStartedAtMs = nowMs();
  const serializedMessage = await serializeMessage(message);
  const overrides = extractMessageOverrides(serializedMessage.text);
  serializedMessage.text = overrides.cleanedText;
  // Linear delta: a pure delegation (or description mention) has no prompt
  // text at all; synthesize the work-this-issue instruction instead of
  // executing an empty message (see EMPTY_PROMPT_INSTRUCTION).
  if (
    input.mode === "execute" &&
    !serializedMessage.text.trim() &&
    serializedMessage.attachments.length === 0
  ) {
    serializedMessage.text = EMPTY_PROMPT_INSTRUCTION;
    traceLog(input.options, "linearbot_empty_prompt_instruction", trace);
  }
  if (overrides.harnessType || overrides.model) {
    traceLog(input.options, "linearbot_forward_overrides_parsed", trace, {
      harness_type: overrides.harnessType,
      model: overrides.model,
    });
  }
  traceLog(input.options, "linearbot_forward_message_serialized", trace, {
    attachment_count: serializedMessage.attachments.length,
    phase_ms: elapsedMs(serializeStartedAtMs),
  });
  let context: LinearbotApiMessage[] | undefined;

  if (shouldIncludeContext && !state.historyForwarded) {
    const contextStartedAtMs = nowMs();
    context = await collectInitialContext(thread, message);
    // collectInitialContext re-serializes the current message; mirror the
    // flag-stripped text on that copy too.
    for (const item of context) {
      if (item.id === serializedMessage.id) item.text = serializedMessage.text;
    }
    // Linear delta: the comment thread alone misses the issue itself. Prepend
    // the synthetic issue-context message (Linear's promptContext blob, or a
    // subject-derived fallback) — the closest relative is discord-starter's
    // thread-starter prepend.
    const contextMessage = await buildLinearContextMessage(message, logger);
    if (contextMessage) {
      context = [
        contextMessage,
        ...context.filter((item) => item.id !== contextMessage.id),
      ];
    }
    traceLog(input.options, "linearbot_forward_context_collected", trace, {
      issue_context_included: contextMessage !== null,
      message_count: context.length,
      phase_ms: elapsedMs(contextStartedAtMs),
    });
  } else {
    traceLog(input.options, "linearbot_forward_context_skipped", trace, {
      message_count: 1,
    });
  }

  let lastEventId = state.lastEventId ?? 0;
  const renderLease: { release: (() => Promise<void>) | null } = {
    release: null,
  };
  const candidateMessages = context ?? [serializedMessage];
  const messagesToAppend = candidateMessages.filter(
    (item) => !messageIds.has(item.id),
  );

  const forwardInput: ForwardSessionInput = {
    afterEventId: lastEventId,
    executeMessage: shouldStartExecution ? serializedMessage : undefined,
    // A harness override only applies when this message starts an execution;
    // restarting the thread out from under an active execution would kill it.
    harnessType: shouldStartExecution ? overrides.harnessType : undefined,
    messages: messagesToAppend,
    model: overrides.model,
    onEventId: (eventId) => {
      lastEventId = Math.max(lastEventId, eventId);
    },
    openStream: false,
    threadId: thread.id,
    trace,
  };

  // The previous harness's conversation state dies with its sandbox on a
  // restart, so re-feed the issue + comment history with this turn. The
  // preamble lands on forwardInput, which executeSessionTurn reads when the
  // render stream runs the execute below.
  const handleSessionRestarted = async (): Promise<void> => {
    const history = context ?? (await collectInitialContext(thread, message));
    forwardInput.contextPreamble = harnessRestartPreamble(
      history,
      serializedMessage.id,
    );
    traceLog(input.options, "linearbot_forward_restart_context_built", trace, {
      history_message_count: history.length,
      preamble_chars: forwardInput.contextPreamble?.length ?? 0,
    });
  };

  const commitMessagesAppended = async (): Promise<void> => {
    const latest = (await thread.state) ?? {};
    const latestMessageIds = new Set(latest.forwardedMessageIds ?? []);
    for (const item of messagesToAppend) latestMessageIds.add(item.id);
    // Linear delta (adopted from discordbot): write ONLY the fields this
    // commit owns — setState merges via get-then-set, so echoing fields read
    // earlier (activeExecution, renderObligation) here can resurrect values
    // the background render's finally just cleared. lastEventId takes the max
    // against the freshly-read value so a concurrent stream's higher
    // watermark is never regressed.
    await thread.setState({
      forwardedMessageIds: Array.from(latestMessageIds).slice(-1000),
      historyForwarded: latest.historyForwarded || shouldIncludeContext,
      lastEventId: Math.max(latest.lastEventId ?? 0, lastEventId),
    });
    traceLog(input.options, "linearbot_forward_messages_committed", trace, {
      appended_message_count: messagesToAppend.length,
      forwarded_message_count: Math.min(latestMessageIds.size, 1000),
    });
  };

  const commitExecutionStarted = async (
    execution: LinearbotExecuteSessionResponse,
  ): Promise<void> => {
    const latest = (await thread.state) ?? {};
    const latestExecutedMessageIds = new Set(latest.executedMessageIds ?? []);
    latestExecutedMessageIds.add(serializedMessage.id);
    // Take the render lease before the obligation becomes visible so a
    // concurrent recovery sweep never claims it while this process is about
    // to render it live (upstream slackbotv2 #522).
    try {
      renderLease.release = await acquireRenderLease(input.state, thread.id);
    } catch (error) {
      traceLog(input.options, "linearbot_render_lease_acquire_failed", trace, {
        error: errorMessage(error),
      });
    }
    await thread.setState({
      activeExecution: true,
      // Refresh the staleness timestamp where the flag is legitimately
      // re-confirmed (see ACTIVE_EXECUTION_TTL_MS).
      activeExecutionStartedAt: Date.now(),
      executedMessageIds: Array.from(latestExecutedMessageIds).slice(-1000),
      lastEventId: Math.max(latest.lastEventId ?? 0, lastEventId),
      renderObligation: {
        afterEventId: lastEventId,
        executionId: execution.execution_id,
        message: serializedMessage,
      },
    });
    await indexRenderObligation(input.state, {
      options: input.options,
      threadId: thread.id,
      trace,
    });
    traceLog(input.options, "linearbot_forward_execution_committed", trace, {
      execution_id: execution.execution_id,
      executed_message_count: Math.min(latestExecutedMessageIds.size, 1000),
    });
  };

  if (!shouldStartExecution) {
    try {
      if (messagesToAppend.length > 0) {
        await forwardToSessionApi(input.options, forwardInput, {
          onMessagesAppended: commitMessagesAppended,
        });
      }
    } catch (error) {
      markRetryableForWebhookRedelivery(error, message, input, trace);
      throw error;
    }
    traceLog(input.options, "linearbot_forward_complete", trace);
    return;
  }

  try {
    await thread.setState({
      activeExecution: true,
      activeExecutionStartedAt: Date.now(),
    });
    traceLog(input.options, "linearbot_forward_active_execution_marked", trace);
    // Linear delta: kicking off work on an issue DELEGATED to the agent moves
    // it to the team's first started state ("In Progress"). Fire-and-forget —
    // mention-only sessions are filtered inside (the agent only owns issues
    // delegated to it), and failures never affect the run.
    backgroundWaitUntil(
      updateDelegatedIssueStatusOnKickoff(thread, input.options, trace),
    );
    // Create + append the session messages only (fast). The execute call
    // blocks on cold sandbox spin-up, so it runs inside the render stream
    // below — after the working ack landed — instead of before the webhook
    // response. executeSession is idempotent (idempotency_key = message id),
    // so a render retry won't re-spawn.
    await forwardToSessionApi(
      input.options,
      { ...forwardInput, executeMessage: undefined, openStream: false },
      {
        onMessagesAppended: commitMessagesAppended,
        onSessionRestarted: handleSessionRestarted,
      },
    );
    scheduleExecutionRender(
      thread,
      serializedMessage,
      input.options,
      forwardInput,
      () => lastEventId,
      renderLease,
      trace,
      commitExecutionStarted,
    );
    traceLog(input.options, "linearbot_forward_complete", trace, {
      last_event_id: lastEventId,
    });
  } catch (error) {
    // The live render is not happening; let the recovery sweep claim the
    // obligation (if one was committed) as soon as it scans.
    await renderLease.release?.();
    const latest = (await thread.state) ?? {};
    await thread.setState({
      activeExecution: false,
      activeExecutionStartedAt: null,
      lastEventId: Math.max(latest.lastEventId ?? 0, lastEventId),
    });
    if (isRetryableSessionApiError(error)) {
      markRetryableForWebhookRedelivery(error, message, input, trace);
      const context = requestContext.getStore();
      if (context) throw error;
    }
    try {
      await renderExecutionStream(
        thread,
        streamError(error),
        serializedMessage,
        input.options,
        trace,
      );
    } catch (renderError) {
      // The error notice is best-effort; a Linear render failure here must
      // not mask the original forward failure.
      traceLog(
        input.options,
        "linearbot_forward_error_notice_render_failed",
        trace,
        { error: errorMessage(renderError) },
      );
    }
    traceLog(input.options, "linearbot_forward_complete", trace, {
      latest_active_execution: latest.activeExecution === true,
      last_event_id: lastEventId,
    });
  }
}

/**
 * Marks a retryable session-api failure on the webhook request context so the
 * handler answers 503 and Linear redelivers; the chat SDK's dedupe key for
 * the message is cleared so the redelivery is processed rather than skipped.
 */
function markRetryableForWebhookRedelivery(
  error: unknown,
  message: ChatMessage,
  input: { options: LinearbotOptions; state: StateAdapter },
  trace: LinearbotTrace,
): void {
  if (!isRetryableSessionApiError(error)) return;
  const context = requestContext.getStore();
  if (!context) return;
  context.retryableErrors.push(error);
  context.waitUntil(
    input.state.delete(`dedupe:linear:${message.id}`).catch((deleteError) => {
      traceLog(
        input.options,
        "linearbot_webhook_retry_dedupe_clear_failed",
        trace,
        { error: errorMessage(deleteError) },
      );
    }),
  );
  traceLog(input.options, "linearbot_webhook_retry_marked", trace, {
    error: errorMessage(error),
  });
}

/**
 * Linear delta (adopted from discordbot): treat a persisted `activeExecution`
 * flag as live only while its staleness timestamp is within the TTL. A crash
 * between marking the flag and the render finally clearing it would otherwise
 * block `shouldStartExecution` until manual state surgery. Flags without a
 * timestamp count as stale.
 */
export function hasLiveActiveExecution(
  state: Pick<
    LinearbotThreadState,
    "activeExecution" | "activeExecutionStartedAt"
  >,
  ttlMs: number,
  nowEpochMs = Date.now(),
): boolean {
  if (state.activeExecution !== true) return false;
  if (typeof state.activeExecutionStartedAt !== "number") return false;
  return nowEpochMs - state.activeExecutionStartedAt <= ttlMs;
}

/**
 * Records an agent-session thread on its issue's session index (used to route
 * plain issue comments into the session) and pins the session's root comment
 * id for prompted-event dedupe. Best-effort: indexing must not fail the turn.
 */
async function recordSessionThread(
  state: StateAdapter,
  thread: Thread<LinearbotThreadState>,
  message: ChatMessage,
  options: LinearbotOptions,
): Promise<void> {
  try {
    const { issueId, agentSessionId } = parseLinearThreadKey(thread.id);
    if (!issueId || !agentSessionId) return;
    const threadState = (await thread.state) ?? {};
    const rootCommentId = sessionRootCommentIdFromMessage(message);
    if (threadState.sessionRootCommentId === rootCommentId) return;
    if (!threadState.sessionRootCommentId) {
      await state.appendToList(issueSessionsKey(issueId), thread.id, {
        maxLength: SESSION_INDEX_MAX_LENGTH,
        ttlMs: RENDER_INDEX_TTL_MS,
      });
      await thread.setState({ sessionRootCommentId: rootCommentId });
      return;
    }
    // A comment-less created event (description mention / bare delegation)
    // pinned a synthetic root; upgrade it once a prompted message reveals the
    // real comment thread Linear created for the session.
    if (threadState.sessionRootCommentId.startsWith("agent-session-")) {
      await thread.setState({ sessionRootCommentId: rootCommentId });
    }
  } catch (error) {
    traceLog(options, "linearbot_session_index_failed", undefined, {
      error: errorMessage(error),
      thread_id: thread.id,
    });
  }
}

/**
 * Root comment id of the session's comment thread: the triggering comment's
 * parent when the message is a reply (prompted events), else the comment
 * itself (the created event's root comment).
 */
function sessionRootCommentIdFromMessage(message: ChatMessage): string {
  const raw = message.raw;
  if (isJsonObject(raw) && raw.kind === "agent_session_comment") {
    const comment = raw.comment;
    if (isJsonObject(comment)) {
      const rootId = stringValue(comment.parentId) ?? stringValue(comment.id);
      if (rootId) return rootId;
    }
  }
  return message.id;
}

/**
 * Routes a plain issue comment (outside any agent-session comment thread)
 * into every known session thread on the issue as append-only context — no
 * execution, exactly like a non-mention subscribed message. Returns null when
 * the webhook is not a forwardable comment event. Retryable session-api
 * failures propagate so the webhook answers 503 and Linear redelivers;
 * forwardedMessageIds dedupes the replay.
 */
function forwardIssueCommentToSessions(
  rawBody: string,
  input: {
    chat: Chat<Record<string, Adapter>, LinearbotThreadState>;
    options: LinearbotOptions;
    state: StateAdapter;
  },
): Promise<void> | null {
  const event = parseIssueCommentWebhook(rawBody);
  if (!event) return null;
  return (async () => {
    const indexedThreadIds = await input.state.getList<string>(
      issueSessionsKey(event.issueId),
    );
    const threadIds = Array.from(new Set(indexedThreadIds));
    for (const threadId of threadIds) {
      const thread = input.chat.thread(threadId);
      const threadState = (await thread.state) ?? {};
      if (isSessionThreadComment(event, threadState.sessionRootCommentId)) {
        continue;
      }
      traceLog(input.options, "linearbot_issue_comment_forwarded", undefined, {
        comment_id: event.commentId,
        thread_id: threadId,
      });
      await syncThreadMessageToSession(
        thread,
        issueCommentMessage(event, threadId),
        { mode: "append", options: input.options, state: input.state },
      );
    }
  })();
}

/**
 * Minimal ChatMessage-shaped value for an issue comment; serializeMessage
 * only reads these fields, so the chat SDK Message class is not needed.
 */
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

/**
 * Linear delta: when the agent kicks off work on an issue DELEGATED to it,
 * move the issue out of Todo/Backlog/Triage into the team's first started
 * state. Never throws — status mutation is cosmetic, like narration.
 */
async function updateDelegatedIssueStatusOnKickoff(
  thread: Thread<LinearbotThreadState>,
  options: LinearbotOptions,
  trace?: LinearbotTrace,
): Promise<void> {
  try {
    const target = await delegatedStatusTarget(thread, kickoffTargetState);
    if (!target) return;
    await updateIssueState(target.client, target.issueId, target.state.id);
    traceLog(
      options,
      "linearbot_issue_kickoff_state_updated",
      trace,
      statusTraceFields(target.issueId, target.state),
    );
  } catch (error) {
    traceLog(options, "linearbot_issue_kickoff_state_failed", trace, {
      error: errorMessage(error),
    });
  }
}

/**
 * Applies the agent's terminal `Linear-Status: …` marker to the delegated
 * issue (backstop for when the agent could not move it via the sandbox
 * linear tool). Never throws.
 */
async function applyTerminalStatusMarker(
  thread: Thread,
  marker: LinearStatusMarker,
  options: LinearbotOptions,
  trace?: LinearbotTrace,
): Promise<void> {
  try {
    const target = await delegatedStatusTarget(thread, (status) =>
      markerTargetState(status, marker),
    );
    if (!target) return;
    await updateIssueState(target.client, target.issueId, target.state.id);
    traceLog(options, "linearbot_issue_marker_state_updated", trace, {
      status_marker: marker,
      ...statusTraceFields(target.issueId, target.state),
    });
  } catch (error) {
    traceLog(options, "linearbot_issue_marker_state_failed", trace, {
      error: errorMessage(error),
      status_marker: marker,
    });
  }
}

/**
 * Resolves the issue-status move for this thread, or null when no move should
 * happen: not an agent-session thread, no usable Linear client, the issue is
 * NOT delegated to the bot (mentions never move status), or the picker
 * declines (already in the right state).
 */
async function delegatedStatusTarget(
  thread: Thread,
  pick: (status: LinearIssueStatus) => LinearWorkflowState | undefined,
): Promise<{
  client: NonNullable<LinearSessionCapableAdapter["linearClient"]>;
  issueId: string;
  state: LinearWorkflowState;
} | null> {
  const { issueId, agentSessionId } = parseLinearThreadKey(thread.id);
  if (!issueId || !agentSessionId) return null;
  const adapter = thread.adapter as unknown as LinearSessionCapableAdapter;
  const client = adapter.linearClient;
  if (!client?.client?.rawRequest) return null;
  let botUserId: string | undefined;
  try {
    botUserId = adapter.botUserId;
  } catch {
    // The getter throws before the adapter is initialized.
    return null;
  }
  if (!botUserId) return null;
  const status = await fetchIssueStatus(client, issueId);
  if (!status || status.delegateId !== botUserId) return null;
  const state = pick(status);
  if (!state) return null;
  return { client, issueId, state };
}

function scheduleExecutionRender(
  thread: Thread<LinearbotThreadState>,
  message: LinearbotApiMessage,
  options: LinearbotOptions,
  input: ForwardSessionInput,
  getLastEventId: () => number,
  renderLease: { release: (() => Promise<void>) | null },
  trace?: LinearbotTrace,
  onExecutionStarted?: (
    execution: LinearbotExecuteSessionResponse,
  ) => Promise<void>,
): void {
  const promise = (async () => {
    try {
      let attempt = 0;
      while (true) {
        const result = await renderExecutionAttempt(
          thread,
          message,
          options,
          input,
          getLastEventId,
          trace,
          onExecutionStarted,
        );
        if (result === "complete") return;
        if (attempt >= RENDER_RETRY_MAX_ATTEMPTS) {
          traceLog(options, "linearbot_render_retries_exhausted", trace, {
            retry_attempts: attempt,
          });
          const latest = (await thread.state) ?? {};
          await thread.setState({
            activeExecution: false,
            activeExecutionStartedAt: null,
            lastEventId: Math.max(latest.lastEventId ?? 0, getLastEventId()),
          });
          await renderExecutionStream(
            thread,
            streamError(
              new Error(
                "Streaming retries exhausted; giving up on rendering this run.",
              ),
            ),
            message,
            options,
            trace,
          ).catch(() => undefined);
          return;
        }
        const delayMs = renderRetryDelayMs(attempt);
        attempt += 1;
        traceLog(options, "linearbot_render_retry_scheduled", trace, {
          retry_delay_ms: delayMs,
          retry_attempt: attempt,
        });
        await sleep(delayMs);
      }
    } finally {
      // The render settled (or gave up): hand the obligation back to the
      // recovery sweep's jurisdiction (upstream slackbotv2 #522).
      await renderLease.release?.();
    }
  })();
  backgroundWaitUntil(promise);
}

async function renderExecutionAttempt(
  thread: Thread<LinearbotThreadState>,
  message: LinearbotApiMessage,
  options: LinearbotOptions,
  input: ForwardSessionInput,
  getLastEventId: () => number,
  trace?: LinearbotTrace,
  onExecutionStarted?: (
    execution: LinearbotExecuteSessionResponse,
  ) => Promise<void>,
): Promise<"complete" | "retry"> {
  let rendered = false;
  let retry = false;
  try {
    await renderExecutionStream(
      thread,
      streamSessionAfterHandoff(options, input, onExecutionStarted),
      message,
      options,
      trace,
    );
    rendered = true;
    traceLog(options, "linearbot_render_complete", trace);
    return "complete";
  } catch (error) {
    if (isRetryableSessionApiError(error)) {
      retry = true;
      traceLog(options, "linearbot_render_deferred", trace, {
        error: errorMessage(error),
        last_event_id: getLastEventId(),
      });
      return "retry";
    }
    traceLog(options, "linearbot_render_failed", trace, {
      error: errorMessage(error),
    });
    throw error;
  } finally {
    const latest = (await thread.state) ?? {};
    await thread.setState({
      activeExecution: retry,
      activeExecutionStartedAt: retry ? Date.now() : null,
      lastEventId: Math.max(latest.lastEventId ?? 0, getLastEventId()),
      ...(rendered ? { renderObligation: null } : {}),
    });
    traceLog(options, "linearbot_render_finalized", trace, {
      obligation_cleared: rendered,
      retry_scheduled: retry,
      last_event_id: getLastEventId(),
    });
  }
}

function scheduleRenderObligationRecovery(
  chat: Chat<Record<string, Adapter>, LinearbotThreadState>,
  state: StateAdapter,
  options: LinearbotOptions,
): void {
  backgroundWaitUntil(recoverRenderObligationsWithRetry(chat, state, options));
}

async function recoverRenderObligationsWithRetry(
  chat: Chat<Record<string, Adapter>, LinearbotThreadState>,
  state: StateAdapter,
  options: LinearbotOptions,
): Promise<void> {
  // Wait for Postgres before scanning for obligations. This is also what warms the
  // shared pool at startup, so transient connect failures don't wedge the bot.
  await ensureStateConnected(state, options);
  const failureCounts = new Map<string, number>();
  let attempt = 0;
  while (true) {
    try {
      const deferredCount = await recoverRenderObligations(
        chat,
        state,
        options,
        failureCounts,
      );
      if (deferredCount === 0) return;
      const delayMs = renderRetryDelayMs(attempt);
      attempt += 1;
      traceLog(
        options,
        "linearbot_render_recovery_retry_scheduled",
        undefined,
        {
          deferred_count: deferredCount,
          retry_delay_ms: delayMs,
          retry_attempt: attempt,
        },
      );
      await sleep(delayMs);
    } catch (error) {
      traceLog(options, "linearbot_render_recovery_failed", undefined, {
        error: errorMessage(error),
      });
      return;
    }
  }
}

async function recoverRenderObligations(
  chat: Chat<Record<string, Adapter>, LinearbotThreadState>,
  state: StateAdapter,
  options: LinearbotOptions,
  failureCounts: Map<string, number>,
): Promise<number> {
  const startedAtMs = nowMs();
  await chat.initialize();
  const indexedThreadIds = await state.getList<string>(
    RENDER_OBLIGATION_INDEX_KEY,
  );
  const threadIds = Array.from(new Set(indexedThreadIds));
  const timeoutMs =
    options.renderRecoveryThreadTimeoutMs ?? RENDER_RECOVERY_THREAD_TIMEOUT_MS;
  let deferredCount = 0;
  traceLog(options, "linearbot_render_recovery_scan", undefined, {
    obligation_count: threadIds.length,
    phase_ms: elapsedMs(startedAtMs),
  });

  for (const threadId of threadIds) {
    try {
      const thread = chat.thread(threadId);
      const threadState = await thread.state;
      const obligation = threadState?.renderObligation;
      if (!obligation) continue;

      // An obligation that keeps failing non-retryably (for example corrupt
      // state that can never address a Linear session) must not poison the
      // retry loop forever: give up on it and unwedge the thread.
      if (
        (failureCounts.get(threadId) ?? 0) >=
        RENDER_RECOVERY_MAX_THREAD_FAILURES
      ) {
        traceLog(options, "linearbot_render_recovery_abandoned", undefined, {
          failure_count: failureCounts.get(threadId),
          thread_id: threadId,
        });
        await thread.setState({
          activeExecution: false,
          activeExecutionStartedAt: null,
          lastEventId: threadState?.lastEventId ?? 0,
          renderObligation: null,
        });
        continue;
      }

      const leaseToken = randomUUID();
      const leaseAcquired = await state.setIfNotExists(
        renderRecoveryLeaseKey(threadId),
        leaseToken,
        RENDER_RECOVERY_LEASE_TTL_MS,
      );
      if (!leaseAcquired) {
        // Another holder (or a lease from a crashed pass, pending TTL expiry)
        // owns this thread. Count it as deferred so the retry loop keeps
        // running until the obligation is actually resolved.
        deferredCount += 1;
        traceLog(
          options,
          "linearbot_render_recovery_lease_skipped",
          undefined,
          {
            thread_id: threadId,
          },
        );
        continue;
      }
      const releaseLease = async (): Promise<void> => {
        const activeLeaseToken = await state.get<string>(
          renderRecoveryLeaseKey(threadId),
        );
        if (activeLeaseToken === leaseToken)
          await state.delete(renderRecoveryLeaseKey(threadId));
      };

      // Linear delta (adopted from discordbot): the obligation above was read
      // BEFORE the lease; another worker may have completed or replaced it in
      // between. Re-read under the lease and recover the current value.
      const leasedObligation = (await thread.state)?.renderObligation;
      if (!leasedObligation) {
        await releaseLease();
        traceLog(
          options,
          "linearbot_render_recovery_obligation_gone",
          undefined,
          { thread_id: threadId },
        );
        continue;
      }

      // A single hung recovery (for example an event stream that never
      // produces a chunk) must not block every obligation queued behind it.
      // Race a deadline; on timeout move on and leave the attempt running
      // detached - it may still finish and clear the obligation, which is why
      // the lease is kept so a later pass does not start a duplicate render.
      const recovery = recoverRenderObligation(
        chat,
        state,
        options,
        threadId,
        leasedObligation,
      );
      let outcome: { timedOut: true } | { timedOut: false; deferred: boolean };
      try {
        outcome = await Promise.race([
          recovery.then((deferred) => ({ timedOut: false as const, deferred })),
          sleep(timeoutMs).then(() => ({ timedOut: true as const })),
        ]);
      } catch (error) {
        await releaseLease();
        throw error;
      }
      if (outcome.timedOut) {
        void recovery.catch(() => undefined);
        deferredCount += 1;
        // Count timeouts toward the abandonment budget (upstream slackbotv2
        // #522): an obligation whose recovery hangs on every claim (for
        // example an event stream that never yields) would otherwise keep the
        // sweep loop spinning forever, racing every live render.
        failureCounts.set(threadId, (failureCounts.get(threadId) ?? 0) + 1);
        traceLog(
          options,
          "linearbot_render_recovery_thread_timeout",
          undefined,
          {
            failure_count: failureCounts.get(threadId),
            thread_id: threadId,
            timeout_ms: timeoutMs,
          },
        );
        continue;
      }
      await releaseLease();
      if (outcome.deferred) deferredCount += 1;
    } catch (error) {
      // One thread's corrupt state or failed render must not abort the scan:
      // log it, count it as deferred so a later pass retries it (up to the
      // failure budget above), and keep recovering the remaining threads.
      failureCounts.set(threadId, (failureCounts.get(threadId) ?? 0) + 1);
      deferredCount += 1;
      traceLog(options, "linearbot_render_recovery_thread_failed", undefined, {
        error: errorMessage(error),
        failure_count: failureCounts.get(threadId),
        thread_id: threadId,
      });
    }
  }
  return deferredCount;
}

async function recoverRenderObligation(
  chat: Chat<Record<string, Adapter>, LinearbotThreadState>,
  state: StateAdapter,
  options: LinearbotOptions,
  threadId: string,
  obligation: LinearbotRenderObligation,
): Promise<boolean> {
  const trace: LinearbotTrace = {
    includeContext: false,
    messageId: obligation.message.id,
    mode: "execute",
    openStream: true,
    startedAtMs: nowMs(),
    threadId,
  };
  const thread = chat.thread(threadId);
  // Replay from the obligation's starting position, not the thread's
  // lastEventId: the failed render may have consumed events (including the
  // terminal result) past which a resumed stream would never see the final
  // answer again. Session events are durable, so a full replay is safe.
  let lastEventId = obligation.afterEventId;
  const input: ForwardSessionInput = {
    afterEventId: obligation.afterEventId,
    executionId: obligation.executionId,
    messages: [],
    onEventId: (eventId) => {
      lastEventId = Math.max(lastEventId, eventId);
    },
    openStream: false,
    threadId,
    trace,
  };

  let openedStream: AsyncIterable<LinearbotRendererSource>;
  try {
    openedStream = await openSessionEventStream(options, input);
  } catch (error) {
    const retryable = isRetryableSessionApiError(error);
    traceLog(options, "linearbot_render_recovery_deferred", trace, {
      error: errorMessage(error),
      last_event_id: lastEventId,
      retryable,
    });
    if (retryable) return true;
    await renderExecutionStream(
      thread,
      streamError(error),
      obligation.message,
      options,
      trace,
    );
    await thread.setState({
      activeExecution: false,
      activeExecutionStartedAt: null,
      lastEventId,
      renderObligation: null,
    });
    return false;
  }

  let rendered = false;
  try {
    await thread.setState({
      activeExecution: true,
      activeExecutionStartedAt: Date.now(),
      lastEventId,
    });
    await renderExecutionStream(
      thread,
      streamOpenedSession(input, openedStream),
      obligation.message,
      options,
      trace,
    );
    rendered = true;
    traceLog(options, "linearbot_render_recovery_complete", trace);
  } catch (error) {
    traceLog(options, "linearbot_render_recovery_render_failed", trace, {
      error: errorMessage(error),
    });
    throw error;
  } finally {
    const latest = (await thread.state) ?? {};
    await thread.setState({
      activeExecution: false,
      activeExecutionStartedAt: null,
      lastEventId: Math.max(latest.lastEventId ?? 0, lastEventId),
      ...(rendered ? { renderObligation: null } : {}),
    });
    traceLog(options, "linearbot_render_recovery_finalized", trace, {
      obligation_cleared: rendered,
      last_event_id: lastEventId,
    });
  }
  return false;
}

async function indexRenderObligation(
  state: StateAdapter,
  input: {
    options: LinearbotOptions;
    threadId: string;
    trace?: LinearbotTrace;
  },
): Promise<void> {
  await state.appendToList(RENDER_OBLIGATION_INDEX_KEY, input.threadId, {
    maxLength: RENDER_OBLIGATION_INDEX_MAX_LENGTH,
    ttlMs: RENDER_INDEX_TTL_MS,
  });
  traceLog(input.options, "linearbot_render_obligation_indexed", input.trace);
}

async function* streamOpenedSession(
  input: Pick<ForwardSessionInput, "threadId" | "trace">,
  stream: AsyncIterable<LinearbotRendererSource>,
): AsyncIterable<LinearbotRendererSource> {
  // The synthetic starting item primes the mapper's task state so answer
  // deltas stream immediately instead of waiting out the pre-stream grace
  // period (adopted from discordbot).
  yield startingStreamNotification(input.threadId);
  for await (const event of stream) yield event;
}

function renderRecoveryLeaseKey(threadId: string): string {
  return `linearbot:render:lease:${threadId}`;
}

/**
 * Holds the per-thread render lease for the duration of a live render so the
 * recovery sweep cannot claim the just-indexed obligation and post a
 * duplicate answer (it lease-skips instead). The TTL keeps this crash-safe:
 * if the pod dies mid-render the lease expires and recovery takes over. The
 * lease is refreshed while the render runs because agent turns routinely
 * outlive a single TTL window. (Ported from slackbotv2 #522.)
 */
async function acquireRenderLease(
  state: StateAdapter,
  threadId: string,
): Promise<() => Promise<void>> {
  const key = renderRecoveryLeaseKey(threadId);
  const token = randomUUID();
  await state.set(key, token, RENDER_RECOVERY_LEASE_TTL_MS);
  const refresh = setInterval(() => {
    void state
      .get<string>(key)
      .then((current) =>
        current === token
          ? state.set(key, token, RENDER_RECOVERY_LEASE_TTL_MS)
          : undefined,
      )
      .catch(() => undefined);
  }, RENDER_LEASE_REFRESH_INTERVAL_MS);
  return async () => {
    clearInterval(refresh);
    try {
      const current = await state.get<string>(key);
      if (current === token) await state.delete(key);
    } catch {
      // Best effort: TTL expiry is the backstop.
    }
  };
}

/**
 * Renders one execution onto the Linear agent session, fully append-only:
 * reasoning blurbs and tool runs post as thought/action activities while the
 * run progresses (the narrator), and the final answer posts exactly once at
 * the end — as the session's `response` activity on success, or an `error`
 * activity when the run failed. There is no mid-answer streaming: activities
 * cannot be edited, and Linear's session UI is built around the activity
 * timeline rather than a live growing message.
 */
async function renderExecutionStream(
  thread: Thread,
  stream: AsyncIterable<LinearbotRendererSource>,
  message: LinearbotApiMessage,
  options: LinearbotOptions,
  trace?: LinearbotTrace,
): Promise<void> {
  const logger = options.logger ?? noopLogger;
  void message;
  const narrator = LinearNarrator.start(thread, {
    logger,
    maxActivities: options.narratorMaxActivities,
    minPostGapMs: options.narratorMinPostGapMs,
  });
  try {
    const finalText = await collectActivityStream(stream, options, narrator);
    let marker: LinearStatusMarker | undefined;
    if (narrator.failed) {
      await narrator.finish("failed", finalText);
    } else {
      // Linear delta: the agent can signal the delegated issue's terminal
      // status with a `Linear-Status: …` line; strip it from the posted
      // answer and apply it as a backstop after the response lands.
      const extracted = extractStatusMarker(finalText);
      marker = extracted.marker;
      // Flush remaining thoughts before the response so the timeline reads
      // in order; the response activity is what settles the session.
      await narrator.finish("done");
      await thread.post(extracted.text.trim() ? extracted.text : finalText);
      if (marker) {
        backgroundWaitUntil(
          applyTerminalStatusMarker(thread, marker, options, trace),
        );
      }
    }
    traceLog(options, "linearbot_render_final", trace, {
      chars: finalText.length,
      failed: narrator.failed,
      ...(marker ? { status_marker: marker } : {}),
    });
  } catch (error) {
    await narrator.finish(
      isRetryableSessionApiError(error) ? "retrying" : "failed",
      errorMessage(error),
    );
    throw error;
  }
}

/**
 * Consumes the renderer's chunk stream, routing task/plan updates to the
 * narrator and accumulating answer text; returns the final answer text (or
 * the durable terminal result when no markdown was streamed).
 */
async function collectActivityStream(
  stream: AsyncIterable<LinearbotRendererSource>,
  options: LinearbotOptions,
  narrator: LinearNarrator,
): Promise<string> {
  const fallback = new LinearRenderFallback();
  let answer = "";
  for await (const chunk of codexAppServerToChatSdkStream(
    fallback.collectSource(stream),
    rendererOptions(options),
  )) {
    if (chunk.type === "markdown_text") {
      answer += chunk.text;
      continue;
    }
    narrator.update(chunk);
  }
  const text =
    answer.trim() ||
    fallback.text() ||
    "Execution completed, but no final text was captured.";
  return truncateLinearText(text, LINEAR_FINAL_TEXT_MAX_CHARS, "final answer");
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

function truncateLinearText(
  value: string,
  maxChars: number,
  label: string,
): string {
  if (value.length <= maxChars) return value;
  let omitted = value.length - maxChars;
  while (true) {
    const suffix = `\n[truncated ${omitted} chars from ${label}]`;
    const keep = Math.max(0, maxChars - suffix.length);
    const actualOmitted = value.length - keep;
    if (actualOmitted === omitted)
      return `${value.slice(0, keep).trimEnd()}${suffix}`;
    omitted = actualOmitted;
  }
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

async function* streamError(
  error: unknown,
): AsyncIterable<LinearbotRendererSource> {
  yield sessionStreamError(error);
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
    return payload.type === "Comment" && payload.action === "create";
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
