# Brainstorm: Discord Chat Ingress

**Date:** 2026-06-01
**Status:** Ready for planning
**Ticket:** PE-7563

## What We're Building

A Discord chat ingress for the centaur agent that matches the existing `slackbotv2`
Slack ingress as closely as the Chat SDK allows. Users in an allowlisted Discord
server can @-mention the bot (or reply in a thread) and get the same streamed,
session-backed agent responses Slack users get today.

The "Chat SDK" in use is **Vercel's Chat SDK** (`chat` + `@chat-adapter/*`), which
ships a first-class **Discord adapter** (`@chat-adapter/discord@4.30.0`) with the
same `Adapter` interface and `createXAdapter()` factory the Slack path already uses.
The Rust `api-rs` session control plane is fully platform-agnostic — a `discord:...`
thread key flows through unchanged — so **no backend changes are required**.

## Why This Approach

The existing `slackbotv2` already cleanly separates platform-agnostic orchestration
(`onNewMention`, `onSubscribedMessage`, the api-rs session bridge in `session-api.ts`,
and the `@centaur/rendering` stream bridge) from a thin layer of Slack-specific
touchpoints. Discord reuses ~90% of that. We clone rather than generalize to keep the
deployed Slack path at zero risk and ship faster.

## Key Decisions

1. **Structure: clone `slackbotv2` → new `discordbot` service.**
   Keeps the working Slack path untouched. Reuse `session-api.ts`, the rendering
   bridge, the Postgres thread-state store, and the Chat orchestration verbatim.
   Accepted tradeoff: some wiring is duplicated and can drift; revisit a shared core
   later if a third platform appears.

2. **Ingress: persistent Gateway WebSocket listener (full parity).**
   Discord does *not* push HTTP webhooks for normal messages — only slash
   commands/buttons arrive via HTTP Interactions. Real @-mention chat and thread
   follow-ups require the adapter's built-in **Gateway listener** running on a
   long-lived connection, plus the **Message Content Intent** enabled on the Discord
   app. This is the only path to Slack-equivalent behavior. The bot runs as a
   long-lived pod (like the Slack bot), so a persistent connection fits.

3. **UI gaps: graceful degrade + typing indicator.**
   Slack's assistant "status header" and thread "title" have no Discord equivalent.
   Drop them (the code already no-ops unsupported adapters) and use Discord's
   **typing indicator** as the "working" signal. The streamed reply still updates live.
   No fake "🤔 Thinking…" placeholder messages.

4. **Deployment is in scope for the plan (full parity).**
   The eventual plan covers the full ops surface, not just ingress code: Dockerfile,
   Justfile build target, Helm `workloads`/`ingress`/`networkpolicy`/`values`, secrets,
   CI, and Discord app registration. **Note:** `slackbotv2` itself currently has no
   Dockerfile or deploy wiring (only the legacy v1 `slackbot` is deployed), so the
   Discord deploy plumbing is partly greenfield and can serve as the template
   slackbotv2 also lacks.

## Slack-Specific Touchpoints to Replace (the Discord map)

Reuse as-is: Chat orchestration, `session-api.ts`, `@centaur/rendering`, `@chat-adapter/state-pg`, api-rs endpoints.

Replace / add for Discord:
- **Adapter:** `createSlackAdapter(...)` → `createDiscordAdapter({ botToken, publicKey, applicationId, mentionRoleIds })`.
- **Ingress:** Slack Events API HTTP webhook → Gateway listener loop (`startGatewayListener`) forwarding to `chat.webhooks.discord`. Keep an HTTP route for the Discord Interactions endpoint verification ping.
- **Verification:** Slack signing secret → Discord Ed25519 `publicKey` (handled inside adapter).
- **Thread ID shape:** `slack:{channel}:{threadTs}` → `discord:{guildId}:{channelId}:{threadId}`. Generalize the Slack-only parsing in `index.ts`.
- **Status/title:** drop Slack-only `setAssistantStatus`/`setAssistantTitle`; use `startTyping`.
- **Allowlisting:** `slack-events.ts` (`team_id`/`bot_id`) → Discord variant (`guild_id`/`author.bot`).
- **Metadata:** `platform: 'slack'` / `source: 'slackbotv2'` → `discord` / `discordbot`.
- **Env/secrets:** `DISCORD_BOT_TOKEN`, `DISCORD_PUBLIC_KEY`, `DISCORD_APPLICATION_ID`, optional `DISCORD_MENTION_ROLE_IDS`, plus the existing api-rs + Postgres vars.

## Feature Parity Snapshot

| Feature | Slack | Discord (target) |
|---|---|---|
| Streamed responses | ✓ | ✓ |
| @-mention starts session | ✓ | ✓ (Gateway + Message Content Intent) |
| Thread follow-ups append | ✓ | ✓ |
| Live message edit of reply | ✓ | ✓ |
| Attachments/images → Codex | ✓ | ✓ (adapter supports) |
| Concurrency guard | ✓ | ✓ (reused) |
| Org/bot allowlist | ✓ | ✓ (Discord variant) |
| "Working" signal | status header | typing indicator |
| Thread title | ✓ | ✗ (no equivalent) |

## Out of Scope

- Per-user Discord → Splits account mapping (Slack doesn't do this either; user id/name
  pass through only as session metadata, and api-rs auth is a shared bearer key).
- Generalizing slackbotv2 + discordbot into one shared core (possible future refactor).
- Discord slash commands beyond what's needed for the Interactions endpoint handshake.

## Resolved Questions

- **Separate service vs. unified?** → Separate `discordbot` clone.
- **Gateway vs. HTTP-only ingress?** → Gateway listener for full parity.
- **How to handle Slack-only status/title UI?** → Graceful degrade + typing indicator.
- **Deploy in scope?** → Yes, full parity including Dockerfile/Helm/CI/app setup.

## Open Questions

_None — all decisions resolved above._

## Reference Files

- `services/slackbotv2/src/index.ts` — Chat orchestration, handlers, execute/stream loop
- `services/slackbotv2/src/session-api.ts` — api-rs bridge + SSE + Codex serialization (reuse)
- `services/slackbotv2/src/slack-events.ts` — allowlist filters (Discord variant needed)
- `services/slackbotv2/src/server.ts` — Bun entrypoint / env
- `services/api-rs/crates/centaur-api-server/src/routes.rs:38-41` — session endpoints (unchanged)
- `@chat-adapter/discord@4.30.0` `dist/index.d.ts` — `createDiscordAdapter`, `startGatewayListener`

---

_Next: run `/ce:plan` to turn this into an implementation plan._
