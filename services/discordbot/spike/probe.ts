/**
 * Phase 0 throwaway spike — run this BEFORE trusting the discordbot build.
 *
 * It validates the three approach-killers the static build cannot prove:
 *   1. Bun × discord.js   — does the Gateway WS + zlib even run under Bun?
 *   2. Direct dispatch     — does a Gateway MESSAGE_CREATE reach `chat.onNewMention`?
 *   3. Native threading    — does the adapter create/route a thread for a channel mention?
 * Plus opportunistic probes of `thread.allMessages` and `author.isMe`.
 *
 * Usage:
 *   DISCORD_BOT_TOKEN=... DISCORD_PUBLIC_KEY=... DISCORD_APPLICATION_ID=... \
 *     bun run services/discordbot/spike/probe.ts
 *
 * Then, in a server where the bot is installed (Message Content Intent enabled):
 *   - @mention the bot in a normal channel   → expect a NEW thread to be created + a reply in it
 *   - @mention the bot inside an existing thread → expect a reply in that same thread
 * Watch the JSON logs below. Ctrl-C to stop (runs ~5 minutes otherwise).
 */
import { createDiscordAdapter } from "@chat-adapter/discord";
import { createMemoryState } from "@chat-adapter/state-memory";
import { Chat } from "chat";

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required to run the spike`);
  return value;
};

const log = (event: string, data: Record<string, unknown> = {}): void =>
  console.log(JSON.stringify({ event, ...data }));

const parseThreadKey = (key: string) => {
  const [, guildId, channelId, threadId] = key.split(":");
  return { guildId, channelId, threadId };
};

const discord = createDiscordAdapter({
  applicationId: required("DISCORD_APPLICATION_ID"),
  botToken: required("DISCORD_BOT_TOKEN"),
  publicKey: required("DISCORD_PUBLIC_KEY"),
  userName: "centaur-spike",
});

const chat = new Chat({
  userName: "centaur-spike",
  adapters: { discord },
  state: createMemoryState(),
});

chat.onNewMention(async (thread, message) => {
  const parts = parseThreadKey(thread.id);
  log("SPIKE_on_new_mention", {
    thread_id: thread.id,
    guild_id: parts.guildId,
    channel_id: parts.channelId,
    // A present threadId proves the adapter created/routed a thread (success criterion #2/#3).
    discord_thread_id: parts.threadId ?? null,
    created_or_used_thread: Boolean(parts.threadId),
    author_is_me: message.author.isMe,
    author_is_bot: message.author.isBot,
    text: message.text,
  });

  // Probe allMessages (used by collectInitialContext) — note how many it returns.
  let history = 0;
  try {
    for await (const _ of thread.allMessages) history += 1;
  } catch (error) {
    log("SPIKE_allMessages_error", { error: String(error) });
  }
  log("SPIKE_allMessages_count", { count: history });

  await thread.subscribe();
  await thread.post(
    "✅ spike: received your mention and replied in this thread.",
  );
  log("SPIKE_reply_posted", { thread_id: thread.id });
});

chat.onSubscribedMessage(async (thread, message) => {
  log("SPIKE_on_subscribed_message", {
    thread_id: thread.id,
    is_mention: message.isMention,
    author_is_me: message.author.isMe,
    text: message.text,
  });
});

await chat.initialize();
log("SPIKE_initialized", {
  note: "Gateway listener starting (direct mode, ~5 min)…",
});

const abort = new AbortController();
process.on("SIGINT", () => abort.abort());

await discord.startGatewayListener(
  {
    waitUntil: (promise) =>
      void promise.catch((error) =>
        log("SPIKE_waituntil_error", { error: String(error) }),
      ),
  },
  5 * 60 * 1000,
  abort.signal,
);

// Keep the process alive until the listener window ends or Ctrl-C.
await new Promise<void>((resolve) => {
  abort.signal.addEventListener("abort", () => resolve(), { once: true });
  setTimeout(resolve, 5 * 60 * 1000 + 5000);
});
log("SPIKE_done", { note: "Listener window ended." });
