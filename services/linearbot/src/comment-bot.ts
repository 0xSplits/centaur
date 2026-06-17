import type { ChatSDKStreamChunk } from "@centaur/rendering";

// Centaur-forward Linear model: threads are king. A Linear comment thread maps
// to one centaur sandbox/context, and the bot answers IN the thread with a
// single visible comment that is live-edited: posted with the first thought as a
// collapsed "Thinking…" section, then swapped in place to the answer with its
// chain-of-thought tucked into a collapsed section (slackbot-style). The
// agent-session widget is vestigial (settled minimally; see index.ts). This
// module is the pure rendering side: mention detection, the stream→reply
// collector, and the comment bodies (thinking + final).

const COT_MAX_LINES = 40;
const COT_LINE_MAX_CHARS = 300;
const COT_TOTAL_MAX_CHARS = 8_000;
const ANSWER_MAX_CHARS = 50_000;

type CommentBotTaskChunk = Extract<ChatSDKStreamChunk, { type: "task_update" }>;

/**
 * True when the comment addresses the bot. Linear encodes a mention as the
 * mentioned profile's PLAIN URL in the markdown body
 * (`https://linear.app/{ws}/profiles/{handle}`) — NOT `@name` text or the user
 * UUID (see linear.app/developers/graphql#adding-mentions-in-markdown). So match
 * the bot's profile handle in such a URL first; fall back to the user id and a
 * typed `@name` for robustness.
 */
export function commentMentionsBot(
  body: string,
  names: string[],
  markers: { botUserId?: string; profileHandle?: string } = {},
): boolean {
  if (
    markers.profileHandle &&
    body.includes(`/profiles/${markers.profileHandle}`)
  ) {
    return true;
  }
  if (markers.botUserId && body.includes(markers.botUserId)) return true;
  const haystack = body.toLowerCase();
  return names.some((name) => {
    const needle = name.trim().toLowerCase();
    return needle.length > 0 && haystack.includes(`@${needle}`);
  });
}

/**
 * Accumulates a streamed run into the two parts of a comment reply: the answer
 * markdown, and a chain-of-thought transcript (reasoning + tool actions). Built
 * to mirror the agent-session narrator's selection logic, but flattened into a
 * single collapsed block instead of live activities.
 */
export class CommentReplyCollector {
  private answerText = "";
  private cot: string[] = [];
  private cotChars = 0;
  // The renderer re-emits terminal task updates at stream close; one line per
  // task id is enough (mirrors the narrator's settledTaskIds).
  private readonly settledTaskIds = new Set<string>();
  // The command/reasoning text arrives on the in-progress update; the terminal
  // update often omits `details` (carrying only output). Cache per task id so
  // the settled line keeps its parameter — mirrors the narrator's taskDetails.
  private readonly taskDetails = new Map<string, string>();
  private sawError = false;
  private errorTextValue = "";

  update(chunk: ChatSDKStreamChunk): void {
    if (chunk.type === "markdown_text") {
      this.answerText += chunk.text;
      return;
    }
    if (chunk.type === "plan_update") {
      this.pushCot(`▸ ${chunk.title}`);
      return;
    }
    if (chunk.type !== "task_update") return;
    if (chunk.details) this.taskDetails.set(chunk.id, chunk.details);
    if (chunk.status === "error") {
      this.sawError = true;
      this.errorTextValue = [chunk.title, chunk.output ?? chunk.details]
        .filter(Boolean)
        .join("\n");
    }
    // Only persist settled tasks; in-progress repeats are noise in a static
    // transcript.
    if (chunk.status !== "complete" && chunk.status !== "error") return;
    if (this.settledTaskIds.has(chunk.id)) return;
    this.settledTaskIds.add(chunk.id);
    this.pushCot(this.formatTaskLine(chunk));
  }

  private formatTaskLine(chunk: CommentBotTaskChunk): string {
    const detail = (
      this.taskDetails.get(chunk.id) ??
      chunk.details ??
      chunk.output ??
      ""
    ).trim();
    // A bare "Thinking" with no captured reasoning is noise; skip it.
    if (chunk.title === "Thinking") return detail;
    return detail ? `${chunk.title}: ${detail}` : chunk.title;
  }

  get answer(): string {
    return this.answerText.trim();
  }

  get cotLines(): string[] {
    return this.cot;
  }

  get failed(): boolean {
    return this.sawError;
  }

  get errorText(): string {
    return this.errorTextValue;
  }

  private pushCot(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (
      this.cot.length >= COT_MAX_LINES ||
      this.cotChars >= COT_TOTAL_MAX_CHARS
    )
      return;
    const capped =
      trimmed.length > COT_LINE_MAX_CHARS
        ? `${trimmed.slice(0, COT_LINE_MAX_CHARS)}…`
        : trimmed;
    this.cot.push(capped);
    this.cotChars += capped.length;
  }
}

/**
 * The in-progress body for the live reply: the chain-of-thought so far folded
 * into a collapsed "Thinking…" section. Posted with the first thought and edited
 * as more arrive; once the run settles, buildCommentReplyBody replaces it with
 * the answer above a "Chain of thought" section.
 */
export function buildThinkingReplyBody(cotLines: string[]): string {
  const cot = cotLines.length
    ? cotLines.map((line) => `- ${line}`).join("\n")
    : "…";
  return collapsibleSection("Thinking…", cot);
}

/**
 * Composes the single comment posted back to the thread: the answer, then the
 * chain-of-thought folded into a collapsed section (omitted when empty).
 */
export function buildCommentReplyBody(input: {
  answer: string;
  cotLines: string[];
  fallback?: string;
}): string {
  const raw =
    input.answer.trim() ||
    input.fallback?.trim() ||
    "Execution completed, but no final text was captured.";
  const answer =
    raw.length > ANSWER_MAX_CHARS
      ? `${raw.slice(0, ANSWER_MAX_CHARS).trimEnd()}\n[truncated]`
      : raw;
  if (input.cotLines.length === 0) return answer;
  const cot = input.cotLines.map((line) => `- ${line}`).join("\n");
  return `${answer}\n\n${collapsibleSection("Chain of thought", cot)}`;
}

/**
 * A Linear collapsible section (the editor's `>>>` text shortcut). Isolated so
 * the exact markdown can be tweaked once verified against a live workspace — if
 * Linear does not honor `>>>` in a `commentCreate` body the content still
 * renders, just un-collapsed under a literal `>>>` line.
 */
export function collapsibleSection(summary: string, body: string): string {
  return `>>> ${summary}\n${body}`;
}
