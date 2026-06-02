import {
  collectInitialContext,
  elapsedMs,
  errorMessage,
  forwardToSessionApi,
  noopLogger,
  nowMs,
  serializeMessage,
  sessionStreamError,
  startingStreamNotification,
  traceLog,
  type SessionPlatform,
} from "@centaur/chat-session-bridge";
import {
  codexAppServerToChatSdkStream,
  type CodexAppServerToChatStreamOptions,
  type RendererEvent,
} from "@centaur/rendering";
import { createDiscordAdapter } from "@chat-adapter/discord";
import { createPostgresState } from "@chat-adapter/state-pg";
import {
  Chat,
  StreamingPlan,
  type Logger,
  type Message,
  type StateAdapter,
  type Thread,
} from "chat";
import { Hono } from "hono";
import {
  isAllowedDiscordMessage,
  isGuildAllowlistEmpty,
} from "./discord-allowlist";
import { deriveThreadName, renameThreadFromMessage } from "./discord-threading";
import type {
  Discordbot,
  DiscordbotApiMessage,
  DiscordbotMessageMode,
  DiscordbotOptions,
  DiscordbotRendererSource,
  DiscordbotResolvedOptions,
  DiscordbotThreadState,
  DiscordbotTrace,
  ForwardSessionInput,
  TypingCapableAdapter,
} from "./types";

const DISCORD_PLATFORM: SessionPlatform = {
  source: "discordbot",
  platform: "discord",
  attachmentLabel: "Discord attachment",
  tracePrefix: "discordbot",
  apiKeyEnvVars: ["DISCORDBOT_API_KEY", "CENTAUR_API_KEY"],
};

const TYPING_KEEPALIVE_MS = 8000;

export type {
  Discordbot,
  DiscordbotApiAttachment,
  DiscordbotApiAuthor,
  DiscordbotApiMessage,
  DiscordbotAppendMessagesRequest,
  DiscordbotCreateSessionRequest,
  DiscordbotExecuteSessionRequest,
  DiscordbotFetch,
  DiscordbotOptions,
  DiscordbotSessionMessage,
  DiscordbotSessionMessageRole,
} from "./types";

export function createDiscordbot(rawOptions: DiscordbotOptions): Discordbot {
  const options: DiscordbotResolvedOptions = {
    ...rawOptions,
    platform: rawOptions.platform ?? DISCORD_PLATFORM,
  };
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
  const chat = new Chat({
    userName,
    adapters: { discord },
    state: options.state ?? createDefaultState(options, logger),
    // Serialize handlers per thread via the SDK's per-thread lock. The deprecated
    // `onLockConflict: 'force'` force-released the lock so two handlers ran concurrently on one
    // thread — two near-simultaneous mentions could both pass the `activeExecution` check and
    // double-execute. `'drop'` (the default conflict behavior) keeps the lock: a second message that
    // lands while a handler holds the thread lock is dropped rather than run in parallel. Same code
    // path as before for the no-contention case, so single-message streaming is unchanged.
    concurrency: "drop",
    logger,
  });

  chat.onNewMention(async (thread, message) => {
    if (!isAllowedDiscordMessage(message, options, logger)) return;
    await thread.subscribe();
    await syncThreadMessageToSession(thread, message, {
      mode: "execute",
      options,
    });
  });

  chat.onSubscribedMessage(async (thread, message) => {
    if (!isAllowedDiscordMessage(message, options, logger)) return;
    await syncThreadMessageToSession(thread, message, {
      mode: message.isMention === true ? "execute" : "append",
      options,
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

  return { app, chat, adapter: discord };
}

function createDefaultState(
  options: DiscordbotOptions,
  logger: Logger,
): StateAdapter {
  return createPostgresState({
    url: options.postgresUrl,
    keyPrefix: options.stateKeyPrefix ?? "centaur-discordbot",
    logger: logger.child("postgres-state"),
  });
}

/**
 * Persists a Discord thread update into the session API. In execute mode it also starts and
 * renders a session stream unless another execution is already active for the same thread.
 */
async function syncThreadMessageToSession(
  thread: Thread<DiscordbotThreadState>,
  message: Message,
  input: {
    mode: DiscordbotMessageMode;
    options: DiscordbotResolvedOptions;
  },
): Promise<void> {
  const traceStartedAtMs = nowMs();
  const state = (await thread.state) ?? {};
  const messageIds = new Set(state.forwardedMessageIds ?? []);
  const shouldStartExecution =
    input.mode === "execute" && state.activeExecution !== true;
  const shouldIncludeContext = shouldStartExecution;
  const isDuplicateIncrementalMessage =
    messageIds.has(message.id) &&
    (!shouldIncludeContext || state.historyForwarded);
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
    for (const item of context) {
      messageIds.add(item.id);
    }
    traceLog(input.options, "discordbot_forward_context_collected", trace, {
      message_count: context.length,
      phase_ms: elapsedMs(contextStartedAtMs),
    });
  } else {
    messageIds.add(serializedMessage.id);
    traceLog(input.options, "discordbot_forward_context_skipped", trace, {
      message_count: 1,
    });
  }

  let lastEventId = state.lastEventId ?? 0;
  const isInitialExecution =
    shouldStartExecution && state.historyForwarded !== true;

  const forwardInput: ForwardSessionInput = {
    afterEventId: lastEventId,
    executeMessage: shouldStartExecution ? serializedMessage : undefined,
    messages: context ?? [serializedMessage],
    onEventId: (eventId) => {
      lastEventId = Math.max(lastEventId, eventId);
    },
    openStream: shouldStartExecution,
    threadId: thread.id,
    trace,
  };

  const commitForwardedState = async (): Promise<void> => {
    await thread.setState({
      activeExecution: state.activeExecution || shouldStartExecution,
      forwardedMessageIds: Array.from(messageIds).slice(-1000),
      historyForwarded: state.historyForwarded || shouldIncludeContext,
      lastEventId,
    });
    traceLog(input.options, "discordbot_forward_state_committed", trace, {
      forwarded_message_count: Math.min(messageIds.size, 1000),
    });
  };

  if (!shouldStartExecution) {
    await forwardToSessionApi(input.options, forwardInput);
    await commitForwardedState();
    traceLog(input.options, "discordbot_forward_complete", trace);
    return;
  }

  try {
    await thread.setState({ ...state, activeExecution: true });
    traceLog(
      input.options,
      "discordbot_forward_active_execution_marked",
      trace,
    );
    await renderExecutionStream(
      thread,
      executeAndStreamSession(
        input.options,
        forwardInput,
        commitForwardedState,
      ),
      serializedMessage,
      input.options,
      isInitialExecution,
      trace,
    );
    traceLog(input.options, "discordbot_render_complete", trace);
  } finally {
    const latest = (await thread.state) ?? {};
    await thread.setState({
      ...latest,
      activeExecution: false,
      lastEventId: Math.max(latest.lastEventId ?? 0, lastEventId),
    });
    traceLog(input.options, "discordbot_forward_complete", trace, {
      last_event_id: lastEventId,
    });
  }
}

async function renderExecutionStream(
  thread: Thread,
  stream: AsyncIterable<DiscordbotRendererSource>,
  message: DiscordbotApiMessage,
  options: DiscordbotResolvedOptions,
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
  }

  const stopTyping = startTypingKeepalive(thread, logger);
  try {
    await thread.post(
      new StreamingPlan(
        codexAppServerToChatSdkStream(stream, rendererOptions(options)),
        {},
      ),
    );
  } finally {
    stopTyping();
  }
}

async function* executeAndStreamSession(
  options: DiscordbotResolvedOptions,
  input: ForwardSessionInput,
  onSessionReady: () => Promise<void>,
): AsyncIterable<DiscordbotRendererSource> {
  yield startingStreamNotification(input.threadId, options.platform.source);
  traceLog(options, "discordbot_stream_heartbeat_emitted", input.trace);

  try {
    const stream = await forwardToSessionApi(options, input);
    await onSessionReady();
    if (!stream) return;
    for await (const event of stream) yield event;
  } catch (error) {
    traceLog(options, "discordbot_forward_failed", input.trace, {
      error: errorMessage(error),
    });
    yield sessionStreamError(error);
  }
}

function rendererOptions(
  options: DiscordbotResolvedOptions,
): CodexAppServerToChatStreamOptions {
  const mapper = options.mapper;
  return {
    ...mapper,
    async onRendererEvent(event: RendererEvent) {
      await mapper?.onRendererEvent?.(event);
    },
  };
}

/**
 * Discord's typing indicator expires after ~10s, so a single call blinks off mid-run. Re-fire
 * on an interval while the stream is open; errors are swallowed (typing is cosmetic) and the
 * interval is always cleared by the returned stop function.
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
