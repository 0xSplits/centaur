import type { Logger, Message as ChatMessage } from "chat";
import { parseLinearThreadKey } from "./linear-threading";
import type { LinearbotApiMessage } from "./types";
import { errorMessage, isJsonObject, stringValue } from "./utils";

// Linear delta (no slackbotv2 analog; closest relative is discord-starter's
// thread-starter prepend): the thread history for an agent session is just the
// session's comment thread, which misses the issue itself (title, description,
// state, labels) and the rest of the issue conversation. Linear solves this
// for agents natively: every AgentSessionEvent webhook carries a
// `promptContext` blob — pre-formatted issue details + comments, curated by
// Linear — which the adapter exposes on the raw message. Prefer that; fall
// back to the message subject (one issue fetch) when it is absent (comments
// mode, or replayed/fetched history messages).

const CONTEXT_MAX_CHARS = 100_000;

/**
 * Builds the synthetic "issue context" message prepended to the initial
 * session context. Returns null when no context could be derived; never
 * throws (context enrichment must not fail the turn).
 */
export async function buildLinearContextMessage(
  message: ChatMessage,
  logger: Logger,
): Promise<LinearbotApiMessage | null> {
  const text =
    promptContextText(message.raw) ?? (await subjectText(message, logger));
  if (!text) return null;
  const { issueId, agentSessionId } = parseLinearThreadKey(message.threadId);
  return {
    attachments: [],
    author: {
      fullName: "Linear",
      isBot: true,
      isMe: false,
      userId: "linear",
      userName: "linear",
    },
    // Stable per thread so forwardedMessageIds dedupes re-syncs.
    id: `linear-context-${agentSessionId ?? issueId ?? message.threadId}`,
    isMention: false,
    raw: { linearbotSyntheticContext: true },
    text: truncateContext(text),
    threadId: message.threadId,
    timestamp: message.metadata.dateSent.toISOString(),
  };
}

/**
 * Linear's own context blob from the AgentSessionEvent webhook, when present.
 */
function promptContextText(raw: unknown): string | undefined {
  if (!isJsonObject(raw)) return undefined;
  if (raw.kind !== "agent_session_comment") return undefined;
  const promptContext = stringValue(raw.agentSessionPromptContext);
  if (!promptContext) return undefined;
  return `[Linear issue context]\n\n${promptContext}`;
}

/**
 * Fallback context from the message subject (the Linear issue): identifier,
 * title, state, assignee, labels, url, and description.
 */
async function subjectText(
  message: ChatMessage,
  logger: Logger,
): Promise<string | undefined> {
  let subject: Awaited<ChatMessage["subject"]>;
  try {
    subject = await message.subject;
  } catch (error) {
    logger.warn("linearbot_context_subject_failed", {
      error: errorMessage(error),
    });
    return undefined;
  }
  if (!subject) return undefined;
  const header = [subject.id, subject.title].filter(Boolean).join(": ");
  const facts = [
    subject.status ? `Status: ${subject.status}` : undefined,
    subject.assignee?.name ? `Assignee: ${subject.assignee.name}` : undefined,
    subject.labels?.length ? `Labels: ${subject.labels.join(", ")}` : undefined,
    subject.url ? `URL: ${subject.url}` : undefined,
  ].filter(Boolean);
  const description = stringValue(subject.description);
  const sections = [
    `[Linear issue context]`,
    header,
    facts.join("\n"),
    description ? `Description:\n${description}` : undefined,
  ].filter(Boolean);
  if (sections.length <= 1) return undefined;
  return sections.join("\n\n");
}

function truncateContext(text: string): string {
  if (text.length <= CONTEXT_MAX_CHARS) return text;
  let omitted = text.length - CONTEXT_MAX_CHARS;
  while (true) {
    const suffix = `\n[truncated ${omitted} chars from Linear issue context]`;
    const keep = Math.max(0, CONTEXT_MAX_CHARS - suffix.length);
    const actualOmitted = text.length - keep;
    if (actualOmitted === omitted)
      return `${text.slice(0, keep).trimEnd()}${suffix}`;
    omitted = actualOmitted;
  }
}
