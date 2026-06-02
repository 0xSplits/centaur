import type { RustSessionStreamEvent } from "@centaur/harness-events";
import type { Attachment, Logger } from "chat";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue | undefined };

export type SessionApiAuthor = {
  fullName: string;
  isBot: boolean | "unknown";
  isMe: boolean;
  userId: string;
  userName: string;
};

export type SessionApiAttachment = {
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

export type SessionApiMessage = {
  attachments: SessionApiAttachment[];
  author: SessionApiAuthor;
  id: string;
  isMention: boolean;
  raw: unknown;
  text: string;
  threadId: string;
  timestamp: string;
};

export type SessionMessageRole = "user" | "assistant" | "system" | "tool";

export type SessionMessage = {
  metadata: JsonObject;
  parts: JsonValue[];
  role: SessionMessageRole;
};

export type AppendMessagesRequest = {
  messages: SessionMessage[];
};

export type CreateSessionRequest = {
  harness_type: string;
  metadata: JsonObject;
};

export type ExecuteSessionRequest = {
  idle_timeout_ms?: number;
  input_lines: string[];
  max_duration_ms?: number;
  metadata: JsonObject;
};

export type SessionFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

/**
 * Per-platform constants the otherwise-agnostic session bridge needs. Each chat ingress
 * (slackbotv2, discordbot, ...) provides exactly one of these so the shared logic can label
 * sessions, pick the api-key env vars, and prefix trace events without forking the code.
 */
export type SessionPlatform = {
  /** `source` metadata on every session, e.g. 'slackbotv2' | 'discordbot'. */
  source: string;
  /** `platform` metadata on every session, e.g. 'slack' | 'discord'. */
  platform: string;
  /** Human label used when describing a non-image attachment, e.g. 'Slack attachment'. */
  attachmentLabel: string;
  /** Prefix for emitted trace event names, e.g. 'slackbotv2' -> 'slackbotv2_session_*'. */
  tracePrefix: string;
  /** Env vars checked (in order) for the bearer key to api-rs. */
  apiKeyEnvVars?: readonly string[];
  /** Harness to run; defaults to 'codex'. */
  harnessType?: string;
};

export type SessionApiOptions = {
  apiUrl: string;
  apiKey?: string;
  fetch?: SessionFetch;
  idleTimeoutMs?: number;
  logger?: Logger;
  maxDurationMs?: number;
  platform: SessionPlatform;
};

export type SessionThreadState = {
  activeExecution?: boolean;
  forwardedMessageIds?: string[];
  historyForwarded?: boolean;
  lastEventId?: number;
};

export type SessionMessageMode = "append" | "execute";

export type SessionRendererSource = RustSessionStreamEvent | JsonObject;

export type SessionTrace = {
  includeContext: boolean;
  messageId: string;
  mode: SessionMessageMode;
  openStream: boolean;
  startedAtMs: number;
  threadId: string;
};

export type ForwardSessionInput = {
  afterEventId: number;
  executeMessage?: SessionApiMessage;
  messages: SessionApiMessage[];
  onEventId(eventId: number): void;
  openStream: boolean;
  threadId: string;
  trace?: SessionTrace;
};

/** Minimal shape `traceLog` needs — any options object carrying an optional logger. */
export type TraceableOptions = {
  logger?: Logger;
};
