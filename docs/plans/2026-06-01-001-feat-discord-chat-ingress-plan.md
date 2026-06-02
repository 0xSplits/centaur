---
title: Add Discord chat ingress (discordbot service)
type: feat
status: in-progress
date: 2026-06-01
origin: docs/brainstorms/2026-06-01-discord-chat-ingress-brainstorm.md
ticket: PE-7563
---

# ✨ Add Discord chat ingress (`discordbot` service)

## Implementation Status (2026-06-01)

**Built & verified statically (typecheck + unit tests green):**
- ✅ Phase 1 — `@chat-adapter/discord@4.30.0` added; lockfile updated.
- ✅ Phase 2 — `@centaur/chat-session-bridge` extracted; `slackbotv2` switched onto it (its
  emulation suite still 6/6). `discordbot` service built: `index.ts`, `gateway.ts`,
  `discord-allowlist.ts`, `discord-threading.ts`, `server.ts`, `types.ts`. **Typechecks against the
  real SDK.**
- ✅ Phase 3 (partial) — unit tests for the allowlist (DM-deny, fail-closed), thread naming/rename,
  and the gateway controller (active/shutdown/fatal-end). 21/21 green.
- ✅ Phase 0 scaffolded — `spike/probe.ts` + README setup guide.
- ✅ Discovery win: the adapter **auto-creates threads on mention**, so threading needed no custom
  creation module — only the message-derived rename. Open Q #1 resolved from source (large
  `durationMs` ⇒ one long-lived RESUME-backed connection, no IDENTIFY churn).

**Still pending (need real infrastructure or are follow-ups):**
- ⏳ Phase 0 spike must be **run** with real Discord credentials (Bun×discord.js, direct dispatch,
  threading) — only the user can.
- ⏳ Phase 3 — the full `chat-sdk-emulate` test (final-answer-after-plan, reconnect dedup).
- ⏳ Phase 4 — deployment plumbing (Dockerfile, Justfile, Helm, CI).
- Runtime acceptance criteria below remain unchecked until the spike/integration validate them.

## Enhancement Summary

**Deepened on:** 2026-06-01 · **Research/review agents:** discord.js-proxy researcher,
Discord-ops-resilience researcher, architecture-strategist, code-simplicity-reviewer,
security-sentinel · **+ plan-review round:** DHH, Kieran, simplicity (drove the spike-first
reorder, the security trim, the bridge-extraction decision, and the correctness invariants below).

**Amended 2026-06-01 — native threading:** a channel mention now **creates a public thread** and
answers inside it; an in-thread mention **replies to the specific message**. This revives the Slack
"assistant title" as the Discord **thread name** (`titleFromMessage` is kept, not deleted) and adds a
new `discord-threading.ts` module + a Phase 0 thread-creation capability check. See "Threaded reply
behavior."

### Key improvements (these override the original draft where they conflict)
1. **Proxy resolved → go direct, don't proxy the Gateway.** discord.js's Gateway WS does
   not honor `HTTPS_PROXY`, and `@chat-adapter/discord` exposes no agent/Client passthrough.
   Pattern: direct `:443` egress to Discord hosts + `NO_PROXY` + FQDN-based NetworkPolicy.
2. **Don't hand-roll a reconnect loop.** Re-calling `startGatewayListener` fights discord.js's
   native RESUME and risks exhausting the 1000/24h IDENTIFY budget (→ 24h ban). Prefer one
   long-lived connection; classify fatal Gateway close codes (4004/4014) → exit and let k8s restart.
3. **Security is now first-class.** api-rs has **no ingress auth** (the bot allowlist is the only
   gate), so the Discord allowlist must be **fail-closed** and **deny DMs by default**, with a
   **dedicated `DISCORDBOT_API_KEY`**. New "Security & Authorization" section below.
4. **Deployment hardening:** `replicas: 1` + `strategy: Recreate`, SIGTERM→`client.destroy()`,
   `terminationGracePeriodSeconds: ~35`, PID-1 signal forwarding, single-shard, never autoscale.
5. **Liveness + UX seams:** `/health` must reflect Gateway connection state; the typing indicator
   needs a keepalive loop (auto-expires ~10s).
6. **Simplifications:** drop the optional HTTP webhook route from the MVP; keep `discord-events.ts`
   tiny (but fail-closed); true-delete the Slack status/title code; reorder so the proxy/Gateway
   spike precedes all Helm/CI plumbing.

### New considerations discovered
- The adapter's `startGatewayListener` is **serverless-oriented** (default 180s windows). Running it
  in a long-lived pod needs verification that windowing RESUMEs rather than re-IDENTIFYs (Open Q #1).
- `session-api.ts`/`types.ts` are **forks, not verbatim reuse** (~40 renamed identifiers + 4 string
  constants + a `SLACKBOT_API_KEY` env read). A `@centaur/chat-session-bridge` extraction is the
  lower-drift alternative (see Future Considerations).
- Reconnect dedup has a **pre-commit redelivery window**; the test must assert the pre-commit case.

## Overview

Add a Discord chat ingress for the centaur agent that mirrors the existing
`slackbotv2` Slack ingress as closely as Vercel's Chat SDK allows. Users in an
allowlisted Discord server @-mention the bot (or reply in a thread) and get the
same streamed, session-backed agent responses Slack users get today.

The work is a **clone of `services/slackbotv2/` → `services/discordbot/`** that swaps
the Slack adapter for `@chat-adapter/discord@4.30.0`, replaces the Slack HTTP-webhook
ingress with a **persistent Gateway WebSocket listener**, and reuses the session
bridge, rendering, and the Rust `api-rs` control plane unchanged. All four brainstorm
decisions carry forward (see brainstorm: `docs/brainstorms/2026-06-01-discord-chat-ingress-brainstorm.md`).

## Problem Statement

The agent is reachable from Slack but not Discord. Many teams live in Discord. We
want feature parity with the Slackbot — streamed replies, @-mention to start a
session, thread follow-ups, attachments, concurrency guarding, allowlisting — without
re-architecting the platform-agnostic core that already powers Slack.

## Proposed Solution

Clone `slackbotv2` to a new `discordbot` service. Keep everything platform-agnostic
verbatim (session bridge, SSE parsing, Codex serialization, `@centaur/rendering`,
`@chat-adapter/state-pg`, the `api-rs` endpoints). Swap only the Slack-specific
touchpoints, and add the one genuinely new piece Discord requires: a supervised,
long-lived **Gateway listener loop** (Slack needs no equivalent because it pushes HTTP
webhooks for messages; Discord delivers normal messages only over the Gateway).

### Key architectural decisions (carried from brainstorm + refined by research)

1. **Clone, don't generalize.** New `services/discordbot/`; `slackbotv2` untouched.
   (see brainstorm: decision 1)
2. **Gateway listener for full parity**, with Message Content Intent enabled.
   (see brainstorm: decision 2)
3. **Native Discord threading (refines brainstorm decision 3).** A mention **in a channel**
   creates a **public thread from that message** and streams the answer inside it; a mention
   **inside an existing thread** replies to that specific message. The Slack-only assistant
   *status* still drops (use the typing indicator), but the Slack assistant *title* concept is
   **revived as the Discord thread name** (reusing `titleFromMessage`). Follow-ups inside a
   created thread append to the same session without a re-mention. (see brainstorm: decision 3,
   amended 2026-06-01 — see "Threaded reply behavior" below)
4. **Deployment is in scope** — Dockerfile, Justfile, Helm, CI, Discord app setup.
   `slackbotv2` itself has no deploy wiring yet, so this plumbing is built fresh off
   the deployed **v1 `slackbot`** as the template. (see brainstorm: decision 4)

### Refinement discovered during research (not in brainstorm)

5. **Gateway "direct mode" over a long-lived pod, no public HTTP ingress required.**
   `startGatewayListener` has two modes. In *forwarding mode* (a `webhookUrl` is
   passed) each Gateway event is POSTed back to the HTTP webhook with an
   `x-discord-gateway-token` header — designed for serverless. In *direct/legacy mode*
   (no `webhookUrl`) `client.on(Events.MessageCreate, …)` invokes the chat handlers
   **in-process**. Because `discordbot` runs as a long-lived Bun pod (like the Slack
   bot), **direct mode is simpler and avoids an HTTP round-trip**. The Discord Gateway
   connection is *outbound* (bot → Discord), so unlike Slack **no public ingress is
   needed for message handling**. We keep `/health` and an optional, non-public
   `POST /api/webhooks/discord` route (PING handshake + future slash commands), but the
   MVP does not need to expose it. This is a security/ops simplification vs Slack.

## Technical Approach

### Architecture

```
Discord (Gateway WSS, outbound :443)
   │  MessageCreate / mention / reaction
   ▼
discordbot (Bun pod)
   ├─ single long-lived Gateway client ──► chat.onNewMention / chat.onSubscribedMessage
   │     (discord.js owns reconnect/RESUME; Message Content Intent; msg-id dedup)
   ├─ Hono app: GET /health  (reflects Gateway liveness; NO webhook route in MVP)
   ▼
syncThreadMessageToSession  (reused from the shared session bridge)
   ▼
session-api.ts  ──HTTP──►  api-rs control plane  (UNCHANGED)
   POST /api/session/{discord:guild:channel[:thread]}        (create)
        .../messages (append)  .../execute (run)
   GET  .../events?after_event_id=…  (SSE)
   ▼
codexAppServerToChatSdkStream (@centaur/rendering, UNCHANGED)
   ▼
thread.post(new StreamingPlan(...))  ──► Discord adapter postMessage + editMessage (streamed)
```

The Chat-SDK `thread.id` is the `api-rs` `thread_key`. For Discord it is
`discord:{guildId}:{channelId}` or `discord:{guildId}:{channelId}:{threadId}` (DMs use
`guildId = "@me"`). `api-rs` is platform-agnostic and needs **no changes** — a
`discord:…` key flows through identically.

### Threaded reply behavior (new — `discord-threading.ts`)

The session is **always keyed by a Discord thread**, never a bare channel. On each mention the
resolver decides where the conversation lives, *before* starting the api-rs session:

| Inbound | Action | Session key |
|---|---|---|
| Mention **in a channel** (no parent thread) | **Create a public thread from the mention message** (name = `titleFromMessage`, ≤100 chars); subscribe + stream the answer **inside** the new thread | `discord:{guild}:{channel}:{newThreadId}` |
| Mention **inside an existing thread** | Reply **to the specific mention message** (Discord message reference) within that thread | `discord:{guild}:{channel}:{threadId}` |
| Non-mention follow-up **inside a created/active thread** | Append to the same session (existing `onSubscribedMessage` path) — no re-mention needed | same thread key |

Consequences and pins:
- **Thread name revives the title.** `titleFromMessage` is **not** deleted — it produces the thread
  name. Adjust its mention-strip regex for Discord (`<@123>` / `<@!123>` numeric IDs, not Slack
  `<@U…>`) and clip to **100** (Discord thread-name limit), not 80. Optionally rename the thread once
  on `renderer.title.update`.
- **The thread-creation step is a side effect that must be deduped first.** A RESUME-replayed channel
  mention would otherwise create a *second* thread. The persisted seen-`message.id` check (invariant #2)
  must run **before** `startThread`, and the created `threadId` should be recorded in thread-state so a
  replay routes to the existing thread instead of recreating it.
- **Adapter capability is a Phase 0 spike item.** Does `@chat-adapter/discord` expose thread creation
  + a `Thread` handle for a new thread, and a reply-to-message reference? If not, drop to the **raw
  `discord.js` Client we already hold** (`message.startThread({ name })`; `channel.send({ reply: { messageReference }})`),
  then route the Chat-SDK session to the resolved thread id. Either way the session/streaming code is unchanged.
- **Permissions:** the bot needs **Create Public Threads** + **Send Messages in Threads** (Phase 5).
- **Edge cases to handle:** missing thread-create permission → fall back to an in-channel reply + warn;
  forum/announcement/voice-text channels (thread semantics differ) → out of MVP scope, log + skip.

### What is reused verbatim (do not re-derive)

- `session-api.ts` — api-rs client, SSE parser, Codex input serialization, terminal-event
  detection. Only the metadata strings change (below).
- `utils.ts` — entirely platform-agnostic.
- `@centaur/rendering` (`codexAppServerToChatSdkStream`, `CodexAppServerToChatStreamOptions`,
  `RendererEvent`) and `@centaur/harness-events` (`RustSessionStreamEvent`).
- `@chat-adapter/state-pg` (`createPostgresState`) thread-state store.
- The Chat orchestration shape: `new Chat({ adapters, state, onLockConflict, logger })`,
  `onNewMention`, `onSubscribedMessage`, `thread.subscribe()`, the `activeExecution` /
  `forwardedMessageIds` / `historyForwarded` / `lastEventId` thread-state machine, and the
  `StreamingPlan` render loop (`StreamingPlan` is a core-`chat` construct; on Discord
  `groupTasks`/`endWith` are ignored but post+edit streaming works via `updateIntervalMs`).

### Slack touchpoints to change (exact, from source)

All under `services/discordbot/src/` after cloning. References are the original
`slackbotv2` lines.

| Concern | Slack (current) | Discord (new) |
|---|---|---|
| Adapter import (`index.ts:10`) | `@chat-adapter/slack` `createSlackAdapter` | `@chat-adapter/discord` `createDiscordAdapter` |
| Adapter config (`index.ts:68-75`) | `{ apiUrl, botToken, botUserId, signingSecret, userName, logger }` | `{ apiUrl, applicationId, botToken, publicKey, mentionRoleIds, userName, logger }` — **`signingSecret`→`publicKey`** (Ed25519 hex-64), **`botUserId` dropped** (applicationId is the bot user id) |
| Adapters map (`index.ts:78`) | `adapters: { slack }` | `adapters: { discord }` (key name drives `chat.webhooks.discord`) |
| Assistant *status* (`index.ts:55-63, 254-336`) | `setAssistantStatus` woven into the render loop | **delete the status**; replace with a typing keepalive (M4). Surgery in the hot path, not a guard no-op. |
| Assistant *title* (`titleFromMessage`, `renderer.title.update`) | Slack assistant-pane title | **revived as the Discord thread name** — `titleFromMessage` kept (regex + clip adjusted); optional rename on `title.update` |
| Threading (NEW) | n/a (Slack auto-threads) | new **`discord-threading.ts`** — channel mention → create thread from message; in-thread mention → reply to the message (see "Threaded reply behavior") |
| Webhook ingress route (`index.ts:103-108`) | `POST /api/webhooks/slack` → `chat.webhooks.slack` | **MVP: delete — do not port.** Direct-mode Gateway is the message path; only `GET /health` remains. (Add the route back with slash commands later.) |
| Allowlist guard (`index.ts:85,94,105`) | `isAllowedSlackMessage` / `isAllowedSlackWebhookBody` (`slack-events.ts`) | new **`discord-allowlist.ts`** (renamed — it parses nothing), keyed on `guild_id` + `author.bot`, **fail-closed**, DM-deny |
| Thread-id (`index.ts:338-342`) | `slack:{channel}:{threadTs}`, parsed for assistant status | now the session key is the **resolved/created Discord thread** `discord:{guild}:{channel}:{threadId}`; `discord-threading.ts` owns resolution (no Slack-style parse-for-status) |
| State key prefix (`index.ts:121-125`) | `centaur-slackbotv2` | `centaur-discordbot` |
| Health service name (`index.ts:102`) | `service: 'slackbotv2'` | `service: 'discordbot'` |
| Session metadata (`session-api.ts:163-165, 291-292`) | `source: 'slackbotv2'`, `platform: 'slack'` | `source: 'discordbot'`, `platform: 'discord'` |
| Attachment label (`session-api.ts:354`) | `[Slack attachment: …]` | `[Discord attachment: …]` |
| Env (`server.ts`) | `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_BOT_USER_ID`, `SLACK_API_URL` | `DISCORD_BOT_TOKEN`, `DISCORD_PUBLIC_KEY`, `DISCORD_APPLICATION_ID`, optional `DISCORD_MENTION_ROLE_IDS`, `DISCORD_API_URL` |
| Types (`types.ts`) | `SlackbotV2Options.signingSecret/botUserId/assistantStatus/slackApiUrl/streamTaskDisplayMode` | `publicKey/applicationId` (+ `mentionRoleIds?`), `discordApiUrl`; **drop both `assistantStatus` and `streamTaskDisplayMode`** (Slack-only/no-op on Discord) |
| Trace-event prefix (`index.ts`/`session-api.ts`, ~20 `traceLog` literals) | hardcoded `slackbotv2_*` strings | derive from a single `service` constant so the clone changes **one** string, not 20 (avoids a stray `slackbotv2`-labeled Discord log line) |
| Package name + dep (`package.json`) | `slackbotv2`, `@chat-adapter/slack` | `discordbot`, `@chat-adapter/discord@^4.30.0` |

### The one genuinely new piece: the Gateway listener (corrected by research)

`@chat-adapter/discord` constructs a `discord.js` v14 `Client` internally (intents
`Guilds, GuildMessages, MessageContent, DirectMessages, GuildMessageReactions,
DirectMessageReactions`) and exposes
`startGatewayListener(options, durationMs?, abortSignal?, webhookUrl?)`. In **direct mode**
(no `webhookUrl`) it wires `client.on(MessageCreate, …)` to the chat handlers in-process.

**Do NOT build a supervised loop that re-calls `startGatewayListener` on every disconnect.**
discord.js already owns the Gateway lifecycle: on a transient drop it reconnects to
`resume_gateway_url` and sends **RESUME (op 6)** — replaying missed events without a new
IDENTIFY. A hand-rolled re-login loop throws away the session/seq, forcing a fresh **IDENTIFY**
each time, and Discord limits IDENTIFY to **1000 per rolling 24h** (RESUME is exempt). A tight
reconnect/crash loop can exhaust that and get the token rate-limited for ~24h (bot goes dark).

Design:
- **One connection for the pod's lifetime.** Pass the largest run window the adapter supports
  (or invoke once and rely on the adapter's own window-renewal) so a single `Client` stays
  logged in. Register handlers once; never re-instantiate the `Client` without `client.destroy()`
  first (re-instantiation leaks sockets/timers and duplicates listeners → double replies).
- **On unrecoverable errors, exit the process and let k8s restart** — k8s is the supervisor, not
  an in-process loop. **Classify Gateway close codes:** `4004` (bad token) / `4014` (disallowed
  intents) are fatal → `process.exit(1)`; transient/network → let discord.js back off and resume.
- **Idempotent handler:** early-return on `message.author.bot`/self, and **dedup by Discord
  message id (snowflake)** so a RESUME replay or restart can't double-execute (see M3 window below).
- **Observability:** log `shardResume` (cheap, good) vs `shardReady`/IDENTIFY (expensive — frequent
  occurrences signal a reconnect problem); log `shardDisconnect` close codes.
- **Single-shard only.** Sharding is forced only at 2500+ guilds; do not add `ShardingManager`.

```ts
// services/discordbot/src/gateway.ts (NEW) — sketch, not final
client.on('messageCreate', (m) => { /* bot/self skip + msg.id dedup handled by chat handlers/state */ })
client.on('shardResume',     (id) => log('gateway-resumed', { id }))
client.on('shardReady',      (id) => log('gateway-identify', { id }))   // watch frequency
client.on('shardDisconnect', (e, id) => { if (FATAL.has(e.code)) process.exit(1) })
// start ONE long-lived listener; do not loop-relogin:
await adapter.startGatewayListener({ waitUntil }, LONG_DURATION_MS, abort.signal)
```

**Tension to verify (Open Q #1):** the adapter's `startGatewayListener` is serverless-oriented
(default `durationMs` 180_000) and renews in windows. Confirm in `4.30.0` that window renewal
RESUMEs (reuses session) rather than re-IDENTIFYs; if it re-IDENTIFYs, either pass a very long
duration or bypass the adapter's listener and drive a single `discord.js` Client directly
(losing some adapter normalization). Resolve before relying on it for a long-lived pod.

**Liveness (M1):** maintain a last-successful-Gateway-event timestamp (or read `client.ws.status`)
and surface it from `/health` (or a `/ready`) so a wedged/disconnected Gateway is observable and
self-heals via the k8s probe — `{ ok: true }` unconditionally would hide a dead socket.

## Alternative Approaches Considered

- **Generalize `slackbotv2` to register both adapters on one `Chat`** — rejected in the
  brainstorm to keep the deployed Slack path at zero risk and ship faster. Revisit if a
  third platform appears. (see brainstorm: decision 1)
- **HTTP Interactions only (slash commands, no Gateway)** — rejected: no @-mention chat or
  thread follow-ups, a large parity gap. (see brainstorm: decision 2)
- **Gateway forwarding mode (POST back to webhook)** — viable but adds an HTTP round-trip
  and requires exposing the webhook; unnecessary for a long-lived pod. Use direct mode.
- **Emulate Slack status with placeholder "🤔 Thinking…" messages** — rejected in
  brainstorm for message clutter; use the native typing indicator. (see brainstorm: decision 3)

## System-Wide Impact

### Interaction graph

`Gateway MessageCreate` → adapter normalizes to `Message`/`Thread` → `chat.onNewMention`
(or `onSubscribedMessage`) → `discord-events` allowlist guard → `thread.subscribe()` →
`syncThreadMessageToSession` (persists thread state in Postgres, dedups by
`forwardedMessageIds`, guards on `activeExecution`) → `session-api` create/append/execute
against api-rs → SSE event stream → `codexAppServerToChatSdkStream` → `thread.post(StreamingPlan)`
→ adapter `postMessage` + repeated `editMessage` back to Discord. `api-rs` persists durable
messages/executions and emits replayable `SessionEvent`s (Postgres NOTIFY/LISTEN wakeups,
unchanged from `ea6a272a`).

### Error & failure propagation

- **Gateway disconnects** (network, Discord restart, token issues) — must not crash the pod;
  the supervised loop reconnects with backoff. This is the highest-churn new failure mode and
  has no Slack analog.
- **Ed25519 verification** (only on the optional HTTP route) — handled inside the adapter;
  bad signature → 401. The signed PING must succeed or Discord won't accept the Interactions URL.
- **api-rs / SSE errors** — reuse the existing `sessionStreamError` / `startingStreamNotification`
  handling unchanged; behavior identical to Slack.
- **Final-answer-after-plan** — see gotcha #2 below; verify the adapter's native streaming
  flushes the final committable answer after a `StreamingPlan` completes.

### State lifecycle risks

- Thread state is keyed by `discord:…` thread id in the same Postgres store (distinct
  `keyPrefix: centaur-discordbot`, so no collision with Slack). The `activeExecution` guard
  prevents double-execution; `forwardedMessageIds` dedups. A Gateway **reconnect that replays a
  message** could re-deliver a `MessageCreate`; dedup by Discord message id must hold across
  reconnects (validate in the emulation test).

### API surface parity

`api-rs` session endpoints are shared and unchanged. `@centaur/rendering` is shared, so any
rendering fix (e.g. binary-output sanitization from `826aefe4`) applies to Discord for free.
No other interface exposes equivalent functionality.

### Integration test scenarios

1. @-mention in a guild channel → session created with `discord:{guild}:{channel}` key →
   streamed reply edits in place.
2. Thread follow-up (non-mention) while a stream is active → appended, not re-executed; deduped.
3. Plan precedes final answer → final answer survives after `StreamingPlan` (guards `826aefe4`).
4. Gateway reconnect mid-conversation → no duplicate session execution, no lost messages.
5. Message from a non-allowlisted guild or a bot author → ignored.
6. Attachment/image → serialized into Codex input as `[Discord attachment: …]`.

## Security & Authorization

**Governing fact:** the api-rs session routes have **no ingress authentication** — the bearer the
bot attaches is never validated by api-rs (`routes.rs:34-42`). The trust boundary is the
NetworkPolicy **plus the bot's own allowlist**, so the Discord allowlist is the *primary*
authorization control. Slack's allowlist is fail-*open*; cloning that posture is unsafe because an
invite link can place the bot in arbitrary servers. **Two controls are the whole MVP security
story** — both cheap, both live in the allowlist guard:

- **🔴 C1 — Deny DMs.** Don't request DM intents, and have the allowlist reject `guildId === "@me"`
  /absent. One line; no `DISCORDBOT_DM_ALLOWLIST` subsystem (deferred). A DM has `guildId="@me"` and
  reaches the tool-capable agent identically to a guild channel, so this closes a real hole cheaply.
- **🔴 C2 — Fail-CLOSED guild allowlist.** Empty/unset `DISCORDBOT_GUILD_ALLOWLIST` ⇒ **ignore all
  messages** + loud startup warning. Do not mirror Slack's allow-by-default. Guild-level is
  sufficient for MVP (you control which servers the bot joins).

Two more that are cheap and worth doing now (config/assertion only, not new subsystems):

- **🟠 H1 — Dedicated `DISCORDBOT_API_KEY`.** Don't reuse `SLACKBOT_API_KEY` (`session-api.ts:259`
  reads it directly — a metadata-only clone silently shares the key). One env var.
- **🟠 H3 — Direct mode only; never log secrets.** Assert `webhookUrl` unset (forwarding mode sends
  the **bot token** as `x-discord-gateway-token` per event); scrub token from logs; confirm
  `ensureApiOk` (`session-api.ts:214-224`) can't reflect secrets into errors.

### Hardening backlog — out of MVP scope (applies to Slack too, not parity-blocking)
These hold the clone to a bar the production Slack bot doesn't meet; track as platform-wide tickets,
not Discord-ingress gates: **api-rs ingress bearer auth** (H4 — the real fix, but touches the Rust
control plane + Slack equally); **per-user/per-guild rate + concurrency limits** (no equivalent in
slackbotv2 today); **attachment size/MIME caps / SSRF-via-image-URL** (`serializeAttachment` is
reused *verbatim* from Slack — a shared-code concern); **`raw`-field minimization before Postgres
persistence** (shared serialization — do for both bots or neither); **channel-level (`guild:channel`)
allowlist granularity** (future need for large/public guilds).

## Correctness invariants to pin BEFORE coding (from review)

These are assumptions the clone leans on that the cloned source does **not** obviously provide.
Resolve each as a design decision (most are cheap Phase-1 probe checks), not as a test-time surprise.

1. **Direct-mode dispatch (the load-bearing assumption).** Verify the Discord adapter's Gateway
   `MessageCreate` actually dispatches through `Chat` into `onNewMention`/`onSubscribedMessage` with a
   normalized `Message`/`Thread` — today only `chat.webhooks.slack(req)` drives those handlers. If
   direct mode does *not* route through `Chat`, the "reuse the orchestration verbatim" premise breaks.
   **Make "an @-mention reaches `onNewMention` + triggers `thread.subscribe()`" the #1 spike success
   criterion** (above the soak test).
2. **Reconnect dedup is NOT free.** `syncThreadMessageToSession` (`index.ts:143-158`) only treats a
   message as duplicate when `messageIds.has(id) && historyForwarded` — so a RESUME-replayed **first
   mention** (before history commit) re-executes. Add an explicit **persisted seen-`message.id` check
   at the `gateway.ts` boundary, before `chat.onNewMention`**, rather than relying on the existing
   guard. Design it in; don't defer to the test.
3. **`onLockConflict: 'force'` semantics flip.** In Slack each webhook is a fresh short-lived
   invocation, so "force" steals a *dead* invocation's lock. In one long-lived pod the contenders are
   concurrent async tasks in the same process — "force" can steal the lock from a *still-running*
   handler. Re-decide deliberately; the dedup test should fire two same-thread events **concurrently**.
4. **No in-flight registry exists for graceful drain.** `waitUntil` (`index.ts:363-369`) pulls
   `c.executionCtx.waitUntil` off the Hono request — there is no request context off the Gateway path.
   Define `waitUntil` in direct mode as "push the promise into a drain set"; SIGTERM drains that set
   → `client.destroy()` → close Postgres pool → exit. This is the same gap as shutdown ordering (M-1/M-2).
5. **Adapter `Thread.allMessages` may be empty on Discord.** `collectInitialContext`
   (`session-api.ts:18-39`) backfills history via `thread.allMessages` (Slack `conversations.replies`).
   If unimplemented for Discord Gateway, the bot silently loses pre-mention context. Probe in Phase 0.
6. **`author.isMe`/`isBot` must be populated in direct mode** or the bot replies to itself → infinite
   loop (`serializeMessage` reads `isMe`, `session-api.ts:52`). Cheap Phase-1 check; catastrophic if wrong.
7. **Typing keepalive needs error containment.** The `~8s` re-fire loop must swallow `startTyping`
   errors (rate limit/network) — the deleted `ignoreAssistantError` wrapper existed for exactly this —
   and clear its interval in `finally`, or a wedged stream leaks a typing loop / crashes Bun on an
   unhandled rejection.

## Implementation Phases

### Phase 0 — Throwaway spike (de-risk the two approach-killers FIRST)
Before cloning six files, prove the premises a single probe file can answer. Reorders the old
spike ahead of the build it was meant to de-risk.
- **Bun × discord.js:** does discord.js's Gateway WS + zlib run under Bun at all? A Node-only failure
  invalidates the long-lived-pod premise (would force a Node runtime or a different design).
- **Direct-mode dispatch + connection hold:** confirm invariant #1 (mention → `onNewMention`) and that
  a `wss://gateway.discord.gg` connection holds >10 min and RESUMEs after a forced disconnect, through
  **direct `:443` egress** (not the proxy — see Phase 4 egress notes).
- Probe invariants #5 (`allMessages`) and #6 (`isMe`/`isBot`) opportunistically here.
- **Threading capability:** can the adapter create a thread from a channel message + hand back a
  `Thread` to stream into, and post a reply referencing a specific message? If not, confirm the raw
  `discord.js` fallback (`message.startThread`, `channel.send({ reply })`) works and that the Chat-SDK
  session can target the resolved thread id. This gates the threaded-reply behavior.
- Success: all answered. If Bun, direct-dispatch, or threading fails, revisit the approach before plumbing.

### Phase 1 — Unblock dependency
- Add `@chat-adapter/discord@^4.30.0` to the workspace and **regenerate the lockfile**
  (`pnpm-lock.yaml` currently lacks it; only `@chat-adapter/slack` is present). It pulls in
  `discord.js@^14.25.1`, `discord-api-types`, `discord-interactions` — this **more than doubles** the
  service's dependency surface vs the pure-HTTP Slack path (new WebSocket client + zlib; the source of
  the Bun risk above).
- Success: `pnpm install --filter discordbot` resolves; lockfile committed.

### Phase 2 — Extract the shared session bridge, then clone the Discord-specific glue
**Decided (2026-06-01): extract the bridge.** Before cloning, extract the genuinely
platform-agnostic core into `@centaur/chat-session-bridge` — `session-api.ts` (SSE parser, Codex
serialization, terminal-event detection), `utils.ts`, and the shared `ThreadState`/`ForwardSessionInput`
types — parameterized on the 4 platform constants (`source`, `platform`, attachment-label, api-key env).
Runtime stays fully isolated (each bot owns its `Chat`, process, Postgres keyprefix); only the
drift-dangerous logic is shared, the same win `@centaur/rendering` already gives. **`slackbotv2`
switches to the package in the same change** (it's not yet deployed — v1 `slackbot` is — so this is
low-risk). Verify Slack still passes its existing emulation test after the switch.

Then clone only the Slack-specific glue:
- `services/discordbot/src/index.ts` — swap adapter, `adapters: { discord }`; **rewrite the render
  loop**: delete the assistant-*status* call sites in `renderExecutionStream` and replace with a typing
  keepalive (re-fire ~8s while `activeExecution`, **errors swallowed**, interval cleared in `finally` —
  invariant #7); **keep `titleFromMessage`** (now feeds the thread name — adjust regex for Discord
  numeric mentions, clip to 100); key prefix `centaur-discordbot`; health name; re-examine
  `onLockConflict` (invariant #3).
- `services/discordbot/src/discord-threading.ts` — **new**. Resolve the target thread: channel mention
  → `startThread` from the message (name = `titleFromMessage`); in-thread mention → reply to the
  message. Record the created `threadId` in thread-state; key the session by the resolved thread. Owns
  the permission-missing fallback (in-channel reply + warn).
- `services/discordbot/src/gateway.ts` — **new** single long-lived Gateway client (NOT a re-login
  loop), fatal-close-code classification (4004/4014 → `process.exit(1)`), **persisted seen-`message.id`
  dedup before `chat.onNewMention`** — and crucially **before `startThread`** so a replay can't create a
  second thread (invariant #2); a liveness timestamp feeding `/health`.
- `services/discordbot/src/discord-allowlist.ts` — **new**, ~15-30 lines, **fail-closed**: skip
  `author.bot`/self; **deny DMs (`guild_id==='@me'`)**; require `DISCORDBOT_GUILD_ALLOWLIST` (empty ⇒
  inert + loud warning). Do **not** port Slack's external-org/trigger-bot grammar (no Discord analog).
- `services/discordbot/src/server.ts` — Discord env; start `Bun.serve` + the Gateway client; define
  `waitUntil` as "push promise into the drain set" (invariant #4); SIGTERM/SIGINT → drain set →
  `client.destroy()` → close Postgres pool → exit. Drop speculative Slack env knobs.
- `services/discordbot/src/types.ts` — option types; `publicKey`/`applicationId`/`mentionRoleIds`;
  drop `assistantStatus` **and** `streamTaskDisplayMode`. (If the bridge is extracted, shared types move there.)
- `services/discordbot/package.json`, `tsconfig.json`, plus `pnpm-workspace.yaml` entry — name + dep swap.
- **MVP:** ship only `GET /health` (Gateway-liveness-aware); **no webhook route**.
- **Do NOT reintroduce** the deleted Slack streaming shim (`patchSlackAdapterStreaming`, `da859a2f`).
- Success: `pnpm typecheck` passes; bot answers an @-mention end-to-end against a test Discord app.

### Phase 3 — Tests
- `services/discordbot/test/chat-sdk-emulate.test.ts` — clone the slackbotv2 emulation test,
  driving Discord-shaped events (`emulate` `service: 'discord'` if supported; else direct
  handler invocation), reuse the platform-agnostic `MockSessionApi` half. Cover: **final-answer-after-plan**;
  **reconnect dedup** firing two same-thread events *concurrently* and asserting the **pre-commit**
  redelivery case (the existing `forwardedMessageIds` guard fails this until invariant #2 is
  implemented — write the test to the *corrected* behavior); **authz** (non-allowlisted guild, bot
  author, and a DM `guildId='@me'` ignored).
- **`discord-threading.ts` tests:** channel mention → `startThread` called once with the derived
  name + session keyed by the new thread; in-thread mention → reply-to-message, no new thread;
  replayed channel mention → **no second thread**; missing-permission → in-channel fallback.
- **`gateway.ts` unit tests (the emulation harness structurally cannot reach the Gateway):**
  close-code classifier (4004/4014 → exit signal; transient → resume — getting this wrong is a
  crash-loop → IDENTIFY ban), and `/health` returning non-200 on a stale liveness timestamp.
- Success: tests green in CI.

### Phase 4 — Deployment plumbing (built fresh off v1 `slackbot`)
- `services/discordbot/Dockerfile` — base on `services/slackbot/Dockerfile`, but: entrypoint
  `bun src/server.ts` (not `src/index.ts`); **also `COPY packages/ packages/`** before the
  filtered install (v2/discordbot depends on `@centaur/rendering` + `@centaur/harness-events`
  workspace packages that v1's Dockerfile doesn't copy); `--filter discordbot`.
- `Justfile` — add `_build-discordbot`; register in the `build` fan-out (line ~22),
  `_build-all-sequential` (~36), `build-one` case (~45), k3s import list (~68), and the
  `deploy` ghcr override (~87).
- Helm `contrib/chart/` — duplicate the slackbot blocks as `discordbot`:
  `values.yaml` (~184), `values.dev.yaml` (~15), `values.schema.json` (~163),
  `templates/workloads.yaml` (Deployment ~455-550; env → `DISCORD_BOT_TOKEN`/`DISCORD_PUBLIC_KEY`/
  `DISCORD_APPLICATION_ID`/`DISCORDBOT_API_KEY`/`DATABASE_URL`/`CENTAUR_API_URL`; `/health` probes
  that reflect Gateway liveness), `templates/services.yaml`,
  `templates/networkpolicy.yaml` (dedicated policy ~154-213 — **direct `:443` egress for the
  Gateway WSS, FQDN-based** (Cilium `toFQDNs`/SNI ACL — Discord publishes no IP ranges); ingress
  stays empty).
  - **Egress config (do NOT proxy the Gateway):** discord.js ignores `HTTPS_PROXY` and the adapter
    exposes no agent hook, so set `NO_PROXY=discord.com,.discord.com,.discordapp.com,.discordapp.net,gateway.discord.gg,.discord.gg,.discord.media`
    so REST+Gateway take the same direct, un-intercepted path; keep `NODE_EXTRA_CA_CERTS` for other
    HTTPS. (If REST must traverse the proxy, `undici.setGlobalDispatcher` covers REST only.)
  - **Deployment-architecture invariants (must be explicit in values/manifest):**
    **`replicas: 1`** and **`strategy.type: Recreate`** — two pods (or a RollingUpdate overlap) on
    the same token open two Gateway sessions → every message handled twice. `Recreate` tears the
    old pod down before the new one logs in. **Never autoscale** (no HPA); horizontal scaling would
    require a real distributed execution lock in api-rs (out of scope — name it so nobody scales it).
  - **Graceful shutdown:** `terminationGracePeriodSeconds: ~35`; run as **PID 1 with signal
    forwarding** (`tini` or `exec`) so SIGTERM reaches Node/Bun and `client.destroy()` closes the
    session cleanly (protects the IDENTIFY budget; lets the next pod RESUME).
  - **Public ingress is NOT required for the MVP** (Gateway is outbound). Omit the `ingress.yaml`
    Discord block unless/until slash commands need a public Interactions endpoint.
- Secrets — `contrib/scripts/bootstrap-k8s-secrets.sh`: add `DISCORD_BOT_TOKEN`,
  `DISCORD_PUBLIC_KEY`, `DISCORD_APPLICATION_ID`, and a **dedicated `DISCORDBOT_API_KEY`** (do not
  reuse `SLACKBOT_API_KEY` — H1) to `centaur-infra-env`. Segregate high-sensitivity (bot token, api
  key) from low-sensitivity (application id, public key); document rotation; never echo.
- CI — `.github/workflows/publish-images.yml`: add matrix entry
  `{ service: discordbot, image: centaur-discordbot, dockerfile: services/discordbot/Dockerfile, target: "" }`.
  `paths:` already covers `services/**` + `packages/**`. Check `ci.yml` for typecheck/test wiring.
- Success: image builds + pushes; chart renders; pod runs and stays connected.

### Phase 5 — Discord app setup (operational, document in README)
- Register the Discord application; capture Application ID + Public Key + Bot Token.
- **Enable the Message Content privileged intent** (Bot → Privileged Gateway Intents). Without it,
  non-mention messages arrive with empty `content`, breaking subscribed-message handling. (100+
  guild bots require Discord verification.)
- Invite the bot with `bot` (+ `applications.commands` only if slash commands are added) scope and
  permissions: read/send messages, embed, typing, **Create Public Threads**, **Send Messages in
  Threads**. Restrict who can DM the bot at the app level where possible.
- Set `DISCORDBOT_GUILD_ALLOWLIST` to the intended guild(s) (bot is **inert** until set). DMs are
  denied unconditionally (DM intents not requested) — no config needed.
- Optionally create a mention role and set `DISCORD_MENTION_ROLE_IDS`.
- Success: bot online in a test server, answers an @-mention with a streamed reply; a DM from a
  random user is ignored.

## Acceptance Criteria

### Functional
- [ ] @-mention **in a channel** creates a public thread (named from the message) and streams the
      answer **inside** that thread; the session is keyed by the created thread.
- [ ] @-mention **inside an existing thread** streams the answer in that thread as a **reply to the
      mention message**.
- [ ] Follow-ups inside a created/active thread append to the same session without a re-mention; dupes deduped.
- [ ] A RESUME-replayed channel mention does **not** create a second thread (dedup before `startThread`).
- [ ] Replies stream via live message edits (post + edit), respecting Discord's 2000-char limit.
- [ ] Attachments/images are serialized into Codex input (`[Discord attachment: …]`).
- [ ] Typing indicator persists for the duration of a run (keepalive loop, M4) — manual smoke.
- [ ] Thread keys are `discord:{guildId}:{channelId}:{threadId}` and reach api-rs unchanged.
- [ ] Missing Create-Threads permission falls back to an in-channel reply + warning (no crash).

### Security (must-do)
- [ ] Allowlist is **fail-closed**: empty `DISCORDBOT_GUILD_ALLOWLIST` ⇒ bot inert + loud warning.
- [ ] **DMs (`guildId='@me'`) denied**; bot-authored/self messages ignored.
- [ ] Dedicated `DISCORDBOT_API_KEY` (Slack key not reused); secrets never logged.
- [ ] Forwarding mode disabled (`webhookUrl` unset) — bot token never sent as a header.

### Non-functional
- [ ] discord.js owns reconnect/RESUME; **no hand-rolled re-login loop**; fatal close codes
      (4004/4014) exit the process (k8s restarts).
- [ ] `/health` reflects Gateway connection liveness (not an unconditional `ok`).
- [ ] `replicas: 1` + `strategy: Recreate`; never autoscaled; SIGTERM → `client.destroy()`.
- [ ] No public HTTP ingress is exposed for the MVP (Gateway is outbound); no webhook route shipped.
- [ ] Slack path (`slackbotv2`) is byte-for-byte untouched.
- [ ] Postgres thread state uses `keyPrefix: centaur-discordbot` (no collision with Slack).

### Quality gates
- [ ] `pnpm typecheck`, `pnpm eslint`, `pnpm prettier` pass for `discordbot`.
- [ ] Emulation test covers the integration scenarios, incl. final-answer-after-plan, **pre-commit**
      reconnect dedup, and DM-denial authz.
- [ ] The deleted Slack streaming shim is **not** reintroduced.
- [ ] `@chat-adapter/discord` is in the committed lockfile.

## Success Metrics

- Time-to-first-token and streamed-reply behavior on Discord comparable to Slack.
- Zero crashes from Gateway disconnects over a multi-day soak.
- No duplicate executions across reconnects.

## Dependencies & Prerequisites

- `@chat-adapter/discord@^4.30.0` added to the lockfile (Phase 1 blocker).
- A registered Discord application with Bot Token, Public Key, Application ID, and the
  **Message Content privileged intent** enabled.
- Reachable api-rs control plane + Postgres (same as Slack).

## Risk Analysis & Mitigation

- **🔴 Authorization (api-rs has no ingress auth).** The bot allowlist is the sole gate to a
  tool-capable agent. *Mitigation:* fail-closed allowlist + DM-deny (Security section, C1/C2);
  dedicated key (H1); recommend adding bearer auth to api-rs (H4). **The #1 correctness/safety item.**
- **🔴 Gateway WSS egress (resolved direction).** discord.js does **not** proxy the Gateway and the
  adapter exposes no agent hook. *Mitigation:* **go direct** — `NO_PROXY` for Discord hosts + FQDN
  NetworkPolicy for `:443` (no official IP list); set `NODE_EXTRA_CA_CERTS` for other HTTPS. **Spike
  this in Phase 0 before any Helm/CI work.** A MITM proxy would also break the long-lived `wss`
  handshake, which the direct path sidesteps.
- **🔴 IDENTIFY budget exhaustion.** A re-login loop or crash-loop can burn the 1000/24h IDENTIFY
  limit → 24h token ban. *Mitigation:* single long-lived connection, RESUME (free), fatal-vs-transient
  close-code handling, rare/slow restarts; never re-instantiate the Client without `destroy()`.
- **🟠 Double-processing on rollout/scale.** Two live sessions on one token = duplicate replies.
  *Mitigation:* `replicas: 1` + `strategy: Recreate`; no HPA (deployment invariant).
- **🟠 Adapter window semantics.** `startGatewayListener` is serverless-oriented (180s windows).
  *Mitigation:* verify window renewal RESUMEs vs re-IDENTIFYs (Open Q #1); pass a long duration or
  drive the Client directly if it re-IDENTIFYs.
- **🟠 Message Content Intent gating.** Without it, non-mention messages have empty `content` (no
  error). *Mitigation:* enable in portal; README; startup warning. Consider mention-only MVP to defer
  the privileged intent and shrink data exposure.
- **🟠 Bun × discord.js.** discord.js targets Node (WS/zlib friction under Bun). *Mitigation:*
  validate in the Phase 0 spike — a Bun incompatibility invalidates the long-lived-pod premise.
- **🟡 Reconnect redelivery → duplicate execution.** *Mitigation:* dedup by message id; assert the
  **pre-commit** redelivery window in the test (dedup only guaranteed once state is committed).
- **🟡 `/health` hides a dead Gateway.** *Mitigation:* wire Gateway liveness into the probe (M1).
- **🟡 Typing indicator blinks off (~10s).** *Mitigation:* keepalive loop (M4).
- **🟡 Final answer lost after a plan.** Concern from `826aefe4`. *Mitigation:* explicit test
  (final-answer-after-plan test); rendering-side sanitization is already shared.

## Future Considerations

- Slash commands / buttons (would require exposing the HTTP Interactions endpoint + public ingress).
- Generalizing `slackbotv2` + `discordbot` into a shared platform-parametrized service (rejected for
  MVP — couples the deployed Slack runtime to Discord changes).
- api-rs ingress authentication (H4) — highest-leverage security hardening beyond the bot allowlist.
- Per-user Discord → Splits account mapping (out of scope; Slack doesn't do this either —
  user id/name pass through only as session metadata; api-rs auth is a shared bearer key).

## Documentation Plan

- `services/discordbot/README.md` — env vars (incl. `DISCORDBOT_GUILD_ALLOWLIST` fail-closed
  behavior, DM-deny default, `DISCORDBOT_API_KEY`), Discord app setup, Message Content Intent,
  direct-egress/`NO_PROXY` requirement, `replicas:1`/`Recreate` invariant, run/deploy.
- Note the new service in the workspace overview if a services index exists.

## Out of Scope

- Per-user identity mapping; slash-command surface beyond the PING handshake; merging the two bots.

## Sources & References

### Origin
- **Brainstorm:** [docs/brainstorms/2026-06-01-discord-chat-ingress-brainstorm.md](../brainstorms/2026-06-01-discord-chat-ingress-brainstorm.md)
  — carried-forward decisions: clone to `discordbot`; Gateway listener for full parity;
  graceful-degrade UI → typing indicator; deployment in scope.

### Internal references (source-verified)
- `services/slackbotv2/src/index.ts` — Chat orchestration, handlers, status/title (`55-63, 254-336`), webhook route (`103-108`), thread-id parse (`338-342`).
- `services/slackbotv2/src/session-api.ts` — api-rs bridge + SSE; metadata strings (`163-165, 291-292`), attachment label (`354`).
- `services/slackbotv2/src/server.ts`, `src/slack-events.ts`, `src/types.ts`, `src/utils.ts`.
- `services/slackbot/Dockerfile` — deploy template (note: v1 entry `src/index.ts`, port 3001).
- `Justfile` (~22, 36, 45, 56-57, 68, 87); `pnpm-workspace.yaml`.
- `contrib/chart/templates/{workloads,services,networkpolicy,ingress}.yaml`, `values*.yaml`, `values.schema.json`; `contrib/scripts/bootstrap-k8s-secrets.sh`.
- `.github/workflows/publish-images.yml` (matrix ~40-56, build/push ~95-106).
- `services/api-rs/crates/centaur-api-server/src/routes.rs:38-41` — session endpoints (unchanged).
- `packages/rendering`, `packages/harness-events` — platform-agnostic; exports used: `codexAppServerToChatSdkStream`, `CodexAppServerToChatStreamOptions`, `RendererEvent`, `RustSessionStreamEvent`.

### Git-history gotchas
- `da859a2f` (#360) — Slack streaming shim removed; use upstream Chat SDK streaming. **Do not reintroduce the shim.**
- `826aefe4` (#352) — preserve final answer after plans + binary-output sanitization (rendering, shared → Discord inherits it).
- `fc11a0da` (#346), `ea6a272a` (#345) — slackbotv2 + rendering introduced; api-rs kept caller-neutral; Postgres NOTIFY/LISTEN session wakeups.

### External (Chat SDK `@chat-adapter/discord@4.30.0`, source-verified via `npm pack`)
- `createDiscordAdapter(config?)`: `{ apiUrl?, applicationId, botToken, publicKey, mentionRoleIds?, userName?, logger? }`; env fallbacks `DISCORD_API_URL/APPLICATION_ID/BOT_TOKEN/PUBLIC_KEY/MENTION_ROLE_IDS`; throws if `botToken`/`publicKey`/`applicationId` unresolved; `applicationId` doubles as bot user id.
- `startGatewayListener(options, durationMs=180000, abortSignal?, webhookUrl?)`: direct mode (no `webhookUrl`) wires `MessageCreate` → handlers in-process; intents include privileged `MessageContent`.
- `chat.webhooks.discord(req, { waitUntil })`: Ed25519 verify → PING/PONG handshake / slash defer / forwarded-Gateway routing.
- `startTyping(threadId)` (typing auto-expires ~10s → needs keepalive), `editMessage(threadId, messageId, msg)`; `StreamingPlan` `groupTasks`/`endWith` are Slack-only (ignored on Discord); 2000-char limit.
- Deps pulled in: `discord.js@^14.25.1` (Gateway), `discord-api-types`, `discord-interactions` (Ed25519). The adapter constructs the `Client` with **no `rest`/`ws`/`agent` passthrough** → no per-client proxy hook.

### External (discord.js ops & proxy, researched 2024-2026)
- Gateway WS ignores `HTTPS_PROXY`/undici dispatcher on Node; REST can be proxied via `undici.setGlobalDispatcher`, the Gateway cannot. Discord publishes no official IP allowlist → use FQDN egress. [discord.js#9503], [discordjs.guide/proxy], [discord-api-docs#3220].
- Native RESUME (op 6) vs IDENTIFY; 1000 IDENTIFY/24h (RESUME exempt); don't hand-roll re-login. [Discord Gateway docs], [discord.js#8083].
- K8s singleton: `replicas:1` + `Recreate` to avoid duplicate sessions during rollout; SIGTERM→`client.destroy()`; single-shard <2500 guilds. [A-Line Cloud: HA Discord Bots 2026], [learnkube graceful-shutdown].
- Message Content privileged intent: empty `content` (no error) if disabled; verification only at 100+ guilds. [Discord Message Content FAQ].

## Open Questions (flag for implementation)

Still open (empirical — only the Phase 0 spike can answer):
1. **Direct-mode dispatch + adapter window (the two approach-killers):** does the adapter's Gateway
   `MessageCreate` route through `Chat` to `onNewMention` (invariant #1), and does `startGatewayListener`'s
   180s window RESUME vs re-IDENTIFY? If dispatch doesn't route through `Chat`, or windows re-IDENTIFY,
   the design changes (drive `discord.js` directly, losing some normalization). **Resolve in the
   Phase 0 spike before any build.**
2. **Bun × discord.js:** confirm discord.js's Gateway WS + zlib compression run cleanly under Bun.
   (Phase 0 spike — gating for the whole approach.)
3. **Threading capability:** does `@chat-adapter/discord` expose thread creation from a message + a
   `Thread` to stream into + reply-to-message references? If not, the raw `discord.js` fallback
   (`message.startThread`, `channel.send({ reply })`) routes the session to the resolved thread id.
   (Phase 0 spike — gates the threaded-reply behavior.)

### Resolved (decided 2026-06-01)
- **Bridge extraction → YES.** Extract `@centaur/chat-session-bridge` in Phase 2; `slackbotv2`
  switches to it in the same change. Runtime stays isolated; only the drift-dangerous SSE/Codex
  logic is shared.
- **`onLockConflict: 'force'` → KEEP**, and prove it with a concurrent same-thread dedup test
  (invariants #2/#3). The per-thread `activeExecution` guard already serializes execution; the test
  asserts two concurrent events produce exactly one execution.
- **api-rs ingress auth (H4) → DOCUMENT + DEFER.** The fail-closed allowlist + NetworkPolicy is the
  MVP boundary; api-rs bearer auth is a separate platform-wide ticket, not a Discord-ingress blocker.

### Resolved during deepen (were open in the draft)
- ~~Proxy vs Gateway WSS~~ → **go direct** (`NO_PROXY` + FQDN egress); do not proxy the Gateway.
- ~~`durationMs` vs supervised loop~~ → **single long-lived connection**, no re-login loop; k8s
  restarts on fatal close codes. (Adapter window semantics remain Open Q #1.)
- ~~Allowlist env naming~~ → `DISCORDBOT_GUILD_ALLOWLIST`, **fail-closed**; DMs denied (no DM
  intents); do not port Slack's external-org/trigger-bot grammar.
- ~~Reuse `SLACKBOT_API_KEY`~~ → **no**, dedicated `DISCORDBOT_API_KEY`.
