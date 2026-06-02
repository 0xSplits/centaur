import type {
  AppendMessagesRequest,
  CreateSessionRequest,
  ExecuteSessionRequest,
  ForwardSessionInput,
  JsonObject,
  JsonValue,
  SessionApiAttachment,
  SessionApiAuthor,
  SessionApiMessage,
  SessionApiOptions,
  SessionFetch,
  SessionMessage,
  SessionMessageMode,
  SessionMessageRole,
  SessionPlatform,
  SessionRendererSource,
  SessionThreadState,
  SessionTrace,
} from "@centaur/chat-session-bridge";
import type { CodexAppServerToChatStreamOptions } from "@centaur/rendering";
import type { Chat, Logger, StateAdapter } from "chat";
import type { Hono } from "hono";

export type { ForwardSessionInput, JsonObject, JsonValue };

export type DiscordbotApiAuthor = SessionApiAuthor;
export type DiscordbotApiAttachment = SessionApiAttachment;
export type DiscordbotApiMessage = SessionApiMessage;
export type DiscordbotSessionMessageRole = SessionMessageRole;
export type DiscordbotSessionMessage = SessionMessage;
export type DiscordbotAppendMessagesRequest = AppendMessagesRequest;
export type DiscordbotCreateSessionRequest = CreateSessionRequest;
export type DiscordbotExecuteSessionRequest = ExecuteSessionRequest;
export type DiscordbotFetch = SessionFetch;
export type DiscordbotThreadState = SessionThreadState;
export type DiscordbotMessageMode = SessionMessageMode;
export type DiscordbotRendererSource = SessionRendererSource;
export type DiscordbotTrace = SessionTrace;

export type DiscordbotOptions = Omit<SessionApiOptions, "platform"> & {
  applicationId: string;
  botToken: string;
  discordApiUrl?: string;
  guildAllowlist?: readonly string[];
  /** Rename auto-created threads to the message-derived title. Defaults to true. */
  nameThreads?: boolean;
  /** Liveness probe for `/health`; reflects the Gateway connection. */
  isGatewayActive?: () => boolean;
  mapper?: CodexAppServerToChatStreamOptions;
  mentionRoleIds?: string[];
  platform?: SessionPlatform;
  postgresUrl?: string;
  publicKey: string;
  state?: StateAdapter;
  stateKeyPrefix?: string;
  userName?: string;
};

/** Options after `createDiscordbot` has resolved the platform config. */
export type DiscordbotResolvedOptions = DiscordbotOptions & {
  platform: SessionPlatform;
};

export type Discordbot = {
  app: Hono;
  chat: Chat;
  adapter: GatewayCapableAdapter;
};

/** Minimal slice of the Discord adapter the Gateway runner needs. */
export type GatewayCapableAdapter = {
  startGatewayListener(
    options: { waitUntil(promise: Promise<unknown>): void },
    durationMs?: number,
    abortSignal?: AbortSignal,
    webhookUrl?: string,
  ): Promise<unknown>;
};

/** Minimal slice of the Discord adapter used to send a typing indicator. */
export type TypingCapableAdapter = {
  startTyping?(threadId: string, status?: string): Promise<void>;
};

export type { Logger };
