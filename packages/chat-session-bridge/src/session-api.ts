import type { RustSessionStreamEvent } from "@centaur/harness-events";
import type { Attachment, Message } from "chat";
import type {
  AppendMessagesRequest,
  CreateSessionRequest,
  ExecuteSessionRequest,
  ForwardSessionInput,
  JsonObject,
  JsonValue,
  SessionApiAttachment,
  SessionApiMessage,
  SessionApiOptions,
  SessionMessage,
  SessionPlatform,
  SessionRendererSource,
} from "./types";
import {
  elapsedMs,
  isJsonObject,
  nowMs,
  stringValue,
  toAsyncIterable,
  traceLog,
} from "./utils";

export async function collectInitialContext(
  thread: { allMessages: AsyncIterable<Message> },
  currentMessage: Message,
): Promise<SessionApiMessage[]> {
  const messages: Message[] = [];
  for await (const message of thread.allMessages) {
    messages.push(message);
  }

  const currentIndex = messages.findIndex(
    (message) => message.id === currentMessage.id,
  );
  if (currentIndex >= 0) {
    messages[currentIndex] = currentMessage;
  } else {
    messages.push(currentMessage);
  }

  const serialized: SessionApiMessage[] = [];
  for (const message of messages) {
    serialized.push(await serializeMessage(message));
  }
  return serialized;
}

export async function serializeMessage(
  message: Message,
): Promise<SessionApiMessage> {
  const attachments: SessionApiAttachment[] = [];
  for (const attachment of message.attachments) {
    attachments.push(await serializeAttachment(attachment));
  }

  return {
    attachments,
    author: {
      fullName: message.author.fullName,
      isBot: message.author.isBot,
      isMe: message.author.isMe,
      userId: message.author.userId,
      userName: message.author.userName,
    },
    id: message.id,
    isMention: message.isMention === true,
    raw: message.raw,
    text: message.text,
    threadId: message.threadId,
    timestamp: message.metadata.dateSent.toISOString(),
  };
}

export async function forwardToSessionApi(
  options: SessionApiOptions,
  input: ForwardSessionInput,
): Promise<AsyncIterable<SessionRendererSource> | null> {
  const prefix = options.platform.tracePrefix;
  const createStartedAtMs = nowMs();
  await createSession(options, input.threadId);
  traceLog(options, `${prefix}_session_create_complete`, input.trace, {
    phase_ms: elapsedMs(createStartedAtMs),
  });
  const appendStartedAtMs = nowMs();
  await appendSessionMessages(options, input.threadId, input.messages);
  traceLog(options, `${prefix}_session_append_complete`, input.trace, {
    message_count: input.messages.length,
    phase_ms: elapsedMs(appendStartedAtMs),
  });
  if (!input.executeMessage) return null;

  const executeStartedAtMs = nowMs();
  await executeSession(options, input.threadId, input.executeMessage);
  traceLog(options, `${prefix}_session_execute_complete`, input.trace, {
    phase_ms: elapsedMs(executeStartedAtMs),
  });
  if (!input.openStream) return null;

  const streamStartedAtMs = nowMs();
  const stream = await streamSessionNotifications(
    options,
    input.threadId,
    input.afterEventId,
    input.onEventId,
  );
  traceLog(options, `${prefix}_session_events_opened`, input.trace, {
    after_event_id: input.afterEventId,
    phase_ms: elapsedMs(streamStartedAtMs),
  });
  return stream;
}

export function startingStreamNotification(
  threadId: string,
  source = "chat-session",
): JsonObject {
  return {
    method: "item/started",
    params: {
      threadId,
      turnId: `${source}-starting-turn`,
      startedAtMs: Date.now(),
      item: {
        id: `${source}-starting`,
        memoryCitation: null,
        phase: "commentary",
        text: "",
        type: "agentMessage",
      },
    },
  };
}

export function sessionStreamError(error: unknown): RustSessionStreamEvent {
  return {
    data: { error: error instanceof Error ? error.message : String(error) },
    event: "session.stream_error",
    eventKind: "session.stream_error",
  };
}

async function serializeAttachment(
  attachment: Attachment,
): Promise<SessionApiAttachment> {
  const serialized: SessionApiAttachment = {
    fetchMetadata: attachment.fetchMetadata,
    height: attachment.height,
    mimeType: attachment.mimeType,
    name: attachment.name,
    size: attachment.size,
    type: attachment.type,
    url: attachment.url,
    width: attachment.width,
  };

  try {
    const data = attachment.data ?? (await attachment.fetchData?.());
    if (data) {
      serialized.dataBase64 = await bytesToBase64(data);
    }
  } catch (error) {
    serialized.fetchError =
      error instanceof Error ? error.message : String(error);
  }

  return serialized;
}

async function bytesToBase64(data: Buffer | Blob): Promise<string> {
  if (Buffer.isBuffer(data)) return data.toString("base64");
  const bytes = await data.arrayBuffer();
  return Buffer.from(bytes).toString("base64");
}

async function createSession(
  options: SessionApiOptions,
  threadId: string,
): Promise<void> {
  const fetchFn = options.fetch ?? fetch;
  const body: CreateSessionRequest = {
    harness_type: options.platform.harnessType ?? "codex",
    metadata: {
      source: options.platform.source,
      platform: options.platform.platform,
      thread_id: threadId,
    },
  };
  const response = await fetchFn(apiSessionUrl(options.apiUrl, threadId), {
    method: "POST",
    headers: apiHeaders(options),
    body: JSON.stringify(body),
  });
  await ensureApiOk(response, "create session");
}

async function appendSessionMessages(
  options: SessionApiOptions,
  threadId: string,
  messages: SessionApiMessage[],
): Promise<void> {
  const fetchFn = options.fetch ?? fetch;
  const body: AppendMessagesRequest = {
    messages: messages.map((message) =>
      toSessionMessage(message, options.platform),
    ),
  };
  const response = await fetchFn(
    apiSessionUrl(options.apiUrl, threadId, "messages"),
    {
      method: "POST",
      headers: apiHeaders(options),
      body: JSON.stringify(body),
    },
  );
  await ensureApiOk(response, "append session messages");
}

async function executeSession(
  options: SessionApiOptions,
  threadId: string,
  message: SessionApiMessage,
): Promise<void> {
  const fetchFn = options.fetch ?? fetch;
  const body: ExecuteSessionRequest = {
    metadata: sessionMetadata(message, options.platform, { action: "execute" }),
    input_lines: [toCodexInputLine(message, threadId, options.platform)],
    ...(options.idleTimeoutMs === undefined
      ? {}
      : { idle_timeout_ms: options.idleTimeoutMs }),
    ...(options.maxDurationMs === undefined
      ? {}
      : { max_duration_ms: options.maxDurationMs }),
  };
  const response = await fetchFn(
    apiSessionUrl(options.apiUrl, threadId, "execute"),
    {
      method: "POST",
      headers: apiHeaders(options),
      body: JSON.stringify(body),
    },
  );
  await ensureApiOk(response, "execute session");
}

async function ensureApiOk(response: Response, action: string): Promise<void> {
  if (response.ok) return;
  let body = "";
  try {
    body = await response.text();
  } catch {
    body = "";
  }
  const suffix = body ? `: ${body}` : "";
  throw new Error(
    `Centaur session ${action} failed: ${response.status} ${response.statusText}${suffix}`,
  );
}

async function streamSessionNotifications(
  options: SessionApiOptions,
  threadId: string,
  afterEventId: number,
  onEventId: (eventId: number) => void,
): Promise<AsyncIterable<SessionRendererSource>> {
  const fetchFn = options.fetch ?? fetch;
  const response = await fetchFn(
    `${apiSessionUrl(options.apiUrl, threadId, "events")}?after_event_id=${afterEventId}`,
    {
      method: "GET",
      headers: apiHeaders(options, false),
    },
  );
  await ensureApiOk(response, "stream events");
  if (!response.body) return toAsyncIterable([]);
  return parseSessionEventStream(response.body, onEventId);
}

function apiSessionUrl(
  apiUrl: string,
  threadId: string,
  suffix?: "messages" | "execute" | "events",
): string {
  const path = `/api/session/${encodeURIComponent(threadId)}${suffix ? `/${suffix}` : ""}`;
  return new URL(path, ensureTrailingSlash(apiUrl)).toString();
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function apiHeaders(options: SessionApiOptions, jsonBody = true): HeadersInit {
  const apiKey =
    options.apiKey ?? resolveApiKeyFromEnv(options.platform.apiKeyEnvVars);
  return {
    ...(jsonBody ? { "content-type": "application/json" } : {}),
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
  };
}

function resolveApiKeyFromEnv(
  envVars: readonly string[] | undefined,
): string | undefined {
  for (const name of envVars ?? []) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

function toSessionMessage(
  message: SessionApiMessage,
  platform: SessionPlatform,
): SessionMessage {
  return {
    role: message.author.isMe ? "assistant" : "user",
    parts: sessionMessageParts(message),
    metadata: sessionMetadata(message, platform),
  };
}

function sessionMessageParts(message: SessionApiMessage): JsonValue[] {
  const parts: JsonValue[] = [];
  if (message.text.trim()) {
    parts.push({ type: "text", text: message.text });
  }
  for (const attachment of message.attachments) {
    parts.push({
      ...attachment,
      attachment_type: attachment.type,
      type: "attachment",
    });
  }
  return parts.length > 0 ? parts : [{ type: "text", text: "" }];
}

function sessionMetadata(
  message: SessionApiMessage,
  platform: SessionPlatform,
  extra: JsonObject = {},
): JsonObject {
  return {
    source: platform.source,
    platform: platform.platform,
    message_id: message.id,
    thread_id: message.threadId,
    is_mention: message.isMention,
    timestamp: message.timestamp,
    user_id: message.author.userId,
    user_name: message.author.userName,
    ...extra,
  };
}

function toCodexInputLine(
  message: SessionApiMessage,
  threadId: string,
  platform: SessionPlatform,
): string {
  return JSON.stringify({
    type: "user",
    thread_key: threadId,
    trace_metadata: sessionMetadata(message, platform, { action: "execute" }),
    message: {
      role: "user",
      content: codexInputContent(message, platform),
    },
  });
}

function codexInputContent(
  message: SessionApiMessage,
  platform: SessionPlatform,
): JsonValue[] {
  const content: JsonValue[] = [];
  if (message.text.trim()) {
    content.push({ type: "text", text: message.text });
  }
  for (const attachment of message.attachments) {
    content.push(codexAttachmentInput(attachment, platform));
  }
  return content.length > 0 ? content : [{ type: "text", text: "continue" }];
}

function codexAttachmentInput(
  attachment: SessionApiAttachment,
  platform: SessionPlatform,
): JsonValue {
  const dataUrl =
    attachment.dataBase64 && attachment.mimeType
      ? `data:${attachment.mimeType};base64,${attachment.dataBase64}`
      : undefined;
  if (attachment.type === "image" && (dataUrl || attachment.url)) {
    return {
      type: "image",
      url: dataUrl ?? attachment.url,
      detail: "auto",
      name: attachment.name,
    };
  }
  return {
    type: "text",
    text: attachmentDescription(attachment, platform),
  };
}

function attachmentDescription(
  attachment: SessionApiAttachment,
  platform: SessionPlatform,
): string {
  const fields = [
    `name=${attachment.name ?? "attachment"}`,
    `type=${attachment.type}`,
    attachment.mimeType ? `mime=${attachment.mimeType}` : undefined,
    attachment.url ? `url=${attachment.url}` : undefined,
    // TODO: Upload files through POST /session/{thread_key}/attachments and pass refs here.
    attachment.dataBase64 ? `base64=${attachment.dataBase64}` : undefined,
    attachment.fetchError ? `fetch_error=${attachment.fetchError}` : undefined,
  ].filter(Boolean);
  return `[${platform.attachmentLabel}: ${fields.join(" ")}]`;
}

type ParsedSessionEvent = {
  data: string;
  event?: string;
  id?: number;
};

async function* parseSessionEventStream(
  stream: ReadableStream<Uint8Array>,
  onEventId: (eventId: number) => void,
): AsyncIterable<SessionRendererSource> {
  for await (const event of parseSseEvents(stream)) {
    if (typeof event.id === "number") onEventId(event.id);
    if (event.event === "session.output.line") {
      yield {
        data: event.data,
        event: event.event,
        eventId: event.id,
        eventKind: event.event,
      } satisfies RustSessionStreamEvent;
      if (isTerminalCodexOutputLine(event.data)) return;
      continue;
    }
    if (
      event.event === "session.execution_failed" ||
      event.event === "session.stream_error"
    ) {
      yield {
        data: { error: sessionErrorMessage(event) },
        event: event.event,
        eventId: event.id,
        eventKind: event.event,
      } satisfies RustSessionStreamEvent;
      return;
    }
  }
}

async function* parseSseEvents(
  stream: ReadableStream<Uint8Array>,
): AsyncIterable<ParsedSessionEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName: string | undefined;
  let eventId: number | undefined;
  let data: string[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const emitted = parseSseLine(line, { data, eventId, eventName });
      data = emitted.state.data;
      eventId = emitted.state.eventId;
      eventName = emitted.state.eventName;
      if (emitted.event) yield emitted.event;
    }
  }

  buffer += decoder.decode();
  if (buffer) {
    const emitted = parseSseLine(buffer, { data, eventId, eventName });
    data = emitted.state.data;
    eventId = emitted.state.eventId;
    eventName = emitted.state.eventName;
    if (emitted.event) yield emitted.event;
  }
  if (data.length > 0) {
    yield { data: data.join("\n"), event: eventName, id: eventId };
  }
}

function parseSseLine(
  line: string,
  state: {
    data: string[];
    eventId?: number;
    eventName?: string;
  },
): {
  event?: ParsedSessionEvent;
  state: { data: string[]; eventId?: number; eventName?: string };
} {
  if (!line.trim()) {
    const event =
      state.data.length > 0
        ? {
            data: state.data.join("\n"),
            event: state.eventName,
            id: state.eventId,
          }
        : undefined;
    return { event, state: { data: [] } };
  }
  if (line.startsWith(":")) return { state };

  const separator = line.indexOf(":");
  const field = separator >= 0 ? line.slice(0, separator) : line;
  const value =
    separator >= 0 ? line.slice(separator + 1).replace(/^ /, "") : "";
  if (field === "event") return { state: { ...state, eventName: value } };
  if (field === "id") {
    const id = Number.parseInt(value, 10);
    return {
      state: { ...state, eventId: Number.isFinite(id) ? id : undefined },
    };
  }
  if (field === "data" && value !== "[DONE]") {
    return { state: { ...state, data: [...state.data, value] } };
  }

  return { state };
}

function isTerminalCodexOutputLine(line: string): boolean {
  let payload: unknown;
  try {
    payload = JSON.parse(line);
  } catch {
    return true;
  }
  if (!isJsonObject(payload)) return false;

  return (
    payload.type === "turn.completed" ||
    payload.type === "turn.failed" ||
    payload.type === "turn.done" ||
    payload.method === "error" ||
    payload.method === "turn/completed"
  );
}

function sessionErrorMessage(event: ParsedSessionEvent): string {
  let message = `${event.event ?? "session error"}`;
  try {
    const payload = JSON.parse(event.data);
    if (isJsonObject(payload)) {
      message =
        stringValue(payload.error) ?? stringValue(payload.message) ?? message;
    }
  } catch {
    if (event.data.trim()) message = event.data.trim();
  }
  return message;
}
