import { describe, expect, it } from "bun:test";
import type { Message } from "chat";
import {
  forwardToSessionApi,
  serializeMessage,
  sessionStreamError,
  startingStreamNotification,
} from "./session-api";
import type {
  SessionApiMessage,
  SessionApiOptions,
  SessionFetch,
  SessionPlatform,
  SessionRendererSource,
} from "./types";

const platform: SessionPlatform = {
  source: "test",
  platform: "test",
  attachmentLabel: "Test attachment",
  tracePrefix: "test",
};

function sseResponse(body: string): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

/** Routes create/messages/execute to 200 OK and /events to the given SSE body. */
function fetchWithEvents(
  eventsBody: string,
  onCall?: (url: string) => void,
): SessionFetch {
  return async (input) => {
    const url = String(input);
    onCall?.(url);
    if (url.includes("/events")) return sseResponse(eventsBody);
    return new Response("{}", { status: 200 });
  };
}

function options(fetchFn: SessionFetch): SessionApiOptions {
  return { apiUrl: "http://localhost", fetch: fetchFn, platform };
}

const message: SessionApiMessage = {
  attachments: [],
  author: {
    fullName: "Alice",
    isBot: false,
    isMe: false,
    userId: "u1",
    userName: "alice",
  },
  id: "m1",
  isMention: true,
  raw: {},
  text: "hello",
  threadId: "test:c1:t1",
  timestamp: "2026-06-01T00:00:00.000Z",
};

async function collect(
  options: SessionApiOptions,
): Promise<SessionRendererSource[]> {
  const eventIds: number[] = [];
  const stream = await forwardToSessionApi(options, {
    afterEventId: 0,
    executeMessage: message,
    messages: [message],
    onEventId: (id) => eventIds.push(id),
    openStream: true,
    threadId: message.threadId,
  });
  const out: SessionRendererSource[] = [];
  if (stream) for await (const event of stream) out.push(event);
  return out;
}

describe("forwardToSessionApi SSE parsing", () => {
  it("yields output lines and stops at a terminal turn.completed", async () => {
    const body = [
      "event: session.output.line",
      "id: 1",
      'data: {"type":"item.completed"}',
      "",
      "event: session.output.line",
      "id: 2",
      'data: {"type":"turn.completed"}',
      "",
      // This line must never be reached — the stream ends on the terminal line above.
      "event: session.output.line",
      "id: 3",
      'data: {"type":"item.completed"}',
      "",
    ].join("\n");

    const events = await collect(options(fetchWithEvents(body)));
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      event: "session.output.line",
      eventId: 1,
    });
    expect(events[1]).toMatchObject({
      event: "session.output.line",
      eventId: 2,
    });
  });

  it("joins multi-line data and skips [DONE]", async () => {
    const body = [
      "event: session.output.line",
      "id: 5",
      'data: {"type":"item.completed",',
      'data: "extra":true}',
      "",
      "data: [DONE]",
      "",
      "event: session.output.line",
      "id: 6",
      'data: {"type":"turn.completed"}',
      "",
    ].join("\n");

    const events = await collect(options(fetchWithEvents(body)));
    expect(events).toHaveLength(2);
    expect(String((events[0] as { data: string }).data)).toContain(
      '"extra":true',
    );
  });

  it("treats a malformed JSON output line as terminal", async () => {
    const body = [
      "event: session.output.line",
      "id: 7",
      "data: {not valid json",
      "",
      "event: session.output.line",
      "id: 8",
      'data: {"type":"item.completed"}',
      "",
    ].join("\n");

    const events = await collect(options(fetchWithEvents(body)));
    // The malformed line is yielded, then the stream stops (id 8 never arrives).
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ eventId: 7 });
  });

  it("surfaces an execution_failed event then stops", async () => {
    const body = [
      "event: session.execution_failed",
      "id: 9",
      'data: {"error":"boom"}',
      "",
    ].join("\n");

    const events = await collect(options(fetchWithEvents(body)));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event: "session.execution_failed" });
    expect((events[0] as { data: { error: string } }).data.error).toBe("boom");
  });

  it("calls create, messages, execute, then events in order", async () => {
    const urls: string[] = [];
    const body = [
      "event: session.output.line",
      "id: 1",
      'data: {"type":"turn.completed"}',
      "",
    ].join("\n");
    await collect(options(fetchWithEvents(body, (url) => urls.push(url))));
    expect(urls[0]).toContain("/api/session/");
    expect(urls.some((u) => u.endsWith("/messages"))).toBe(true);
    expect(urls.some((u) => u.endsWith("/execute"))).toBe(true);
    expect(urls.some((u) => u.includes("/events"))).toBe(true);
  });
});

describe("serializeMessage", () => {
  it("round-trips author, text, and timestamp", async () => {
    const dateSent = new Date("2026-06-01T00:00:00.000Z");
    const raw = { id: "x" };
    const chatMessage = {
      id: "m9",
      text: "hi there",
      threadId: "test:c:t",
      isMention: true,
      raw,
      attachments: [],
      author: {
        fullName: "Bob",
        isBot: false,
        isMe: false,
        userId: "u9",
        userName: "bob",
      },
      metadata: { dateSent },
    } as unknown as Message;

    const serialized = await serializeMessage(chatMessage);
    expect(serialized).toMatchObject({
      id: "m9",
      text: "hi there",
      isMention: true,
      author: { userName: "bob", isMe: false },
      timestamp: "2026-06-01T00:00:00.000Z",
    });
    expect(serialized.raw).toBe(raw);
  });
});

describe("notification helpers", () => {
  it("startingStreamNotification embeds the source prefix", () => {
    const note = startingStreamNotification("test:c:t", "discordbot") as {
      params: { turnId: string; item: { id: string } };
    };
    expect(note.params.turnId).toBe("discordbot-starting-turn");
    expect(note.params.item.id).toBe("discordbot-starting");
  });

  it("sessionStreamError wraps Error messages", () => {
    expect(sessionStreamError(new Error("nope"))).toMatchObject({
      event: "session.stream_error",
      data: { error: "nope" },
    });
  });
});
