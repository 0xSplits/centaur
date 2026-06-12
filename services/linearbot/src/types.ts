import type { RustSessionStreamEvent } from "@centaur/harness-events";
import type { CodexAppServerToChatStreamOptions } from "@centaur/rendering";
import type { Attachment, Chat, Logger, StateAdapter } from "chat";
import type { Hono } from "hono";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue | undefined };

export type LinearbotApiAuthor = {
  fullName: string;
  isBot: boolean | "unknown";
  isMe: boolean;
  userId: string;
  userName: string;
};

export type LinearbotApiAttachment = {
  dataBase64?: string;
  dataBase64Omitted?: string;
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

// Linear delta: no Slack `teamId` (Linear scopes by organization, which the
// adapter resolves from the install; sessions are keyed by thread id alone).
export type LinearbotApiMessage = {
  attachments: LinearbotApiAttachment[];
  author: LinearbotApiAuthor;
  id: string;
  isMention: boolean;
  raw: unknown;
  text: string;
  threadId: string;
  timestamp: string;
};

export type LinearbotSessionMessageRole =
  | "user"
  | "assistant"
  | "system"
  | "tool";

export type LinearbotSessionMessage = {
  client_message_id?: string;
  metadata: JsonObject;
  parts: JsonValue[];
  role: LinearbotSessionMessageRole;
};

export type LinearbotAppendMessagesRequest = {
  messages: LinearbotSessionMessage[];
};

export type LinearbotCreateSessionRequest = {
  harness_type: string;
  metadata: JsonObject;
};

export type LinearbotExecuteSessionRequest = {
  idempotency_key?: string;
  idle_timeout_ms?: number;
  input_lines: string[];
  max_duration_ms?: number;
  metadata: JsonObject;
};

export type LinearbotExecuteSessionResponse = {
  execution_id: string;
  ok: boolean;
  status: string;
  thread_key: string;
};

export type LinearbotFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type LinearbotOptions = {
  /**
   * Linear delta (adopted from discordbot): TTL after which a persisted
   * `activeExecution` flag is treated as stale. Linear redelivers a failed
   * webhook only a handful of times, so a crash between marking and clearing
   * the flag could otherwise wedge the thread until manual intervention.
   */
  activeExecutionTtlMs?: number;
  apiKey?: string;
  apiUrl: string;
  fetch?: LinearbotFetch;
  idleTimeoutMs?: number;
  /** OAuth access token from an actor=app install (agent-sessions mode). */
  linearAccessToken?: string;
  /** Personal API key fallback (comments mode only; no agent sessions). */
  linearApiKey?: string;
  /** Override the Linear GraphQL API base URL (tests/emulation). */
  linearApiUrl?: string;
  /** Webhook handling mode. Defaults to 'agent-sessions'. */
  linearMode?: "agent-sessions" | "comments";
  /** Webhook signing secret from the Linear webhook settings page. */
  linearWebhookSecret: string;
  logger?: Logger;
  mapper?: CodexAppServerToChatStreamOptions;
  maxDurationMs?: number;
  /** Linear delta: budget on thought/action activities posted per run. */
  narratorMaxActivities?: number;
  /** Linear delta: min gap between posted thought activities. */
  narratorMinPostGapMs?: number;
  postgresUrl?: string;
  recoverRenderObligationsOnStart?: boolean;
  /** Per-thread deadline for one recovery attempt during the startup scan. */
  renderRecoveryThreadTimeoutMs?: number;
  state?: StateAdapter;
  stateKeyPrefix?: string;
  userName?: string;
};

export type Linearbot = {
  app: Hono;
  chat: Chat;
};

export type LinearbotThreadState = {
  activeExecution?: boolean;
  /**
   * Linear delta (adopted from discordbot): epoch ms when `activeExecution`
   * was last (re)confirmed; the flag is ignored once this is older than the
   * active-execution TTL. Cleared (null) together with the flag.
   */
  activeExecutionStartedAt?: number | null;
  executedMessageIds?: string[];
  forwardedMessageIds?: string[];
  historyForwarded?: boolean;
  lastEventId?: number;
  renderObligation?: LinearbotRenderObligation | null;
};

export type LinearbotRenderObligation = {
  afterEventId: number;
  executionId: string;
  message: LinearbotApiMessage;
};

export type LinearbotMessageMode = "append" | "execute";

export type LinearbotRendererSource = RustSessionStreamEvent | JsonObject;

export type LinearbotTrace = {
  includeContext: boolean;
  messageId: string;
  mode: LinearbotMessageMode;
  openStream: boolean;
  startedAtMs: number;
  threadId: string;
};

export type ForwardSessionInput = {
  afterEventId: number;
  executionId?: string;
  executeMessage?: LinearbotApiMessage;
  /** Harness override parsed from message flags (--claude/--amp/--codex). */
  harnessType?: string;
  messages: LinearbotApiMessage[];
  /** Per-turn model override parsed from message flags (--model/--opus/...). */
  model?: string;
  onEventId(eventId: number): void;
  openStream: boolean;
  threadId: string;
  trace?: LinearbotTrace;
};

/**
 * Minimal slice of the Linear chat adapter the narrator uses to emit typed
 * agent activities (thought/action/response/error) directly — the unified
 * Chat SDK surface only exposes Response posts and ephemeral thoughts.
 */
export type LinearAgentActivityContent =
  | { type: "thought"; body: string }
  | { type: "action"; action: string; parameter: string; result?: string }
  | { type: "response"; body: string }
  | { type: "error"; body: string };

export type LinearActivityClient = {
  createAgentActivity(input: {
    agentSessionId: string;
    content: LinearAgentActivityContent;
    ephemeral?: boolean;
  }): Promise<unknown>;
};

export type LinearSessionCapableAdapter = {
  linearClient?: LinearActivityClient;
  startTyping?(threadId: string, status?: string): Promise<void>;
};
