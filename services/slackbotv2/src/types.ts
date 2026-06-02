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

// Back-compat aliases — the shared shapes now live in @centaur/chat-session-bridge,
// but consumers (and the emulation test) still import the SlackbotV2* names.
export type SlackbotV2ApiAuthor = SessionApiAuthor;
export type SlackbotV2ApiAttachment = SessionApiAttachment;
export type SlackbotV2ApiMessage = SessionApiMessage;
export type SlackbotV2SessionMessageRole = SessionMessageRole;
export type SlackbotV2SessionMessage = SessionMessage;
export type SlackbotV2AppendMessagesRequest = AppendMessagesRequest;
export type SlackbotV2CreateSessionRequest = CreateSessionRequest;
export type SlackbotV2ExecuteSessionRequest = ExecuteSessionRequest;
export type SlackbotV2Fetch = SessionFetch;
export type SlackbotV2ThreadState = SessionThreadState;
export type SlackbotV2MessageMode = SessionMessageMode;
export type SlackbotV2RendererSource = SessionRendererSource;
export type SlackbotV2Trace = SessionTrace;

export type SlackbotV2Options = Omit<SessionApiOptions, "platform"> & {
  allowedExternalTeamIds?: readonly string[];
  assistantStatus?: string;
  botToken: string;
  botUserId?: string;
  mapper?: CodexAppServerToChatStreamOptions;
  platform?: SessionPlatform;
  postgresUrl?: string;
  signingSecret: string;
  slackApiUrl?: string;
  state?: StateAdapter;
  stateKeyPrefix?: string;
  streamTaskDisplayMode?: "plan" | "timeline";
  triggerBotAllowlist?: readonly string[];
  userName?: string;
};

/** Options after `createSlackbotV2` has resolved the platform config. */
export type SlackbotV2ResolvedOptions = SlackbotV2Options & {
  platform: SessionPlatform;
};

export type SlackbotV2 = {
  app: Hono;
  chat: Chat;
};

export type { Logger };
