# discordbot

Discord chat ingress for the Centaur agent. Mirrors `slackbotv2` (streamed, session-backed
replies to `@`-mentions) using Vercel's Chat SDK Discord adapter. Shares the platform-agnostic
session logic with Slack via `@centaur/chat-session-bridge`; the Rust `api-rs` control plane is
unchanged (`discord:…` thread keys flow through identically).

## Behavior

- **`@`-mention in a channel** → the adapter creates a **public thread from that message**, the
  bot streams the answer inside it, and the thread is renamed to the message text. The session is
  keyed by the new thread (`discord:{guild}:{channel}:{threadId}`).
- **`@`-mention inside an existing thread** → the bot answers in that thread.
- **Follow-ups inside an active thread** append to the same session without a re-mention.

## Ingress model

Discord delivers normal messages over a **Gateway WebSocket** (outbound), not HTTP webhooks. The
bot opens a single long-lived Gateway connection in "direct mode" (`startGatewayListener` with a
large duration; discord.js maintains the session with native RESUME). There is **no public
ingress** — only a `GET /health` endpoint that reflects the Gateway connection state.

> ⚠️ **Run exactly one replica.** Two pods on the same bot token open two Gateway sessions and
> every message is handled twice. Deploy with `replicas: 1` + `strategy: Recreate`, never autoscale.

> ⚠️ **Do not proxy the Gateway.** discord.js ignores `HTTPS_PROXY` for the WebSocket. Give the pod
> direct `:443` egress to Discord and exclude Discord hosts via `NO_PROXY`.

## Environment

| Var | Required | Notes |
|-----|----------|-------|
| `DISCORD_BOT_TOKEN` | ✅ | Bot token (account-level credential — keep secret). |
| `DISCORD_PUBLIC_KEY` | ✅ | Ed25519 public key (used by the adapter for any HTTP interactions). |
| `DISCORD_APPLICATION_ID` | ✅ | Doubles as the bot user id for mention detection. |
| `DISCORDBOT_GUILD_ALLOWLIST` | ✅ to do anything | Comma/space-separated guild IDs. **Fail-closed: empty ⇒ the bot ignores all messages.** |
| `DISCORDBOT_API_KEY` | – | Bearer to api-rs (falls back to `CENTAUR_API_KEY`). Use a dedicated key, not the Slack one. |
| `CENTAUR_API_URL` | – | api-rs base URL (default `http://127.0.0.1:8080`). |
| `DISCORDBOT_DATABASE_URL` / `DATABASE_URL` / `POSTGRES_URL` | – | Thread-state store. |
| `DISCORD_MENTION_ROLE_IDS` | – | Role mentions that also trigger the bot. |
| `DISCORDBOT_NAME_THREADS` | – | Set `false` to keep the adapter's generic thread names. |
| `DISCORD_API_URL` | – | Override Discord API base. |
| `PORT` | – | Health server port (default 3001). |
| `SESSION_IDLE_TIMEOUT_MS` / `SESSION_MAX_DURATION_MS` | – | Forwarded to api-rs execute. |

DMs are denied unconditionally (DM intents are not requested).

## Discord application setup

1. **Create the application** at <https://discord.com/developers/applications>. Note the
   **Application ID** and **Public Key** (General Information).
2. **Bot** tab → reveal/reset the **token** (`DISCORD_BOT_TOKEN`).
3. **Bot → Privileged Gateway Intents** → enable **Message Content Intent**. Without it,
   non-mention messages arrive with empty content and follow-ups break. (Bots in 100+ servers must
   apply for it; below that it's a toggle.)
4. **Invite the bot** (OAuth2 → URL Generator) with scope `bot` and permissions:
   _View Channels_, _Send Messages_, _Send Messages in Threads_, **Create Public Threads**,
   _Embed Links_, _Read Message History_.
5. Set `DISCORDBOT_GUILD_ALLOWLIST` to the server(s) you invited it to — the bot is **inert** until
   this is set.

## Phase 0 spike (run before deploying)

The build typechecks against the real SDK, but three things can only be confirmed at runtime.
Validate them with the throwaway probe:

```bash
DISCORD_BOT_TOKEN=... DISCORD_PUBLIC_KEY=... DISCORD_APPLICATION_ID=... \
  bun run services/discordbot/spike/probe.ts
```

Then `@`-mention the bot in a channel and in a thread, and check the JSON logs for:

- `SPIKE_initialized` (Bun runs discord.js's Gateway) — **approach-killer #1**.
- `SPIKE_on_new_mention` firing at all — **direct dispatch #2**.
- `created_or_used_thread: true` with a `discord_thread_id` on a channel mention — **threading #3**.
- `SPIKE_allMessages_count` and `author_is_me` — context backfill + self-loop safety.

If any fails, revisit the approach before deploying (see the plan's Phase 0).

## Develop / test

```bash
bun run check:types   # tsgo
bun test test         # allowlist, threading, gateway controller (no Discord needed)
bun run dev           # run the server locally (needs env above)
```

## Known limitations

- The Gateway listener can't expose the precise close code on a fatal end; an unexpected
  disconnect exits the process so Kubernetes restarts it (CrashLoopBackOff surfaces bad
  token/intents). `/health` liveness is "listener still running", not a deep socket probe.
- Thread renaming is best-effort and applies on the first execution; a first mention inside a
  user-created thread will rename that thread (set `DISCORDBOT_NAME_THREADS=false` to disable).
- A Gateway RESUME that replays a channel mention before state commits could, in rare cases, let
  the adapter create a second thread (the dedup guards execution, but thread creation happens
  inside the adapter). See the plan's invariant #2.
