import type { ChatSDKStreamChunk } from "@centaur/rendering";
import type { Logger, Thread } from "chat";
import { parseDiscordThreadKey } from "./discord-allowlist";
import { DEFAULT_DISCORD_API_URL } from "./discord-threading";
import type { DiscordbotApiMessage, DiscordbotOptions } from "./types";
import { errorMessage } from "./utils";

export type DiscordNarratorChunk = Exclude<
  ChatSDKStreamChunk,
  { type: "markdown_text" }
>;
type DiscordTaskChunk = Extract<ChatSDKStreamChunk, { type: "task_update" }>;

/** Terminal state the run's reaction settles into. */
export type DiscordNarratorOutcome = "done" | "failed" | "retrying";

const REACTION_WORKING = "👀";
const REACTION_DONE = "✅";
const REACTION_FAILED = "❌";

const TRACE_FILENAME = "reasoning.txt";
const TRACE_MESSAGE_TEXT = "Full reasoning trace:";
// Discord rejects uploads past 10 MiB on un-boosted servers; stay safely under.
const TRACE_MAX_BYTES = 8 * 1024 * 1024;
const TRACE_TRUNCATION_NOTE = "[trace truncated]";

type TraceEntry =
  | { kind: "thinking"; text: string }
  | { kind: "plan"; title: string }
  | {
      kind: "task";
      title: string;
      status: DiscordTaskChunk["status"];
      details?: string;
      output?: string;
    };

export type DiscordNarratorOptions = {
  logger: Logger;
};

/**
 * The Discord-side chain-of-thought surface: the triggering message gets an
 * instant 👀 reaction while the agent works, the full reasoning trace —
 * thoughts, tool/command tasks (with details and output), and plan updates —
 * accumulates silently, and on settle it posts once as a reasoning.txt
 * attachment before the 👀 is swapped for ✅ (or ❌). A "retrying" settle also
 * posts the partial trace so the attempt's reasoning isn't lost when the retry
 * starts a fresh narrator. No bot message is ever edited or deleted.
 *
 * The trace rides its own trailing message rather than the answer post: the
 * answer streams via the chat SDK's post+edit path, which can't carry file
 * uploads, and the trace isn't complete until the run settles anyway.
 *
 * Reactions go through the raw Discord REST API rather than the adapter: a
 * thread-starter message lives in the PARENT channel (same delta that
 * motivates discord-starter.ts), while the adapter always routes reactions to
 * the thread.
 */
export class DiscordNarrator {
  private readonly thread: Thread;
  private readonly botOptions: DiscordbotOptions;
  private readonly logger: Logger;
  private readonly reactionChannelId: string | undefined;
  private readonly reactionMessageId: string;
  // Current thought, keyed by chunk id: reasoning deltas have unique ids and
  // concatenate; a commentary item re-uses its id and replaces its body.
  private pendingParts = new Map<string, string>();
  private entries: TraceEntry[] = [];
  // Tool/command tasks update in place (running → complete, output arrives
  // late) but keep their position from first appearance.
  private taskEntries = new Map<
    string,
    Extract<TraceEntry, { kind: "task" }>
  >();
  private sawError = false;
  private chain: Promise<void> = Promise.resolve();
  private finished = false;

  private constructor(
    thread: Thread,
    message: DiscordbotApiMessage,
    botOptions: DiscordbotOptions,
    options: DiscordNarratorOptions,
  ) {
    this.thread = thread;
    this.botOptions = botOptions;
    this.logger = options.logger;
    const { channelId, threadId } = parseDiscordThreadKey(thread.id);
    // A thread-starter message (id == thread id) lives in the parent channel;
    // anything else lives in the thread itself.
    this.reactionChannelId =
      message.id === threadId ? channelId : (threadId ?? channelId);
    this.reactionMessageId = message.id;
  }

  /** Adds the 👀 working reaction (best-effort) and returns the narrator. */
  static start(
    thread: Thread,
    message: DiscordbotApiMessage,
    botOptions: DiscordbotOptions,
    options: DiscordNarratorOptions,
  ): DiscordNarrator {
    const narrator = new DiscordNarrator(thread, message, botOptions, options);
    narrator.enqueueReaction("PUT", REACTION_WORKING);
    return narrator;
  }

  update(chunk: DiscordNarratorChunk): void {
    if (this.finished) return;
    if (chunk.type === "plan_update") {
      this.flushPendingThought();
      this.entries.push({ kind: "plan", title: chunk.title });
      return;
    }
    if (chunk.type !== "task_update") return;
    if (chunk.status === "error") this.sawError = true;
    if (chunk.title === "Thinking") {
      if (chunk.details) this.pendingParts.set(chunk.id, chunk.details);
      if (chunk.status === "complete") this.flushPendingThought();
      return;
    }
    // Any other task means the model moved on — the current thought is over.
    this.flushPendingThought();
    const existing = this.taskEntries.get(chunk.id);
    if (existing) {
      existing.status = chunk.status;
      if (chunk.details) existing.details = chunk.details;
      if (chunk.output) existing.output = chunk.output;
      return;
    }
    const entry: Extract<TraceEntry, { kind: "task" }> = {
      kind: "task",
      title: chunk.title,
      status: chunk.status,
      ...(chunk.details ? { details: chunk.details } : {}),
      ...(chunk.output ? { output: chunk.output } : {}),
    };
    this.taskEntries.set(chunk.id, entry);
    this.entries.push(entry);
  }

  /**
   * Posts the accumulated trace as a reasoning.txt attachment (when there is
   * one), then settles the reaction: ✅ on success, ❌ on failure, and 👀 stays
   * put for "retrying" (the retry attempt re-adds it; the PUT is idempotent).
   * Never throws — narration is cosmetic. A "done" outcome downgrades to
   * "failed" when an error task was seen (the renderer surfaces in-stream
   * failures as error tasks, not throws).
   */
  async finish(outcome: DiscordNarratorOutcome): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    this.flushPendingThought();
    this.enqueueTracePost();
    const failed =
      outcome === "failed" || (outcome === "done" && this.sawError);
    if (outcome !== "retrying") {
      // Add the settled reaction before clearing 👀 so the message always
      // carries an indicator.
      this.enqueueReaction("PUT", failed ? REACTION_FAILED : REACTION_DONE);
      this.enqueueReaction("DELETE", REACTION_WORKING);
    }
    await this.chain;
  }

  private flushPendingThought(): void {
    const text = Array.from(this.pendingParts.values()).join("").trim();
    this.pendingParts = new Map();
    if (!text) return;
    this.entries.push({ kind: "thinking", text });
  }

  private enqueueTracePost(): void {
    const trace = renderTrace(this.entries);
    if (!trace) return;
    this.chain = this.chain.then(async () => {
      try {
        await this.thread.adapter.postMessage(this.thread.id, {
          markdown: TRACE_MESSAGE_TEXT,
          files: [
            {
              data: Buffer.from(trace, "utf8"),
              filename: TRACE_FILENAME,
              mimeType: "text/plain",
            },
          ],
        });
      } catch (error) {
        this.logger.warn("discordbot_narrator_trace_post_failed", {
          error: errorMessage(error),
        });
      }
    });
  }

  private enqueueReaction(method: "PUT" | "DELETE", emoji: string): void {
    const channelId = this.reactionChannelId;
    if (!channelId) return;
    this.chain = this.chain.then(async () => {
      try {
        const fetchFn = this.botOptions.fetch ?? fetch;
        const apiBase = (
          this.botOptions.discordApiUrl ?? DEFAULT_DISCORD_API_URL
        ).replace(/\/$/, "");
        const response = await fetchFn(
          `${apiBase}/channels/${channelId}/messages/${this.reactionMessageId}/reactions/${encodeURIComponent(emoji)}/@me`,
          {
            method,
            headers: { authorization: `Bot ${this.botOptions.botToken}` },
          },
        );
        if (!response.ok) {
          this.logger.warn("discordbot_narrator_reaction_failed", {
            emoji,
            method,
            status: response.status,
          });
        }
      } catch (error) {
        this.logger.warn("discordbot_narrator_reaction_error", {
          emoji,
          method,
          error: errorMessage(error),
        });
      }
    });
  }
}

function renderTrace(entries: TraceEntry[]): string {
  const sections = entries.map((entry) => {
    if (entry.kind === "thinking") return `[thinking]\n${entry.text}`;
    if (entry.kind === "plan") return `[plan] ${entry.title}`;
    const header = `[${entry.title}] (${entry.status})`;
    const body = [
      entry.details?.trim(),
      entry.output?.trim() ? `--- output ---\n${entry.output.trim()}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    return body ? `${header}\n${body}` : header;
  });
  return clipTrace(sections.join("\n\n").trim());
}

function clipTrace(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= TRACE_MAX_BYTES) return text;
  const budget = TRACE_MAX_BYTES - TRACE_TRUNCATION_NOTE.length - 1;
  let keep = budget;
  while (Buffer.byteLength(text.slice(0, keep), "utf8") > budget) {
    keep = Math.floor(keep * 0.9);
  }
  return `${text.slice(0, keep).trimEnd()}\n${TRACE_TRUNCATION_NOTE}`;
}
