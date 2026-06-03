import type { Logger } from "chat";
import { parseDiscordThreadKey } from "./discord-allowlist";
import type { DiscordbotOptions } from "./types";

const DISCORD_THREAD_NAME_LIMIT = 100;
const DEFAULT_DISCORD_API_URL = "https://discord.com/api/v10";

/**
 * Derive a Discord thread name from the triggering message text. The `@chat-adapter/discord`
 * adapter auto-creates a thread on a channel mention but names it generically
 * (`Thread <timestamp>`); this reproduces the Slack "assistant title" feel by naming the thread
 * after what the user actually asked.
 */
export function deriveThreadName(text: string, userName = "centaur"): string {
  const mentionless = text
    .replace(/<@!?\d+>/g, "") // user mentions <@123> / <@!123>
    .replace(/<@&\d+>/g, "") // role mentions <@&123>
    .replace(
      new RegExp(`^\\s*@?${escapeRegExp(userName)}\\b[:,]?\\s*`, "i"),
      "",
    )
    .trim();
  return clipOneLine(mentionless || "Centaur task", DISCORD_THREAD_NAME_LIMIT);
}

/**
 * Best-effort rename of the thread the session lives in. No-ops when the key carries no thread
 * segment (i.e. the message was not threaded). Failures are swallowed — naming is cosmetic and
 * must never block streaming.
 */
export async function renameThreadFromMessage(
  options: DiscordbotOptions,
  threadKey: string,
  name: string,
  logger: Logger,
): Promise<void> {
  const { threadId } = parseDiscordThreadKey(threadKey);
  if (!threadId) return;

  const fetchFn = options.fetch ?? fetch;
  const apiBase = (options.discordApiUrl ?? DEFAULT_DISCORD_API_URL).replace(
    /\/$/,
    "",
  );
  try {
    const response = await fetchFn(`${apiBase}/channels/${threadId}`, {
      method: "PATCH",
      headers: {
        authorization: `Bot ${options.botToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name }),
    });
    if (!response.ok) {
      logger.warn("discordbot_thread_rename_failed", {
        status: response.status,
        thread_id: threadId,
      });
    }
  } catch (error) {
    logger.warn("discordbot_thread_rename_error", {
      error: error instanceof Error ? error.message : String(error),
      thread_id: threadId,
    });
  }
}

function clipOneLine(value: string, max: number): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
