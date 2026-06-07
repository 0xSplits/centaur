import type { ChatSDKStreamChunk } from "@centaur/rendering";
import type { Logger, Thread } from "chat";
import { elapsedMs, errorMessage, nowMs } from "./utils";

export type DiscordProgressChunk = Exclude<
  ChatSDKStreamChunk,
  { type: "markdown_text" }
>;
type DiscordTaskChunk = Extract<ChatSDKStreamChunk, { type: "task_update" }>;
type DiscordTaskStatus = DiscordTaskChunk["status"];

/** Terminal state the progress message settles into. */
export type DiscordProgressOutcome = "done" | "failed" | "retrying";

// Discord caps message content at 2000 chars; headroom keeps every edit safe.
const PROGRESS_MESSAGE_MAX_CHARS = 1_900;
const PROGRESS_SNIPPET_MAX_CHARS = 280;
const PROGRESS_COMMAND_MAX_CHARS = 64;
const PROGRESS_TITLE_MAX_CHARS = 80;
// Steps beyond this fall off the front of the model and render as "… earlier steps".
const PROGRESS_MAX_TRACKED_STEPS = 120;
// Stay well below Discord's ~5 edits/5s per-channel budget; the answer message
// streams its own post+edit cycle in parallel with these edits.
const PROGRESS_EDIT_INTERVAL_MS = 1_500;

type ProgressStep = {
  command?: string;
  snippetParts: Map<string, string>;
  status: DiscordTaskStatus;
  title: string;
};

/**
 * Pure model + renderer for the progress message: an ordered step timeline built
 * from the renderer's task/plan updates, with the latest reasoning excerpt quoted
 * under the current "Thinking" step.
 */
export class DiscordProgressTimeline {
  private readonly placeholderText: string;
  private readonly steps: ProgressStep[] = [];
  private readonly stepById = new Map<string, ProgressStep>();
  private planTitle: string | null = null;
  private droppedSteps = 0;
  private outcome: DiscordProgressOutcome | null = null;
  private elapsedLabel = "";

  constructor(placeholderText: string) {
    this.placeholderText = placeholderText;
  }

  update(chunk: DiscordProgressChunk): void {
    if (this.outcome) return;
    if (chunk.type === "plan_update") {
      this.planTitle = oneLine(chunk.title, PROGRESS_TITLE_MAX_CHARS);
      return;
    }
    const existing = this.stepById.get(chunk.id);
    if (existing) {
      existing.status = chunk.status;
      captureDetails(existing, chunk);
      return;
    }
    const last = this.steps.at(-1);
    if (chunk.title === "Thinking" && last?.title === "Thinking") {
      // Reasoning deltas arrive as one task per delta; consecutive Thinking
      // updates merge into a single step so the timeline reads as one thought.
      // A command or tool call in between starts a fresh Thinking step.
      this.stepById.set(chunk.id, last);
      last.status = chunk.status;
      captureDetails(last, chunk);
      return;
    }
    const step: ProgressStep = {
      snippetParts: new Map(),
      status: chunk.status,
      title: oneLine(chunk.title, PROGRESS_TITLE_MAX_CHARS),
    };
    captureDetails(step, chunk);
    this.steps.push(step);
    this.stepById.set(chunk.id, step);
    if (this.steps.length > PROGRESS_MAX_TRACKED_STEPS) {
      this.steps.shift();
      this.droppedSteps += 1;
    }
  }

  /**
   * Settles the timeline. A "done" outcome downgrades to "failed" when any step
   * errored (the renderer surfaces in-stream failures as error tasks, not throws).
   * "retrying" leaves step statuses alone — a fresh progress message follows.
   */
  finish(outcome: DiscordProgressOutcome, runElapsedMs: number): void {
    if (this.outcome) return;
    const failed =
      outcome === "failed" || (outcome === "done" && this.hasError());
    this.outcome = failed ? "failed" : outcome;
    this.elapsedLabel = formatDuration(runElapsedMs);
    if (this.outcome === "retrying") return;
    const settledStatus: DiscordTaskStatus =
      this.outcome === "failed" ? "error" : "complete";
    for (const step of this.steps) {
      if (step.status === "in_progress" || step.status === "pending") {
        step.status = settledStatus;
      }
    }
  }

  render(): string {
    const headLines = [this.headerLine()];
    if (this.planTitle) headLines.push(`*${this.planTitle}*`);
    const blocks = this.steps.map((step, index) =>
      stepBlock(step, index === this.steps.length - 1),
    );
    let omitted = this.droppedSteps;
    const compose = (): string => {
      const lines = [...headLines];
      if (blocks.length || omitted) lines.push("");
      if (omitted) {
        lines.push(`*… ${omitted} earlier step${omitted === 1 ? "" : "s"}*`);
      }
      lines.push(...blocks);
      return lines.join("\n");
    };
    let content = compose();
    while (content.length > PROGRESS_MESSAGE_MAX_CHARS && blocks.length > 1) {
      blocks.shift();
      omitted += 1;
      content = compose();
    }
    return content.length > PROGRESS_MESSAGE_MAX_CHARS
      ? content.slice(0, PROGRESS_MESSAGE_MAX_CHARS)
      : content;
  }

  private headerLine(): string {
    if (this.outcome === "done") return `✅ **Done** · ${this.elapsedLabel}`;
    if (this.outcome === "failed")
      return `❌ **Failed** · ${this.elapsedLabel}`;
    if (this.outcome === "retrying") {
      return "🔁 **Stream interrupted — retrying...**";
    }
    return this.placeholderText;
  }

  private hasError(): boolean {
    return this.steps.some((step) => step.status === "error");
  }
}

export type DiscordProgressMessageOptions = {
  editIntervalMs?: number;
  logger: Logger;
  placeholderText: string;
};

/**
 * The Discord-side chain-of-thought surface: a message posted the instant a run
 * starts, edited in place (throttled) as task/reasoning updates arrive, and
 * finalized — never deleted — when the run settles. The final answer streams into
 * a separate message, so this one stays put in the timeline as a record even when
 * new user messages arrive mid-run.
 */
export class DiscordProgressMessage {
  private readonly thread: Thread;
  private readonly timeline: DiscordProgressTimeline;
  private readonly intervalMs: number;
  private readonly logger: Logger;
  private readonly messageId: string;
  private readonly editThreadId: string;
  private readonly startedAtMs = nowMs();
  private lastContent: string;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private edits: Promise<void> = Promise.resolve();
  private finished = false;

  private constructor(
    thread: Thread,
    messageId: string,
    editThreadId: string,
    options: DiscordProgressMessageOptions,
  ) {
    this.thread = thread;
    this.timeline = new DiscordProgressTimeline(options.placeholderText);
    this.intervalMs = options.editIntervalMs ?? PROGRESS_EDIT_INTERVAL_MS;
    this.logger = options.logger;
    this.messageId = messageId;
    this.editThreadId = editThreadId;
    this.lastContent = options.placeholderText;
  }

  static async post(
    thread: Thread,
    options: DiscordProgressMessageOptions,
  ): Promise<DiscordProgressMessage> {
    const raw = await thread.adapter.postMessage(
      thread.id,
      options.placeholderText,
    );
    return new DiscordProgressMessage(
      thread,
      raw.id,
      raw.threadId || thread.id,
      options,
    );
  }

  update(chunk: DiscordProgressChunk): void {
    if (this.finished) return;
    this.timeline.update(chunk);
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.enqueueEdit();
    }, this.intervalMs);
  }

  /** Applies the final edit. Never throws — progress rendering is cosmetic. */
  async finish(outcome: DiscordProgressOutcome): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.timeline.finish(outcome, elapsedMs(this.startedAtMs));
    this.enqueueEdit();
    await this.edits;
  }

  private enqueueEdit(): void {
    this.edits = this.edits.then(() => this.editNow());
  }

  private async editNow(): Promise<void> {
    const content = this.timeline.render();
    if (content === this.lastContent) return;
    try {
      await this.thread.adapter.editMessage(this.editThreadId, this.messageId, {
        markdown: content,
      });
      this.lastContent = content;
    } catch (error) {
      this.logger.warn("discordbot_progress_edit_failed", {
        error: errorMessage(error),
      });
    }
  }
}

export function isCommandExecutionTask(chunk: {
  id: string;
  title: string;
}): boolean {
  return (
    chunk.id.startsWith("call_") ||
    chunk.title.toLowerCase().includes("command execution")
  );
}

function captureDetails(step: ProgressStep, chunk: DiscordTaskChunk): void {
  if (!chunk.details) return;
  if (step.title === "Thinking") {
    step.snippetParts.set(chunk.id, chunk.details);
    return;
  }
  if (!step.command && isCommandExecutionTask(chunk)) {
    step.command = commandPreview(chunk.details);
  }
}

function stepBlock(step: ProgressStep, isLatest: boolean): string {
  const command = step.command ? `: \`${step.command}\`` : "";
  const line = `${statusEmoji(step.status)} ${step.title}${command}`;
  if (!isLatest || step.title !== "Thinking") return line;
  const snippet = snippetText(step);
  if (!snippet) return line;
  const quoted = snippet
    .split("\n")
    .map((snippetLine) => `> ${snippetLine}`)
    .join("\n");
  return `${line}\n${quoted}`;
}

function snippetText(step: ProgressStep): string {
  const text = Array.from(step.snippetParts.values())
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!text) return "";
  if (text.length <= PROGRESS_SNIPPET_MAX_CHARS) return text;
  return `…${text.slice(-PROGRESS_SNIPPET_MAX_CHARS)}`;
}

function statusEmoji(status: DiscordTaskStatus): string {
  if (status === "complete") return "✅";
  if (status === "error") return "❌";
  return "⏳";
}

/** First command line out of the renderer's fenced details block, one-lined. */
function commandPreview(details: string): string | undefined {
  const line = details
    .split("\n")
    .map((detailsLine) => detailsLine.trim())
    .find((detailsLine) => detailsLine && !detailsLine.startsWith("```"));
  if (!line) return undefined;
  return oneLine(line.replaceAll("`", "'"), PROGRESS_COMMAND_MAX_CHARS);
}

function oneLine(value: string, maxChars: number): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxChars) return collapsed;
  return `${collapsed.slice(0, maxChars - 1).trimEnd()}…`;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(1, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes ? `${minutes}m ${seconds}s` : `${seconds}s`;
}
