import { randomUUID } from "node:crypto";
import {
  codexAppServerToChatSdkStream,
  type ChatSDKStreamChunk,
  type CodexAppServerToChatStreamOptions,
  type RendererEvent,
} from "@centaur/rendering";
import { createDiscordAdapter } from "@chat-adapter/discord";
import { createPostgresState } from "@chat-adapter/state-pg";
import {
  Chat,
  StreamingPlan,
  type Adapter,
  type Logger,
  type Message as ChatMessage,
  type StateAdapter,
  type Thread,
} from "chat";
import { Hono } from "hono";
import pg from "pg";
import {
  isAllowedDiscordMessage,
  isGuildAllowlistEmpty,
} from "./discord-allowlist";
import { deriveThreadName, renameThreadFromMessage } from "./discord-threading";
import {
  collectInitialContext,
  executeSessionTurn,
  forwardToSessionApi,
  isRetryableSessionApiError,
  openSessionEventStream,
  serializeMessage,
  sessionStreamError,
  startingStreamNotification,
} from "./session-api";
import type {
  Discordbot,
  DiscordbotApiMessage,
  DiscordbotExecuteSessionResponse,
  DiscordbotMessageMode,
  DiscordbotOptions,
  DiscordbotRenderObligation,
  DiscordbotRendererSource,
  DiscordbotThreadState,
  DiscordbotTrace,
  ForwardSessionInput,
  TypingCapableAdapter,
} from "./types";
import { elapsedMs, errorMessage, noopLogger, nowMs, traceLog } from "./utils";

export type {
  Discordbot,
  DiscordbotApiAttachment,
  DiscordbotApiAuthor,
  DiscordbotApiMessage,
  DiscordbotAppendMessagesRequest,
  DiscordbotCreateSessionRequest,
  DiscordbotExecuteSessionRequest,
  DiscordbotExecuteSessionResponse,
  DiscordbotFetch,
  DiscordbotOptions,
  DiscordbotSessionMessage,
  DiscordbotSessionMessageRole,
} from "./types";

const TYPING_KEEPALIVE_MS = 8000;
const RENDER_OBLIGATION_INDEX_KEY = "discordbot:render:index";
const RENDER_OBLIGATION_INDEX_MAX_LENGTH = 2000;
const RENDER_INDEX_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const RENDER_RECOVERY_LEASE_TTL_MS = 2 * 60 * 1000;
const RENDER_RETRY_INITIAL_DELAY_MS = 250;
const RENDER_RETRY_MAX_DELAY_MS = 5_000;
const DISCORD_TASK_DETAILS_MAX_CHARS = 500;
const POSTGRES_CONNECT_INITIAL_DELAY_MS = 250;
const POSTGRES_CONNECT_MAX_DELAY_MS = 10_000;

export function createDiscordbot(options: DiscordbotOptions): Discordbot {
  const userName = options.userName ?? "centaur";
  const logger = options.logger ?? noopLogger;

  if (isGuildAllowlistEmpty(options)) {
    logger.warn("discordbot_guild_allowlist_empty_inert", {
      hint: "Set DISCORDBOT_GUILD_ALLOWLIST; the bot ignores all messages until configured.",
    });
  }

  const discord = createDiscordAdapter({
    apiUrl: options.discordApiUrl,
    applicationId: options.applicationId,
    botToken: options.botToken,
    publicKey: options.publicKey,
    mentionRoleIds: options.mentionRoleIds,
    userName,
    logger,
  });
  const state = options.state ?? createDefaultState(options, logger);
  const chat = new Chat<{ discord: typeof discord }, DiscordbotThreadState>({
    userName,
    adapters: { discord },
    state,
    // Initial placeholder posted while the agent works, before any streamed
    // content (the chat SDK default is a bare "..."). Overridable via options.
    fallbackStreamingPlaceholderText:
      options.streamingPlaceholderText ?? "✨ thinking...",
    // Serialize handlers per thread via the SDK's per-thread lock. The deprecated
    // `onLockConflict: 'force'` force-released the lock so two handlers ran concurrently on one
    // thread — two near-simultaneous mentions could both pass the `activeExecution` check and
    // double-execute. `'drop'` keeps the lock: a second message that lands while a handler holds the
    // thread lock is dropped rather than run in parallel. Same code path as before for the
    // no-contention case, so single-message streaming is unchanged.
    concurrency: "drop",
    logger,
  });

  chat.onNewMention(async (thread, message) => {
    if (!isAllowedDiscordMessage(message, options, logger)) return;
    await thread.subscribe();
    await syncThreadMessageToSession(thread, message, {
      mode: "execute",
      options,
      state,
    });
  });

  chat.onSubscribedMessage(async (thread, message) => {
    if (!isAllowedDiscordMessage(message, options, logger)) return;
    await syncThreadMessageToSession(thread, message, {
      mode: message.isMention === true ? "execute" : "append",
      options,
      state,
    });
  });

  const app = new Hono();
  app.get("/health", (c) => {
    const gatewayActive = options.isGatewayActive
      ? options.isGatewayActive()
      : true;
    return c.json(
      { ok: gatewayActive, service: "discordbot", gateway: gatewayActive },
      gatewayActive ? 200 : 503,
    );
  });

  if (options.recoverRenderObligationsOnStart !== false) {
    scheduleRenderObligationRecovery(chat, state, options);
  }

  return { app, chat, adapter: discord };
}

function createDefaultState(
  options: DiscordbotOptions,
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
    keyPrefix: options.stateKeyPrefix ?? "centaur-discordbot",
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
  options: DiscordbotOptions,
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await state.connect();
      if (attempt > 0) {
        traceLog(options, "discordbot_postgres_connected", undefined, {
          attempts: attempt + 1,
        });
      }
      return;
    } catch (error) {
      const delayMs = Math.min(
        POSTGRES_CONNECT_INITIAL_DELAY_MS * 2 ** attempt,
        POSTGRES_CONNECT_MAX_DELAY_MS,
      );
      traceLog(options, "discordbot_postgres_connect_retry", undefined, {
        attempt: attempt + 1,
        delay_ms: delayMs,
        error: errorMessage(error),
      });
      await sleep(delayMs);
    }
  }
}

/**
 * Persists a Discord thread update into the session API. In execute mode the create/append/execute
 * handoff completes before the handler returns; SSE rendering continues in background.
 */
async function syncThreadMessageToSession(
  thread: Thread<DiscordbotThreadState>,
  message: ChatMessage,
  input: {
    mode: DiscordbotMessageMode;
    options: DiscordbotOptions;
    state: StateAdapter;
  },
): Promise<void> {
  const traceStartedAtMs = nowMs();
  const state = (await thread.state) ?? {};
  const messageIds = new Set(state.forwardedMessageIds ?? []);
  const executedMessageIds = new Set(state.executedMessageIds ?? []);
  const shouldStartExecution =
    input.mode === "execute" &&
    state.activeExecution !== true &&
    !executedMessageIds.has(message.id);
  const shouldIncludeContext =
    shouldStartExecution && state.historyForwarded !== true;
  const isDuplicateIncrementalMessage =
    messageIds.has(message.id) &&
    !shouldStartExecution &&
    !shouldIncludeContext;
  const trace: DiscordbotTrace = {
    includeContext: shouldIncludeContext,
    messageId: message.id,
    mode: input.mode,
    openStream: shouldStartExecution,
    startedAtMs: traceStartedAtMs,
    threadId: thread.id,
  };
  if (isDuplicateIncrementalMessage) {
    traceLog(input.options, "discordbot_forward_duplicate_skipped", trace);
    return;
  }
  traceLog(input.options, "discordbot_forward_started", trace, {
    active_execution: state.activeExecution === true,
    history_forwarded: state.historyForwarded === true,
  });

  const serializeStartedAtMs = nowMs();
  const serializedMessage = await serializeMessage(message);
  traceLog(input.options, "discordbot_forward_message_serialized", trace, {
    attachment_count: serializedMessage.attachments.length,
    phase_ms: elapsedMs(serializeStartedAtMs),
  });
  let context: DiscordbotApiMessage[] | undefined;

  if (shouldIncludeContext && !state.historyForwarded) {
    const contextStartedAtMs = nowMs();
    context = await collectInitialContext(thread, message);
    traceLog(input.options, "discordbot_forward_context_collected", trace, {
      message_count: context.length,
      phase_ms: elapsedMs(contextStartedAtMs),
    });
  } else {
    traceLog(input.options, "discordbot_forward_context_skipped", trace, {
      message_count: 1,
    });
  }

  let lastEventId = state.lastEventId ?? 0;
  const candidateMessages = context ?? [serializedMessage];
  const messagesToAppend = candidateMessages.filter(
    (item) => !messageIds.has(item.id),
  );

  const forwardInput: ForwardSessionInput = {
    afterEventId: lastEventId,
    executeMessage: shouldStartExecution ? serializedMessage : undefined,
    messages: messagesToAppend,
    onEventId: (eventId) => {
      lastEventId = Math.max(lastEventId, eventId);
    },
    openStream: false,
    threadId: thread.id,
    trace,
  };

  const commitMessagesAppended = async (): Promise<void> => {
    const latest = (await thread.state) ?? {};
    const latestMessageIds = new Set(latest.forwardedMessageIds ?? []);
    for (const item of messagesToAppend) latestMessageIds.add(item.id);
    await thread.setState({
      forwardedMessageIds: Array.from(latestMessageIds).slice(-1000),
      historyForwarded: latest.historyForwarded || shouldIncludeContext,
      lastEventId,
    });
    traceLog(input.options, "discordbot_forward_messages_committed", trace, {
      appended_message_count: messagesToAppend.length,
      forwarded_message_count: Math.min(latestMessageIds.size, 1000),
    });
  };

  const commitExecutionStarted = async (
    execution: DiscordbotExecuteSessionResponse,
  ): Promise<void> => {
    const latest = (await thread.state) ?? {};
    const latestExecutedMessageIds = new Set(latest.executedMessageIds ?? []);
    latestExecutedMessageIds.add(serializedMessage.id);
    await thread.setState({
      activeExecution: true,
      executedMessageIds: Array.from(latestExecutedMessageIds).slice(-1000),
      lastEventId,
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
    traceLog(input.options, "discordbot_forward_execution_committed", trace, {
      execution_id: execution.execution_id,
      executed_message_count: Math.min(latestExecutedMessageIds.size, 1000),
    });
  };

  if (!shouldStartExecution) {
    if (messagesToAppend.length > 0) {
      await forwardToSessionApi(input.options, forwardInput, {
        onMessagesAppended: commitMessagesAppended,
      });
    }
    traceLog(input.options, "discordbot_forward_complete", trace);
    return;
  }

  try {
    await thread.setState({ activeExecution: true });
    traceLog(
      input.options,
      "discordbot_forward_active_execution_marked",
      trace,
    );
    // Create + append the session message only (fast). The execute call blocks
    // ~9s on cold sandbox spin-up (incl. the tool-server sidecar), so it's run
    // inside the render stream below — after the "✨ thinking..." placeholder is
    // posted — instead of before it. executeSession is idempotent
    // (idempotency_key = message id), so a render retry won't re-spawn.
    await forwardToSessionApi(
      input.options,
      { ...forwardInput, executeMessage: undefined, openStream: false },
      { onMessagesAppended: commitMessagesAppended },
    );
    scheduleExecutionRender(
      thread,
      serializedMessage,
      input.options,
      forwardInput,
      () => lastEventId,
      shouldIncludeContext,
      trace,
      commitExecutionStarted,
    );
    traceLog(input.options, "discordbot_forward_complete", trace, {
      last_event_id: lastEventId,
    });
  } catch (error) {
    const latest = (await thread.state) ?? {};
    await thread.setState({
      activeExecution: false,
      lastEventId: Math.max(latest.lastEventId ?? 0, lastEventId),
    });
    // Discord ingress arrives via the Gateway, so there is no webhook retry to request
    // (slackbotv2 answers 503 to make Slack re-deliver). Surface the failure in-thread instead.
    await renderExecutionStream(
      thread,
      streamError(error),
      serializedMessage,
      input.options,
      false,
      trace,
    );
    traceLog(input.options, "discordbot_forward_complete", trace, {
      latest_active_execution: latest.activeExecution === true,
      last_event_id: lastEventId,
    });
  }
}

function scheduleExecutionRender(
  thread: Thread<DiscordbotThreadState>,
  message: DiscordbotApiMessage,
  options: DiscordbotOptions,
  input: ForwardSessionInput,
  getLastEventId: () => number,
  isInitialExecution: boolean,
  trace?: DiscordbotTrace,
  onExecutionStarted?: (
    execution: DiscordbotExecuteSessionResponse,
  ) => Promise<void>,
): void {
  const promise = (async () => {
    let attempt = 0;
    while (true) {
      const result = await renderExecutionAttempt(
        thread,
        message,
        options,
        input,
        getLastEventId,
        isInitialExecution,
        trace,
        onExecutionStarted,
      );
      if (result === "complete") return;
      const delayMs = renderRetryDelayMs(attempt);
      attempt += 1;
      traceLog(options, "discordbot_render_retry_scheduled", trace, {
        retry_delay_ms: delayMs,
        retry_attempt: attempt,
      });
      await sleep(delayMs);
    }
  })();
  backgroundWaitUntil(promise);
}

async function renderExecutionAttempt(
  thread: Thread<DiscordbotThreadState>,
  message: DiscordbotApiMessage,
  options: DiscordbotOptions,
  input: ForwardSessionInput,
  getLastEventId: () => number,
  isInitialExecution: boolean,
  trace?: DiscordbotTrace,
  onExecutionStarted?: (
    execution: DiscordbotExecuteSessionResponse,
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
      isInitialExecution,
      trace,
    );
    rendered = true;
    traceLog(options, "discordbot_render_complete", trace);
    return "complete";
  } catch (error) {
    if (isRetryableSessionApiError(error)) {
      retry = true;
      traceLog(options, "discordbot_render_deferred", trace, {
        error: errorMessage(error),
        last_event_id: getLastEventId(),
      });
      return "retry";
    }
    traceLog(options, "discordbot_render_failed", trace, {
      error: errorMessage(error),
    });
    throw error;
  } finally {
    const latest = (await thread.state) ?? {};
    await thread.setState({
      activeExecution: retry,
      lastEventId: Math.max(latest.lastEventId ?? 0, getLastEventId()),
      ...(rendered ? { renderObligation: null } : {}),
    });
    traceLog(options, "discordbot_render_finalized", trace, {
      obligation_cleared: rendered,
      retry_scheduled: retry,
      last_event_id: getLastEventId(),
    });
  }
}

function scheduleRenderObligationRecovery(
  chat: Chat<Record<string, Adapter>, DiscordbotThreadState>,
  state: StateAdapter,
  options: DiscordbotOptions,
): void {
  backgroundWaitUntil(recoverRenderObligationsWithRetry(chat, state, options));
}

async function recoverRenderObligationsWithRetry(
  chat: Chat<Record<string, Adapter>, DiscordbotThreadState>,
  state: StateAdapter,
  options: DiscordbotOptions,
): Promise<void> {
  // Wait for Postgres before scanning for obligations. This is also what warms the
  // shared pool at startup, so transient connect failures don't wedge the bot.
  await ensureStateConnected(state, options);
  let attempt = 0;
  while (true) {
    try {
      const deferredCount = await recoverRenderObligations(
        chat,
        state,
        options,
      );
      if (deferredCount === 0) return;
      const delayMs = renderRetryDelayMs(attempt);
      attempt += 1;
      traceLog(
        options,
        "discordbot_render_recovery_retry_scheduled",
        undefined,
        {
          deferred_count: deferredCount,
          retry_delay_ms: delayMs,
          retry_attempt: attempt,
        },
      );
      await sleep(delayMs);
    } catch (error) {
      traceLog(options, "discordbot_render_recovery_failed", undefined, {
        error: errorMessage(error),
      });
      return;
    }
  }
}

async function recoverRenderObligations(
  chat: Chat<Record<string, Adapter>, DiscordbotThreadState>,
  state: StateAdapter,
  options: DiscordbotOptions,
): Promise<number> {
  const startedAtMs = nowMs();
  await chat.initialize();
  const indexedThreadIds = await state.getList<string>(
    RENDER_OBLIGATION_INDEX_KEY,
  );
  const threadIds = Array.from(new Set(indexedThreadIds));
  let deferredCount = 0;
  traceLog(options, "discordbot_render_recovery_scan", undefined, {
    obligation_count: threadIds.length,
    phase_ms: elapsedMs(startedAtMs),
  });

  for (const threadId of threadIds) {
    const thread = chat.thread(threadId);
    const threadState = await thread.state;
    const obligation = threadState?.renderObligation;
    if (!obligation) continue;

    const leaseToken = randomUUID();
    const leaseAcquired = await state.setIfNotExists(
      renderRecoveryLeaseKey(threadId),
      leaseToken,
      RENDER_RECOVERY_LEASE_TTL_MS,
    );
    if (!leaseAcquired) {
      traceLog(options, "discordbot_render_recovery_lease_skipped", undefined, {
        thread_id: threadId,
      });
      continue;
    }

    try {
      if (
        await recoverRenderObligation(
          chat,
          state,
          options,
          threadId,
          obligation,
        )
      ) {
        deferredCount += 1;
      }
    } finally {
      const activeLeaseToken = await state.get<string>(
        renderRecoveryLeaseKey(threadId),
      );
      if (activeLeaseToken === leaseToken) {
        await state.delete(renderRecoveryLeaseKey(threadId));
      }
    }
  }
  return deferredCount;
}

async function recoverRenderObligation(
  chat: Chat<Record<string, Adapter>, DiscordbotThreadState>,
  state: StateAdapter,
  options: DiscordbotOptions,
  threadId: string,
  obligation: DiscordbotRenderObligation,
): Promise<boolean> {
  const trace: DiscordbotTrace = {
    includeContext: false,
    messageId: obligation.message.id,
    mode: "execute",
    openStream: true,
    startedAtMs: nowMs(),
    threadId,
  };
  const thread = chat.thread(threadId);
  const threadState = (await thread.state) ?? {};
  let lastEventId = Math.max(
    threadState.lastEventId ?? 0,
    obligation.afterEventId,
  );
  const input: ForwardSessionInput = {
    afterEventId: lastEventId,
    executionId: obligation.executionId,
    messages: [],
    onEventId: (eventId) => {
      lastEventId = Math.max(lastEventId, eventId);
    },
    openStream: false,
    threadId,
    trace,
  };

  let openedStream: AsyncIterable<DiscordbotRendererSource>;
  try {
    openedStream = await openSessionEventStream(options, input);
  } catch (error) {
    const retryable = isRetryableSessionApiError(error);
    traceLog(options, "discordbot_render_recovery_deferred", trace, {
      error: errorMessage(error),
      last_event_id: lastEventId,
      retryable,
    });
    if (retryable) return true;
    await renderRecoveredExecutionStream(
      thread,
      streamError(error),
      obligation.message,
      options,
      trace,
    );
    await thread.setState({
      activeExecution: false,
      lastEventId,
      renderObligation: null,
    });
    return false;
  }

  let rendered = false;
  try {
    await thread.setState({
      activeExecution: true,
      lastEventId,
    });
    await renderRecoveredExecutionStream(
      thread,
      streamOpenedSession(input, openedStream),
      obligation.message,
      options,
      trace,
    );
    rendered = true;
    traceLog(options, "discordbot_render_recovery_complete", trace);
  } catch (error) {
    traceLog(options, "discordbot_render_recovery_render_failed", trace, {
      error: errorMessage(error),
    });
    throw error;
  } finally {
    const latest = (await thread.state) ?? {};
    await thread.setState({
      activeExecution: false,
      lastEventId: Math.max(latest.lastEventId ?? 0, lastEventId),
      ...(rendered ? { renderObligation: null } : {}),
    });
    traceLog(options, "discordbot_render_recovery_finalized", trace, {
      obligation_cleared: rendered,
      last_event_id: lastEventId,
    });
  }
  return false;
}

async function indexRenderObligation(
  state: StateAdapter,
  input: {
    options: DiscordbotOptions;
    threadId: string;
    trace?: DiscordbotTrace;
  },
): Promise<void> {
  await state.appendToList(RENDER_OBLIGATION_INDEX_KEY, input.threadId, {
    maxLength: RENDER_OBLIGATION_INDEX_MAX_LENGTH,
    ttlMs: RENDER_INDEX_TTL_MS,
  });
  traceLog(input.options, "discordbot_render_obligation_indexed", input.trace);
}

async function* streamOpenedSession(
  input: Pick<ForwardSessionInput, "threadId" | "trace">,
  stream: AsyncIterable<DiscordbotRendererSource>,
): AsyncIterable<DiscordbotRendererSource> {
  // Deliberate delta from slackbotv2 (which removed its synthetic starting
  // task): the synthetic item drives the instant "✨ thinking..." placeholder.
  yield startingStreamNotification(input.threadId);
  for await (const event of stream) yield event;
}

function renderRecoveryLeaseKey(threadId: string): string {
  return `discordbot:render:lease:${threadId}`;
}

async function renderExecutionStream(
  thread: Thread,
  stream: AsyncIterable<DiscordbotRendererSource>,
  message: DiscordbotApiMessage,
  options: DiscordbotOptions,
  isInitialExecution: boolean,
  trace?: DiscordbotTrace,
): Promise<void> {
  const logger = options.logger ?? noopLogger;
  if (isInitialExecution && options.nameThreads !== false) {
    await renameThreadFromMessage(
      options,
      thread.id,
      deriveThreadName(message.text, options.userName),
      logger,
    );
    traceLog(options, "discordbot_thread_named", trace);
  }

  const stopTyping = startTypingKeepalive(thread, logger);
  try {
    // Deliberate delta from slackbotv2: no streamAfterFirstChunk deferral.
    // The instant "✨ thinking..." placeholder covers the no-visible-output
    // window, so the stream posts immediately instead of waiting for the
    // first visible chunk.
    const visibleStream = discordSafeChatSdkStream(
      codexAppServerToChatSdkStream(stream, rendererOptions(options)),
    );
    await thread.post(new StreamingPlan(visibleStream, {}));
  } finally {
    stopTyping();
  }
}

async function renderRecoveredExecutionStream(
  thread: Thread,
  stream: AsyncIterable<DiscordbotRendererSource>,
  message: DiscordbotApiMessage,
  options: DiscordbotOptions,
  trace?: DiscordbotTrace,
): Promise<void> {
  // Recovered renders never rename the thread; naming happens on the initial execution.
  // The discordSafe stream wrapping comes via renderExecutionStream.
  await renderExecutionStream(thread, stream, message, options, false, trace);
}

async function* discordSafeChatSdkStream(
  stream: AsyncIterable<ChatSDKStreamChunk>,
): AsyncIterable<ChatSDKStreamChunk> {
  for await (const chunk of stream) {
    yield discordSafeChatSdkChunk(chunk);
  }
}

function discordSafeChatSdkChunk(
  chunk: ChatSDKStreamChunk,
): ChatSDKStreamChunk {
  if (chunk.type !== "task_update") return chunk;
  const { output: _output, details, ...safeChunk } = chunk;
  void _output;
  return {
    ...safeChunk,
    ...(details ? { details: truncateDiscordTaskField(details) } : {}),
  };
}

function truncateDiscordTaskField(value: string): string {
  return truncateDiscordText(
    value,
    DISCORD_TASK_DETAILS_MAX_CHARS,
    "Discord task details",
  );
}

function truncateDiscordText(
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
  options: DiscordbotOptions,
  input: ForwardSessionInput,
  onExecutionStarted?: (
    execution: DiscordbotExecuteSessionResponse,
  ) => Promise<void>,
): AsyncIterable<DiscordbotRendererSource> {
  // Post the placeholder BEFORE executing so the user sees "✨ thinking..."
  // immediately, instead of waiting ~9s for the cold sandbox (incl. tool-server
  // sidecar) to spin up. Execute runs here, inside the render stream, so a
  // sandbox-spawn failure surfaces in the same message rather than hanging the
  // placeholder (api-rs writes no event if the spawn itself fails).
  yield startingStreamNotification(input.threadId);
  traceLog(options, "discordbot_stream_heartbeat_emitted", input.trace);

  if (input.executeMessage) {
    try {
      const execution = await executeSessionTurn(options, input);
      if (execution) {
        // Scope the event stream we open below to this execution (upstream
        // #422 sets this where execute returns; for us that's in-stream).
        input.executionId = execution.execution_id;
        await onExecutionStarted?.(execution);
      }
    } catch (error) {
      traceLog(options, "discordbot_forward_failed", input.trace, {
        error: errorMessage(error),
      });
      if (isRetryableSessionApiError(error)) throw error;
      yield sessionStreamError(error);
      return;
    }
  }

  let stream: AsyncIterable<DiscordbotRendererSource>;
  try {
    stream = await openSessionEventStream(options, input);
  } catch (error) {
    traceLog(options, "discordbot_forward_failed", input.trace, {
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
): AsyncIterable<DiscordbotRendererSource> {
  yield sessionStreamError(error);
}

function backgroundWaitUntil(promise: Promise<unknown>): void {
  // Discord ingress runs in a long-lived Gateway process (no per-request waitUntil);
  // background work just needs its rejections swallowed after they are traced.
  void promise.catch(() => undefined);
}

function rendererOptions(
  options: DiscordbotOptions,
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

/**
 * Discord's typing indicator expires after ~10s, so a single call blinks off mid-run. Re-fire on
 * an interval while the stream is open; errors are swallowed (typing is cosmetic) and the interval
 * is always cleared by the returned stop function.
 */
function startTypingKeepalive(thread: Thread, logger: Logger): () => void {
  const adapter = thread.adapter as TypingCapableAdapter;
  if (!adapter.startTyping) return () => undefined;

  const fire = (): void => {
    void adapter.startTyping?.(thread.id).catch((error) => {
      logger.debug("discordbot_typing_error", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };
  fire();
  const interval = globalThis.setInterval(fire, TYPING_KEEPALIVE_MS);
  return () => globalThis.clearInterval(interval);
}
