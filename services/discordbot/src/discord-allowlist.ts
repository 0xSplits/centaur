import type { Logger, Message } from "chat";
import type { DiscordbotOptions } from "./types";

/**
 * Decode a Discord thread key `discord:{guildId}:{channelId}[:{threadId}]` into parts.
 * Returns an empty object if the id is not a Discord thread key.
 */
export function parseDiscordThreadKey(threadKey: string): {
  guildId?: string;
  channelId?: string;
  threadId?: string;
} {
  const parts = threadKey.split(":");
  if (parts[0] !== "discord") return {};
  return { guildId: parts[1], channelId: parts[2], threadId: parts[3] };
}

/**
 * Authorization gate for inbound Discord messages.
 *
 * Unlike the Slack allowlist (which is fail-open), this is intentionally **fail-closed**:
 * the api-rs control plane has no ingress auth, so this guard is the primary authorization
 * boundary. Direct messages are denied outright, and an empty/unset guild allowlist means the
 * bot is inert until configured.
 */
export function isAllowedDiscordMessage(
  message: Message,
  options: DiscordbotOptions,
  logger: Logger,
): boolean {
  if (message.author.isBot === true || message.author.isMe === true) {
    return false;
  }

  const { guildId } = parseDiscordThreadKey(message.threadId);
  if (!guildId || guildId === "@me") {
    logger.warn("discordbot_message_ignored_dm", {
      message_id: message.id,
      thread_id: message.threadId,
    });
    return false;
  }

  const allowlist =
    options.guildAllowlist ??
    splitEnvList(process.env.DISCORDBOT_GUILD_ALLOWLIST);
  if (allowlist.length === 0) {
    logger.warn("discordbot_message_ignored_allowlist_empty", {
      message_id: message.id,
      guild_id: guildId,
    });
    return false;
  }
  if (!new Set(allowlist).has(guildId)) {
    logger.warn("discordbot_message_ignored_guild_not_allowlisted", {
      message_id: message.id,
      guild_id: guildId,
    });
    return false;
  }

  return true;
}

/** True when the bot has no guild allowlist configured and will ignore every message. */
export function isGuildAllowlistEmpty(options: DiscordbotOptions): boolean {
  const allowlist =
    options.guildAllowlist ??
    splitEnvList(process.env.DISCORDBOT_GUILD_ALLOWLIST);
  return allowlist.length === 0;
}

function splitEnvList(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[\s,]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}
