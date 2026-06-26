import { readFileSync } from "node:fs";
import { createGithubbot, type GithubbotOptions } from "./index";

const port = numberEnv("PORT", 3001);
const apiUrl = stringEnv("CENTAUR_API_URL", "http://127.0.0.1:8080");

// Personal access token for the bot's GitHub teammate account (the bot acts as a
// real GitHub user — it can be requested as a reviewer, @-mentioned, assigned).
const token = requiredEnv("GITHUB_TOKEN");

// Signing secret configured on the GitHub repo/org webhook. The adapter verifies
// comment webhooks; githubbot verifies the pull_request (review-request) webhook.
const webhookSecret =
  optionalEnv("GITHUB_WEBHOOK_SECRET") ?? optionalEnv("GITHUBBOT_WEBHOOK_SECRET");
if (!webhookSecret) {
  throw new Error("GITHUB_WEBHOOK_SECRET (or GITHUBBOT_WEBHOOK_SECRET) is required");
}

// The bot account's GitHub login. Drives @-mention detection and matching the
// requested reviewer on review-request webhooks, so it must be the real login.
const userName =
  optionalEnv("GITHUB_BOT_USERNAME") ?? optionalEnv("GITHUBBOT_USER_NAME");
if (!userName) {
  throw new Error("GITHUB_BOT_USERNAME is required (the bot account's GitHub login)");
}

// Full review methodology override. Inline wins; otherwise a mounted file (the
// overlay's path). Unset -> the bundled DEFAULT_REVIEW_PROMPT is used.
const reviewPromptInline = optionalEnv("GITHUBBOT_REVIEW_PROMPT");
const reviewPromptFile = optionalEnv("GITHUBBOT_REVIEW_PROMPT_FILE");
let reviewPrompt: string | undefined = reviewPromptInline;
if (!reviewPrompt && reviewPromptFile) {
  try {
    reviewPrompt = readFileSync(reviewPromptFile, "utf8");
  } catch (error) {
    throw new Error(
      `GITHUBBOT_REVIEW_PROMPT_FILE (${reviewPromptFile}) could not be read: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

// Default to info: the chat adapter logs raw webhook bodies at debug, and
// JSON-serializing those payloads on the hot path blocks the event loop.
const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
const minLogLevel: (typeof LOG_LEVELS)[number] = (() => {
  const value = optionalEnv("GITHUBBOT_LOG_LEVEL")?.toLowerCase();
  return (LOG_LEVELS as readonly string[]).includes(value ?? "")
    ? (value as (typeof LOG_LEVELS)[number])
    : "info";
})();

const consoleLogger = {
  debug: (message: string, data?: unknown) => log("debug", message, data),
  info: (message: string, data?: unknown) => log("info", message, data),
  warn: (message: string, data?: unknown) => log("warn", message, data),
  error: (message: string, data?: unknown) => log("error", message, data),
  child: () => consoleLogger,
};

// Fail fast at boot if no Postgres URL is set — pg.Pool would otherwise silently
// fall back to localhost and every handler would fail at runtime. The chart
// always provides GITHUBBOT_DATABASE_URL.
const postgresUrl =
  optionalEnv("GITHUBBOT_DATABASE_URL") ??
  optionalEnv("DATABASE_URL") ??
  optionalEnv("POSTGRES_URL");
if (!postgresUrl) {
  throw new Error(
    "GITHUBBOT_DATABASE_URL (or DATABASE_URL / POSTGRES_URL) is required",
  );
}

const options: GithubbotOptions = {
  apiUrl,
  apiKey: optionalEnv("GITHUBBOT_API_KEY") ?? optionalEnv("CENTAUR_API_KEY"),
  autoMerge: boolEnv("GITHUBBOT_AUTO_MERGE", true),
  botUserId: optionalEnv("GITHUBBOT_USER_ID"),
  ciFixMaxAttempts: optionalNumberEnv("GITHUBBOT_CI_FIX_MAX_ATTEMPTS"),
  deleteBranchOnMerge: boolEnv("GITHUBBOT_DELETE_BRANCH_ON_MERGE", true),
  escalationHandle: optionalEnv("GITHUBBOT_ESCALATION_HANDLE"),
  holdLabel: optionalEnv("GITHUBBOT_HOLD_LABEL"),
  managedLabel: optionalEnv("GITHUBBOT_MANAGED_LABEL"),
  mergeMethod: mergeMethodEnv(),
  defaultHarnessType: optionalEnv("GITHUBBOT_DEFAULT_HARNESS"),
  githubApiUrl: optionalEnv("GITHUB_API_URL"),
  idleTimeoutMs: optionalNumberEnv("SESSION_IDLE_TIMEOUT_MS"),
  maxDurationMs: optionalNumberEnv("SESSION_MAX_DURATION_MS"),
  postgresUrl,
  reviewPrompt,
  stateKeyPrefix: optionalEnv("GITHUBBOT_STATE_KEY_PREFIX"),
  token,
  userName,
  webhookSecret,
  logger: consoleLogger,
};

const { app, chat } = createGithubbot(options);
const server = Bun.serve({ port, fetch: app.fetch });

log("info", "githubbot_started", {
  port: server.port,
  api_url: apiUrl,
});

const shutdown = async (signal: string): Promise<void> => {
  log("info", "githubbot_shutdown_started", { signal });
  await chat.shutdown().catch(() => undefined);
  server.stop();
  log("info", "githubbot_shutdown_complete", { signal });
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function requiredEnv(name: string): string {
  const value = optionalEnv(name);
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function stringEnv(name: string, fallback: string): string {
  return optionalEnv(name) ?? fallback;
}

function numberEnv(name: string, fallback: number): number {
  return optionalNumberEnv(name) ?? fallback;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const value = optionalEnv(name)?.toLowerCase();
  if (value === undefined) return fallback;
  if (["false", "0", "no", "off"].includes(value)) return false;
  if (["true", "1", "yes", "on"].includes(value)) return true;
  return fallback;
}

function mergeMethodEnv(): "merge" | "squash" | "rebase" | undefined {
  const value = optionalEnv("GITHUBBOT_MERGE_METHOD")?.toLowerCase();
  if (value === "merge" || value === "squash" || value === "rebase") return value;
  if (value !== undefined) {
    throw new Error("GITHUBBOT_MERGE_METHOD must be one of: merge, squash, rebase");
  }
  return undefined;
}

function optionalNumberEnv(name: string): number | undefined {
  const value = optionalEnv(name);
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function log(
  level: (typeof LOG_LEVELS)[number],
  message: string,
  data?: unknown,
): void {
  if (LOG_LEVELS.indexOf(level) < LOG_LEVELS.indexOf(minLogLevel)) return;
  console.log(
    JSON.stringify({
      level,
      service: "githubbot",
      timestamp: new Date().toISOString(),
      event: message,
      ...(data && typeof data === "object"
        ? (data as Record<string, unknown>)
        : {}),
    }),
  );
}
