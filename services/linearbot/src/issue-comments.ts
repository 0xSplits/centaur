import { isJsonObject, stringValue } from "./utils";

// Linear delta (no slackbotv2 analog): in agent-sessions mode the adapter
// ignores `Comment` webhooks entirely, so a delegated agent never saw regular
// comments posted on its issue outside the session thread ("actually, hold
// off"). linearbot routes comment-created webhooks for issues with known
// agent-session threads into those threads as append-only context — no
// execution, exactly like a non-mention subscribed message. Comments that are
// part of a session's own thread already arrive as `prompted` events and are
// skipped here.

/** A comment-created webhook, reduced to the fields the forwarder needs. */
export type IssueCommentEvent = {
  authorId: string;
  authorName: string;
  body: string;
  commentId: string;
  createdAt?: string;
  issueId: string;
  parentId?: string;
  url?: string;
};

/**
 * Parses a Linear `Comment`/`create` webhook body into an IssueCommentEvent.
 * Returns null for anything else — including bot/agent-authored comments
 * (those carry a `botActor` instead of a `user`), which keeps the agent's own
 * response comments from echoing back into its session.
 */
export function parseIssueCommentWebhook(
  rawBody: string,
): IssueCommentEvent | null {
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (!isJsonObject(payload)) return null;
  if (payload.type !== "Comment" || payload.action !== "create") return null;
  const data = payload.data;
  if (!isJsonObject(data)) return null;
  const issueId = stringValue(data.issueId);
  const commentId = stringValue(data.id);
  const body = typeof data.body === "string" ? data.body : "";
  const user = isJsonObject(data.user) ? data.user : undefined;
  const authorId = stringValue(user?.id);
  if (!issueId || !commentId || !authorId || !body.trim()) return null;
  return {
    authorId,
    authorName: stringValue(user?.name) ?? "unknown",
    body,
    commentId,
    createdAt: stringValue(data.createdAt),
    issueId,
    parentId: stringValue(data.parentId),
    url: stringValue(payload.url),
  };
}

/** State key holding the agent-session thread ids known for an issue. */
export function issueSessionsKey(issueId: string): string {
  return `linearbot:issue-sessions:${issueId}`;
}

/** An issue assigned to the bot, reduced to what the assignment turn needs. */
export type IssueAssignmentEvent = {
  issueId: string;
  assigneeId: string;
  /** Issue `updatedAt`; dedupes a redelivered webhook for the same change. */
  updatedAt: string;
};

/**
 * Parses an `Issue`/`update` webhook into an IssueAssignmentEvent when the
 * issue's assignee is now `botUserId` (the bot was assigned/delegated the
 * issue). Returns null otherwise. The Centaur-forward model uses this instead
 * of an AgentSessionEvent so assignment turns survive agent sessions being off.
 */
export function parseIssueAssignmentWebhook(
  rawBody: string,
  botUserId: string,
): IssueAssignmentEvent | null {
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (!isJsonObject(payload)) return null;
  if (payload.type !== "Issue" || payload.action !== "update") return null;
  const data = payload.data;
  if (!isJsonObject(data)) return null;
  const issueId = stringValue(data.id);
  const assigneeId = stringValue(data.assigneeId);
  if (!issueId || !assigneeId || assigneeId !== botUserId) return null;
  return {
    issueId,
    assigneeId,
    updatedAt:
      stringValue(data.updatedAt) ?? stringValue(payload.updatedAt) ?? "",
  };
}

/**
 * True when the comment belongs to the session's own comment thread (the
 * root comment itself, or a reply under it) — those arrive as `prompted`
 * AgentSessionEvents and must not be forwarded twice.
 */
export function isSessionThreadComment(
  event: Pick<IssueCommentEvent, "commentId" | "parentId">,
  sessionRootCommentId: string | undefined,
): boolean {
  if (!sessionRootCommentId) return false;
  return (
    event.commentId === sessionRootCommentId ||
    event.parentId === sessionRootCommentId
  );
}
