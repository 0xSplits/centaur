import type { ChatSDKStreamChunk } from "@centaur/rendering";
import type { Logger, Thread } from "chat";
import { agentSessionIdFromThreadKey } from "./linear-threading";
import type {
  LinearActivityClient,
  LinearSessionCapableAdapter,
} from "./types";
import { errorMessage, nowMs } from "./utils";

export type LinearNarratorChunk = Exclude<
  ChatSDKStreamChunk,
  { type: "markdown_text" }
>;

/** Terminal state the run settles into. */
export type LinearNarratorOutcome = "done" | "failed" | "retrying";

// Thoughts that complete within this window merge into one activity; keeps the
// session timeline readable instead of one activity per reasoning fragment.
const NARRATOR_MIN_POST_GAP_MS = 2_000;
// Runaway runs stop narrating past this many posted activities; the final
// response/error activity is exempt from the budget.
const NARRATOR_MAX_ACTIVITIES = 30;
// A single thought activity is truncated to this, and a thought still pending
// at this size is flushed early so long reasoning doesn't sit invisible.
const NARRATOR_THOUGHT_MAX_CHARS = 1_500;
// Fragments shorter than this aren't worth an activity of their own.
const NARRATOR_MIN_THOUGHT_CHARS = 12;
const NARRATOR_ACTION_MAX_CHARS = 120;
const NARRATOR_PARAMETER_MAX_CHARS = 500;
const NARRATOR_RESULT_MAX_CHARS = 2_000;
const NARRATOR_ERROR_MAX_CHARS = 4_000;

export type LinearNarratorOptions = {
  logger: Logger;
  maxActivities?: number;
  minPostGapMs?: number;
};

/**
 * The Linear-side chain-of-thought surface, mapped onto Linear's native agent
 * activity types (https://linear.app/developers/agents):
 *
 * - An ephemeral `thought` lands immediately when the narrator starts — this
 *   is the acknowledgement Linear requires within 10 seconds of the session
 *   starting, and it doubles as the persistent "working" indicator (an
 *   ephemeral activity stays visible until the next activity replaces it).
 * - The agent's reasoning blurbs post as persistent `thought` activities as
 *   each thought completes (min-gap merged, budget-capped).
 * - Commands/tools post as `action` activities: ephemeral while running (each
 *   replaces the working indicator), persistent once complete.
 * - The final answer is NOT posted here — the renderer posts it as the
 *   session's `response` (or `error`) activity.
 *
 * Agent sessions are append-only (no edits/deletes), so like the Discord
 * narrator this never mutates anything it posted. On a plain comment thread
 * (comments mode) the narrator is inert except for the typing ack, which the
 * adapter no-ops; the run still produces its final posted answer.
 */
export class LinearNarrator {
  private readonly logger: Logger;
  private readonly minPostGapMs: number;
  private readonly maxActivities: number;
  private readonly agentSessionId: string | undefined;
  private readonly client: LinearActivityClient | undefined;
  // Current thought, keyed by chunk id: reasoning deltas have unique ids and
  // concatenate; a commentary item re-uses its id and replaces its body.
  private pendingParts = new Map<string, string>();
  // Task details (the command/tool input) arrive on the in-progress update;
  // the terminal update often carries only the output. Cache per task id so
  // the persisted action keeps its parameter.
  private taskDetails = new Map<string, string>();
  // The renderer re-emits terminal task updates when the stream settles; one
  // persistent action per task is enough.
  private settledTaskIds = new Set<string>();
  private queuedThoughts: string[] = [];
  private postedCount = 0;
  private droppedActivities = 0;
  private lastPostAtMs = 0;
  private sawError = false;
  private lastErrorText = "";
  private timer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<void> = Promise.resolve();
  private finished = false;

  private constructor(thread: Thread, options: LinearNarratorOptions) {
    this.logger = options.logger;
    this.minPostGapMs = options.minPostGapMs ?? NARRATOR_MIN_POST_GAP_MS;
    this.maxActivities = options.maxActivities ?? NARRATOR_MAX_ACTIVITIES;
    this.agentSessionId = agentSessionIdFromThreadKey(thread.id);
    this.client = (
      thread.adapter as unknown as LinearSessionCapableAdapter
    ).linearClient;
  }

  /** Creates the narrator; the working ack is sent via ackWorking(). */
  static start(thread: Thread, options: LinearNarratorOptions): LinearNarrator {
    return new LinearNarrator(thread, options);
  }

  /** True when an in-stream error task was observed. */
  get failed(): boolean {
    return this.sawError;
  }

  /** Last error task text, for the terminal error activity body. */
  get errorText(): string {
    return this.lastErrorText;
  }

  update(chunk: LinearNarratorChunk): void {
    if (this.finished) return;
    if (chunk.type === "plan_update") {
      // A plan update means the model moved on — the current thought is over.
      this.flushPending();
      return;
    }
    if (chunk.type !== "task_update") return;
    if (chunk.status === "error") {
      this.sawError = true;
      this.lastErrorText = [chunk.title, chunk.output ?? chunk.details]
        .filter(Boolean)
        .join("\n");
    }
    if (chunk.title === "Thinking") {
      if (chunk.details) this.pendingParts.set(chunk.id, chunk.details);
      if (
        chunk.status === "complete" ||
        this.pendingText().length >= NARRATOR_THOUGHT_MAX_CHARS
      ) {
        this.flushPending();
      }
      return;
    }
    // Commands/tools: close out the current thought, then narrate the action.
    // The thought posts immediately (not via the min-gap timer) so the
    // timeline keeps its order — the activity chain serializes the posts.
    if (chunk.details) this.taskDetails.set(chunk.id, chunk.details);
    const terminal = chunk.status === "complete" || chunk.status === "error";
    if (terminal) {
      if (this.settledTaskIds.has(chunk.id)) return;
      this.settledTaskIds.add(chunk.id);
    }
    this.flushPendingText();
    this.enqueueThoughtPost();
    this.enqueueAction(chunk);
  }

  /**
   * Posts any remaining thought, then settles the run: on failure (explicit,
   * or a "done" downgraded by an in-stream error task) emits the terminal
   * `error` activity with `finalText` (the accumulated failure markdown) as
   * its body. Never throws — narration is cosmetic; the durable answer path
   * is the renderer's response post.
   */
  async finish(
    outcome: LinearNarratorOutcome,
    finalText?: string,
  ): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.flushPendingText();
    this.enqueueThoughtPost();
    // "retrying" never settles the run: the retry attempt re-renders and its
    // own finish posts the terminal activity.
    const failed =
      outcome === "failed" || (outcome === "done" && this.sawError);
    if (failed) {
      const body =
        (finalText ?? "").trim() ||
        this.lastErrorText ||
        "The run failed before producing a result.";
      this.enqueueActivity(
        {
          type: "error",
          body: truncate(body, NARRATOR_ERROR_MAX_CHARS, "error"),
        },
        { countsAgainstBudget: false },
      );
    }
    await this.chain;
    if (this.droppedActivities) {
      this.logger.debug("linearbot_narrator_activities_dropped", {
        dropped: this.droppedActivities,
      });
    }
  }

  private pendingText(): string {
    return Array.from(this.pendingParts.values()).join("").trim();
  }

  private flushPending(): void {
    this.flushPendingText();
    this.schedulePost();
  }

  private flushPendingText(): void {
    const text = this.pendingText();
    this.pendingParts = new Map();
    if (text.length < NARRATOR_MIN_THOUGHT_CHARS) return;
    this.queuedThoughts.push(
      truncate(text, NARRATOR_THOUGHT_MAX_CHARS, "thought"),
    );
  }

  private schedulePost(): void {
    if (this.timer || !this.queuedThoughts.length) return;
    const delayMs = Math.max(
      0,
      this.minPostGapMs - (nowMs() - this.lastPostAtMs),
    );
    this.timer = setTimeout(() => {
      this.timer = null;
      this.enqueueThoughtPost();
    }, delayMs);
  }

  private enqueueThoughtPost(): void {
    if (!this.queuedThoughts.length) return;
    const body = this.queuedThoughts.join("\n\n");
    this.queuedThoughts = [];
    this.lastPostAtMs = nowMs();
    this.enqueueActivity({ type: "thought", body });
  }

  private enqueueAction(
    chunk: Extract<ChatSDKStreamChunk, { type: "task_update" }>,
  ): void {
    // Running actions are ephemeral: they replace the working indicator and
    // are themselves replaced by the next activity, so only the completed
    // action persists in the timeline (and only that draws on the budget).
    const ephemeral = chunk.status !== "complete" && chunk.status !== "error";
    const result = chunk.output;
    this.enqueueActivity(
      {
        type: "action",
        action: truncate(chunk.title, NARRATOR_ACTION_MAX_CHARS, "action"),
        parameter: truncate(
          chunk.details ?? this.taskDetails.get(chunk.id) ?? "",
          NARRATOR_PARAMETER_MAX_CHARS,
          "parameter",
        ),
        ...(result
          ? { result: truncate(result, NARRATOR_RESULT_MAX_CHARS, "result") }
          : {}),
      },
      { ephemeral },
    );
  }

  private enqueueActivity(
    content: Parameters<
      LinearActivityClient["createAgentActivity"]
    >[0]["content"],
    options: { countsAgainstBudget?: boolean; ephemeral?: boolean } = {},
  ): void {
    const client = this.client;
    const agentSessionId = this.agentSessionId;
    if (!client || !agentSessionId) return;
    const countsAgainstBudget =
      (options.countsAgainstBudget ?? true) && options.ephemeral !== true;
    if (countsAgainstBudget) {
      if (this.postedCount >= this.maxActivities) {
        this.droppedActivities += 1;
        return;
      }
      this.postedCount += 1;
    }
    this.chain = this.chain.then(async () => {
      try {
        await client.createAgentActivity({
          agentSessionId,
          content,
          ...(options.ephemeral ? { ephemeral: true } : {}),
        });
      } catch (error) {
        this.logger.warn("linearbot_narrator_activity_failed", {
          activity_type: content.type,
          error: errorMessage(error),
        });
      }
    });
  }
}

/**
 * Best-effort working acknowledgement: an ephemeral thought via the adapter's
 * startTyping. Fired first thing in the mention handler — Linear expects a
 * thought within 10 seconds of the session starting, well before the
 * context-collection/session-create handoff completes. Never throws.
 */
export function ackWorking(thread: Thread, logger: Logger): void {
  const adapter = thread.adapter as unknown as LinearSessionCapableAdapter;
  if (!adapter.startTyping) return;
  void adapter.startTyping(thread.id, "Looking into it…").catch((error) => {
    logger.debug("linearbot_ack_failed", { error: errorMessage(error) });
  });
}

function truncate(value: string, maxChars: number, label: string): string {
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
