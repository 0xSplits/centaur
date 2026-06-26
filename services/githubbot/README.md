# githubbot

GitHub ingress for the Centaur agent. Mirrors `linearbot` (session-backed replies) in a
**comment-thread model**: a GitHub PR or issue comment thread maps to one centaur sandbox/context,
and the bot answers *in the thread* with a comment. It's built on the official
[`@chat-adapter/github`](https://www.npmjs.com/package/@chat-adapter/github) chat-SDK adapter, so
the session logic (`session-api.ts`) and rendering are the same as the other bots; the Rust `api-rs`
control plane is unchanged (`github:…` thread keys flow through identically).

The bot acts as a **real GitHub teammate**: it authenticates with a personal access token on a
dedicated machine-user account, so it can be `@`-mentioned, assigned, and **requested as a
reviewer** like any other collaborator.

## Behavior

- **`@`-mentioning the bot in an issue or PR comment** (Conversation tab) or a **PR review comment**
  (Files changed tab) → the bot answers in that thread, keyed `github:{owner}/{repo}:{prNumber}`
  (PR/issue level) or `github:{owner}/{repo}:{prNumber}:rc:{commentId}` (a review-comment thread) —
  one thread === one sandbox/context stack. For a **review-comment thread** the file path, line, and
  diff hunk it's anchored to are injected into the turn so the agent knows exactly what it's looking
  at; for a **PR conversation thread** the agent is pointed at `gh pr view`/`gh pr diff` to fetch the
  PR itself. A 👀 reaction acks the triggering comment while the bot works, settling to 🚀 / 😕. The
  reply is one comment: the answer with the chain-of-thought folded into a collapsed `<details>`
  section. Mention detection is the adapter's (matches the bot account's `@username`).
- **Plain comments in a thread the bot is already active in** (no mention) are appended to that
  thread's session as append-only context — no execution, no reply — so a follow-up like "actually,
  hold off" is seen by the next turn. The bot's own comments are skipped (loop guard) and inactive
  threads are ignored.
- **Requesting the bot's review on a PR** (`pull_request` / `review_requested` targeting the bot
  account) → a review turn runs on a **dedicated, isolated session thread**
  (`github-review:{owner}/{repo}:{prNumber}`) — kept separate from the PR conversation so reviews
  never share a sandbox with chit-chat, but persistent per PR so a re-request builds on the prior
  review. The chat adapter only surfaces comment threads, so this lifecycle event is handled
  directly: githubbot verifies the webhook signature itself, and the agent reviews the PR in its
  sandbox, posting inline comments + a summary via `gh`. The **review methodology** is a bundled,
  standalone default (`src/review-prompt.ts`) — good and reliable with zero config — that a
  deployment can **fully replace** via `GITHUBBOT_REVIEW_PROMPT` / `GITHUBBOT_REVIEW_PROMPT_FILE`
  (the override is used verbatim, so org conventions supersede ours wholesale; for Splits this is
  where the overlay supplies its review guide). Webhook redeliveries are de-duplicated by delivery id.
- **Per-turn context**: every turn prepends a compact header naming the PR/issue so a recycled
  sandbox always knows which subject to act on and where to reply.
- `--claude` / `--codex` / `--amp` / `--model …` / `--opus|--sonnet|--haiku` inline flags pick the
  harness/model, same as the other bots.

> **Scope (v1).** This is the conversational + review-on-request surface. PR self-management —
> merging on approval, fixing CI failures — is intended as a follow-up (it hangs off the same per-PR
> thread, driven by `pull_request_review` and `check_run`/`workflow_run` webhooks).

## Ingress model

GitHub delivers **HTTP webhooks** to `POST /api/webhooks/github` (content type **must** be
`application/json`). Comment events (`issue_comment`, `pull_request_review_comment`) are handed to the
chat adapter, which verifies the `X-Hub-Signature-256` HMAC and maps them to thread/message events.
The `pull_request` event is handled by githubbot directly (the adapter ignores it), so githubbot
verifies the signature itself before acting. Turns run in the background — webhooks are acknowledged
immediately (cold sandbox spin-up far exceeds GitHub's webhook deadline), with a bounded retry inside
the turn for transient cold-start failures. Multiple replicas are fine.

## Auth

A personal access token for the bot's GitHub teammate account is required (`GITHUB_TOKEN`). As a
normal user account it is natively mentionable, assignable, and requestable as a reviewer, and the
token inherits that user's permissions. Scopes: **`repo`** (read PRs/issues, post and edit comments,
add reactions) — and, when the agent pushes branches or opens PRs from its sandbox, **`workflow`**.

Keep this distinct from the `GITHUB_TOKEN` used by the repo-cache / sandbox tooling — that one is the
agent's git-operations token; this one is the bot's own identity. The chart wires githubbot's token
from a separate `GITHUBBOT_TOKEN` secret key to avoid collision.

GitHub App auth is also supported by the adapter (`GITHUB_APP_ID` / `GITHUB_PRIVATE_KEY`), but the
PAT-teammate model is what we run.

Webhook events to subscribe: **Issue comments**, **Pull request review comments**, and **Pull
requests** (for the review-request trigger).

## Environment

| Var | Required | Notes |
|-----|----------|-------|
| `GITHUB_TOKEN` | ✅ | PAT for the bot's teammate account. |
| `GITHUB_WEBHOOK_SECRET` | ✅ | Webhook signing secret (or `GITHUBBOT_WEBHOOK_SECRET`). |
| `GITHUB_BOT_USERNAME` | ✅ | The bot account's GitHub login — drives `@`-mention and requested-reviewer matching (or `GITHUBBOT_USER_NAME`). |
| `GITHUBBOT_DATABASE_URL` | ✅ | Postgres for chat-SDK state (falls back to `DATABASE_URL` / `POSTGRES_URL`). |
| `CENTAUR_API_URL` | — | api-rs control plane, default `http://127.0.0.1:8080`. |
| `GITHUBBOT_API_KEY` | — | Bearer sent to api-rs (falls back to `CENTAUR_API_KEY`). |
| `GITHUBBOT_DEFAULT_HARNESS` | — | Harness for new threads without an inline flag, default `codex`. |
| `GITHUBBOT_REVIEW_PROMPT` | — | Full review methodology, inline. Replaces the bundled default verbatim. |
| `GITHUBBOT_REVIEW_PROMPT_FILE` | — | Path to a file holding the review methodology (e.g. an overlay-mounted file). Used when the inline var is unset. |
| `GITHUB_API_URL` | — | Override the GitHub REST base URL (GitHub Enterprise). |
| `GITHUBBOT_USER_ID` | — | Bot's numeric user id for self-message detection (auto-detected otherwise). |
| `GITHUBBOT_STATE_KEY_PREFIX` | — | Chat-SDK state key prefix, default `centaur-githubbot`. |
| `GITHUBBOT_LOG_LEVEL` | — | `debug`/`info`/`warn`/`error`, default `info`. |
| `SESSION_IDLE_TIMEOUT_MS` / `SESSION_MAX_DURATION_MS` | — | Forwarded to api-rs executes. |

## Tests

`bun test test` — unit tests for the override flag parser, the GitHub thread-key parsing / context
preamble, and the review-request trigger gating.
