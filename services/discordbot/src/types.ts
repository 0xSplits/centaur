import type { RustSessionStreamEvent } from "@centaur/harness-events";
import type { CodexAppServerToChatStreamOptions } from "@centaur/rendering";
import type { Attachment, Chat, Logger, StateAdapter } from "chat";
import type { Hono } from "hono";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue | undefined };

export type DiscordbotApiAuthor = {
  fullName: string;
  isBot: boolean | "unknown";
  isMe: boolean;
  userId: string;
  userName: string;
};

export type DiscordbotApiAttachment = {
  dataBase64?: string;
  fetchError?: string;
  fetchMetadata?: Record<string, string>;
  height?: number;
  mimeType?: string;
  name?: string;
  size?: number;
  type: Attachment["type"];
  url?: string;
  width?: number;
};

export type DiscordbotApiMessage = {
  attachments: DiscordbotApiAttachment[];
  author: DiscordbotApiAuthor;
  id: string;
  isMention: boolean;
  raw: unknown;
  text: string;
  threadId: string;
  timestamp: string;
};

export type DiscordbotSessionMessageRole =
  | "user"
  | "assistant"
  | "system"
  | "tool";

export type DiscordbotSessionMessage = {
  client_message_id?: string;
  metadata: JsonObject;
  parts: JsonValue[];
  role: DiscordbotSessionMessageRole;
};

export type DiscordbotAppendMessagesRequest = {
  messages: DiscordbotSessionMessage[];
};

export type DiscordbotCreateSessionRequest = {
  harness_type: string;
  metadata: JsonObject;
};

export type DiscordbotExecuteSessionRequest = {
  idempotency_key?: string;
  idle_timeout_ms?: number;
  input_lines: string[];
  max_duration_ms?: number;
  metadata: JsonObject;
};

export type DiscordbotExecuteSessionResponse = {
  execution_id: string;
  ok: boolean;
  status: string;
  thread_key: string;
};

export type DiscordbotFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type DiscordbotOptions = {
  apiKey?: string;
  apiUrl: string;
  applicationId: string;
  botToken: string;
  discordApiUrl?: string;
  fetch?: DiscordbotFetch;
  guildAllowlist?: readonly string[];
  idleTimeoutMs?: number;
  /** Liveness probe for `/health`; reflects the Gateway connection state. */
  isGatewayActive?: () => boolean;
  logger?: Logger;
  mapper?: CodexAppServerToChatStreamOptions;
  maxDurationMs?: number;
  mentionRoleIds?: string[];
  /** Rename auto-created threads to the message-derived title. Defaults to true. */
  nameThreads?: boolean;
  postgresUrl?: string;
  publicKey: string;
  recoverRenderObligationsOnStart?: boolean;
  state?: StateAdapter;
  stateKeyPrefix?: string;
  /** Initial text of the progress message posted while the agent works. Defaults to "✨ thinking...". */
  streamingPlaceholderText?: string;
  userName?: string;
};

export type Discordbot = {
  app: Hono;
  chat: Chat;
  adapter: GatewayCapableAdapter;
};

export type DiscordbotThreadState = {
  activeExecution?: boolean;
  executedMessageIds?: string[];
  forwardedMessageIds?: string[];
  historyForwarded?: boolean;
  lastEventId?: number;
  renderObligation?: DiscordbotRenderObligation | null;
};

export type DiscordbotRenderObligation = {
  afterEventId: number;
  executionId: string;
  message: DiscordbotApiMessage;
};

export type DiscordbotMessageMode = "append" | "execute";

export type DiscordbotRendererSource = RustSessionStreamEvent | JsonObject;

export type DiscordbotTrace = {
  includeContext: boolean;
  messageId: string;
  mode: DiscordbotMessageMode;
  openStream: boolean;
  startedAtMs: number;
  threadId: string;
};

export type ForwardSessionInput = {
  afterEventId: number;
  executionId?: string;
  executeMessage?: DiscordbotApiMessage;
  messages: DiscordbotApiMessage[];
  onEventId(eventId: number): void;
  openStream: boolean;
  threadId: string;
  trace?: DiscordbotTrace;
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
