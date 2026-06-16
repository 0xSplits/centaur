# linearbot

Linear agent ingress for the Centaur agent. Mirrors `slackbotv2` (session-backed replies)
using Vercel's Chat SDK Linear adapter in **agent-sessions mode**, so the bot is a first-class
Linear agent (https://linear.app/developers/agents): delegate an issue to it or `@`-mention it
and Linear opens an agent session that the bot drives with native thought/action/response
activities. The session logic is a deliberate clone of `services/slackbotv2` kept in sync
manually (there is no shared package); the Rust `api-rs` control plane is unchanged
(`linear:…` thread keys flow through identically).

## Behavior

- **Delegating an issue / `@`-mentioning the agent** → Linear creates an **agent session**; the
  webhook's `created` event starts a centaur session keyed `linear:{issueId}:s:{agentSessionId}`.
  Sessions without a trigger comment (description mentions, bare delegations) and sessions
  created by automation (e.g. a triage rule delegating the issue — no `creator`) work too; both
  required adapter patches, see below.
- **Empty prompts get a synthesized instruction**: a bare delegation has no user-written prompt,
  so the execute message becomes an explicit "work this issue to the best of your ability"
  instruction (plus the delegated-ownership contract: status via the sandbox `linear` tool, the
  `Linear-Status:` marker as backstop, recurring-task continuity hint, no self-delegation).
- **Delegated issues track progress via workflow status** (mentions never move status — the
  agent only owns issues *delegated* to it): kicking off work moves Todo/Backlog/Triage → the
  team's first started state; at the end the agent either moves the issue itself with the
  `linear` tool or ends its answer with `Linear-Status: done|in_progress|todo`, which is
  stripped from the posted response and applied by the bot. Best-effort, like narration.
- **Replies in the session thread** arrive as `prompted` events and execute as follow-up turns on
  the **same** session (the adapter is patched to keep one stable thread key per agent session —
  upstream split every follow-up into a fresh thread).
- **Plain issue comments** (outside the session's comment thread) are forwarded into the issue's
  agent sessions as append-only context — no execution — so a delegated agent sees "actually,
  hold off" posted on the issue. Requires the **Comments** webhook subscription. Bot/agent
  comments and the session's own thread (which arrives as `prompted`) are skipped.
- **Issue context first**: the initial turn prepends a synthetic context message built from
  Linear's `promptContext` blob (curated issue details + comments, shipped on every
  AgentSessionEvent webhook), falling back to a subject fetch (identifier, title, state,
  assignee, labels, description). Then the session comment thread follows, slackbotv2-style.
- **Native activity narration, fully append-only**: an **ephemeral thought** lands immediately
  (Linear requires an acknowledgement within 10 seconds), reasoning blurbs post as persistent
  `thought` activities (min-gap merged, budget-capped), commands/tools post as `action`
  activities (ephemeral while running, persisted with their output once complete), and the final
  answer posts exactly once — a `response` activity on success, an `error` activity on failure.
  Agent sessions are append-only; nothing is ever edited or deleted.
- `--claude` / `--codex` / `--amp` / `--model …` / `--opus|--sonnet|--haiku` inline flags pick the
  harness/model, same as slackbotv2.

## Ingress model

Linear delivers **HTTP webhooks** (like Slack, unlike Discord's Gateway): signature-verified
(`LINEARBOT_WEBHOOK_SECRET`, HMAC-SHA256) deliveries to `POST /api/webhooks/linear`. The
create/append handoff is awaited before the webhook is acknowledged; a retryable session-api
failure answers **503** so Linear redelivers (the chat-SDK dedupe key is cleared first). The
execute call runs inside the background render — after the working ack — because cold sandbox
spin-up far exceeds Linear's webhook deadline. Multiple replicas are fine.

## Auth

Agent-sessions mode requires an **OAuth `actor=app` install** of a Linear OAuth application with
the `app:assignable` + `app:mentionable` scopes; set the resulting token as
`LINEAR_ACCESS_TOKEN`. A personal `LINEAR_API_KEY` only supports the degraded
`LINEARBOT_MODE=comments` (plain issue-comment threads, no agent sessions). Webhook
subscriptions needed: **Agent session events** and **Comments** (comments power the
issue-comment-to-session forwarding; they are also what comments mode consumes).

## Environment

| Var | Required | Notes |
|-----|----------|-------|
| `LINEARBOT_WEBHOOK_SECRET` | ✅ | Signing secret from the linearbot webhook's settings page. Distinct from the api-rs `linear_webhook` workflow's `LINEAR_WEBHOOK_SECRET` (separate Linear webhook → separate secret). |
| `LINEAR_ACCESS_TOKEN` | ✅* | actor=app OAuth token (*or `LINEAR_API_KEY` for comments mode). |
| `LINEARBOT_DATABASE_URL` | ✅ | Postgres for chat-SDK state (falls back to `DATABASE_URL`). |
| `CENTAUR_API_URL` | — | api-rs control plane, default `http://127.0.0.1:8080`. |
| `LINEARBOT_API_KEY` | — | Bearer sent to api-rs (falls back to `CENTAUR_API_KEY`). |
| `LINEARBOT_MODE` | — | `agent-sessions` (default) or `comments`. |
| `LINEARBOT_USER_NAME` | — | Bot display name for mention parsing, default `centaur`. |
| `LINEARBOT_NARRATOR_MAX_ACTIVITIES` | — | Budget on persisted thought/action activities per run. |
| `LINEARBOT_NARRATOR_MIN_POST_GAP_MS` | — | Min gap between posted thought activities. |
| `LINEARBOT_ACTIVE_EXECUTION_TTL_MS` | — | Staleness TTL unwedging crash-mid-handoff threads. |
| `SESSION_IDLE_TIMEOUT_MS` / `SESSION_MAX_DURATION_MS` | — | Forwarded to api-rs executes. |
| `LINEARBOT_LOG_LEVEL` | — | `debug`/`info`/`warn`/`error`, default `info`. |

## Patched adapter

`patches/@chat-adapter__linear@4.30.0.patch` (registered in `pnpm-workspace.yaml`), three fixes:

1. Agent-session messages encode their thread id as `linear:{issueId}:s:{agentSessionId}`
   regardless of which comment triggered them, so one Linear agent session maps to exactly one
   centaur session.
2. A `created` event without a root comment (description mention, bare delegation) synthesizes
   an empty trigger comment instead of dropping the event (which left the session unacknowledged
   forever).
3. A `created` event without a creator (automation/triage-rule delegation, or another agent) is
   attributed to a distinct `linear-automation` identity instead of the bot itself — upstream's
   self-attribution made the chat SDK skip the message as the bot's own, silently ignoring every
   automation-created session.

## Tests

`bun test test` — unit tests plus an emulate-style harness (fake Linear GraphQL API + mock
api-rs + signed webhooks) that drives the real patched adapter end-to-end.
