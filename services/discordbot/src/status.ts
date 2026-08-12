import type { DiscordbotFetch } from "./types";
import { errorMessage, sliceSurrogateSafe } from "./utils";

// A "status" mention answers directly from the control plane — no sandbox, no
// session turn. The whole point is that it still works when the agent pipeline
// is broken: api-rs health comes from its /healthz + /readyz endpoints, and the
// turn/sandbox history comes from the shared session database (the same
// Postgres api-rs writes session_executions/sessions/session_warm_sandboxes
// to, reached via the bot's DATABASE_URL). Every source is fetched
// independently and best-effort so one dead dependency never blanks the rest
// of the report.

/** Structural slice of pg.Pool so tests can stub the database trivially. */
export type StatusDb = {
  query(sql: string): Promise<{ rows: Record<string, unknown>[] }>;
};

const KEYWORD = /^(status|health)[?!.]*$/i;
// Raw Discord mention markup (<@123>, <@!123>, <@&role>, <#channel>) plus the
// adapter's rewritten form (`@name`): none of it counts as words.
const MENTION_TOKEN = /^(<[@#][!&]?\w+>|@[\w.-]+)$/;

/**
 * True when the message is ONLY a status request ("@gerard status",
 * "<@&123> health?"). Anything with more words ("status of the deploy") falls
 * through to a normal agent turn so real questions are never hijacked.
 */
export function isStatusCommand(text: string): boolean {
  const words = text
    .split(/\s+/)
    .filter((word) => word.length > 0 && !MENTION_TOKEN.test(word));
  return words.length === 1 && KEYWORD.test(words[0] ?? "");
}

export type ExecutionRow = {
  ageSeconds: number | null;
  durationSeconds: number | null;
  error: string;
  status: string;
  threadKey: string;
};

export type StatusReport = {
  apiHealthy: boolean | null;
  apiReady: boolean | null;
  collectedNotes: string[];
  dbOk: boolean;
  inFlight: ExecutionRow[];
  recent: ExecutionRow[];
  sandboxes: { ageSeconds: number | null; sandboxId: string; threadKey: string }[];
  tally: Record<string, number>;
  warmPool: Record<string, number>;
};

const HEALTH_TIMEOUT_MS = 2_000;
const ERROR_SNIPPET_CHARS = 150;

export async function collectStatus(input: {
  apiUrl: string;
  db: StatusDb | null;
  fetchFn?: DiscordbotFetch;
  nowMs?: number;
}): Promise<StatusReport> {
  const fetchFn = input.fetchFn ?? fetch;
  const now = input.nowMs ?? Date.now();
  const notes: string[] = [];

  const probe = async (path: string): Promise<boolean | null> => {
    try {
      const response = await fetchFn(`${input.apiUrl}${path}`, {
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
      return response.ok;
    } catch {
      return false;
    }
  };

  const query = async (
    label: string,
    sql: string,
  ): Promise<Record<string, unknown>[] | null> => {
    if (!input.db) return null;
    try {
      return (await input.db.query(sql)).rows;
    } catch (error) {
      notes.push(`${label} unavailable (${errorMessage(error)})`);
      return null;
    }
  };

  const toExecutionRow = (row: Record<string, unknown>): ExecutionRow => ({
    ageSeconds: ageSecondsFrom(row.created_at, now),
    durationSeconds: numberOrNull(row.duration_seconds),
    error: String(row.error ?? "").slice(0, ERROR_SNIPPET_CHARS),
    status: String(row.status ?? "unknown"),
    threadKey: String(row.thread_key ?? "?"),
  });

  const [apiHealthy, apiReady, recent, tally, inFlight, sandboxes, warm] =
    await Promise.all([
      probe("/healthz"),
      probe("/readyz"),
      query(
        "recent turns",
        `SELECT thread_key, status, left(coalesce(error, ''), ${ERROR_SNIPPET_CHARS}) AS error,
                created_at,
                extract(epoch FROM (completed_at - started_at)) AS duration_seconds
         FROM session_executions
         ORDER BY created_at DESC
         LIMIT 8`,
      ),
      query(
        "24h tally",
        `SELECT status, count(*)::int AS count
         FROM session_executions
         WHERE created_at > now() - interval '24 hours'
         GROUP BY status`,
      ),
      query(
        "in-flight turns",
        `SELECT thread_key, status, '' AS error, created_at,
                NULL AS duration_seconds
         FROM session_executions
         WHERE status IN ('queued', 'running')
         ORDER BY created_at ASC
         LIMIT 8`,
      ),
      query(
        "active sandboxes",
        `SELECT thread_key, sandbox_id, sandbox_last_active_at
         FROM sessions
         WHERE sandbox_id IS NOT NULL
           AND sandbox_last_active_at > now() - interval '2 hours'
         ORDER BY sandbox_last_active_at DESC
         LIMIT 8`,
      ),
      query(
        "warm pool",
        `SELECT status, count(*)::int AS count
         FROM session_warm_sandboxes
         GROUP BY status`,
      ),
    ]);

  return {
    apiHealthy,
    apiReady,
    collectedNotes: notes,
    dbOk: recent !== null,
    inFlight: (inFlight ?? []).map(toExecutionRow),
    recent: (recent ?? []).map(toExecutionRow),
    sandboxes: (sandboxes ?? []).map((row) => ({
      ageSeconds: ageSecondsFrom(row.sandbox_last_active_at, now),
      sandboxId: String(row.sandbox_id ?? "?"),
      threadKey: String(row.thread_key ?? "?"),
    })),
    tally: countsByStatus(tally),
    warmPool: countsByStatus(warm),
  };
}

// Discord caps messages at 2000 chars; stay under it with honest truncation.
const STATUS_MAX_CHARS = 1_900;

const STATUS_EMOJI: Record<string, string> = {
  cancelled: "🚫",
  completed: "✅",
  failed: "❌",
  queued: "🕒",
  running: "▶️",
};

export function formatStatus(report: StatusReport): string {
  const lines: string[] = [];

  const mark = (value: boolean | null): string =>
    value === null ? "❓" : value ? "✅" : "❌";
  lines.push(
    `**gerard status** · api-rs ${mark(report.apiHealthy)} ` +
      `ready ${mark(report.apiReady)} · db ${report.dbOk ? "✅" : "❌"}`,
  );

  const tallyEntries = Object.entries(report.tally).sort();
  if (tallyEntries.length > 0) {
    lines.push(
      `last 24h: ${tallyEntries
        .map(([status, count]) => `${count} ${STATUS_EMOJI[status] ?? status}`)
        .join(" · ")}`,
    );
  }

  if (report.inFlight.length > 0) {
    lines.push("in flight:");
    for (const row of report.inFlight) {
      lines.push(
        `${STATUS_EMOJI[row.status] ?? "•"} ${describeThread(row.threadKey)}` +
          ` (${formatAge(row.ageSeconds)})`,
      );
    }
  }

  if (report.recent.length > 0) {
    lines.push("recent turns:");
    for (const row of report.recent) {
      const duration =
        row.durationSeconds !== null
          ? ` (${formatDuration(row.durationSeconds)})`
          : "";
      const error = row.error ? ` — ${row.error}` : "";
      lines.push(
        `${STATUS_EMOJI[row.status] ?? "•"} ${formatAge(row.ageSeconds)} ago · ` +
          `${describeThread(row.threadKey)}${duration}${error}`,
      );
    }
  }

  const warmEntries = Object.entries(report.warmPool).sort();
  const sandboxBits: string[] = [];
  if (report.sandboxes.length > 0) {
    sandboxBits.push(`${report.sandboxes.length} active`);
  }
  if (warmEntries.length > 0) {
    sandboxBits.push(
      `warm: ${warmEntries
        .map(([status, count]) => `${count} ${status}`)
        .join(", ")}`,
    );
  }
  if (sandboxBits.length > 0) lines.push(`sandboxes: ${sandboxBits.join(" · ")}`);

  for (const note of report.collectedNotes) lines.push(`⚠️ ${note}`);
  if (!report.dbOk && report.collectedNotes.length === 0) {
    lines.push("⚠️ session database unreachable — turn history unavailable");
  }

  const text = lines.join("\n");
  if (text.length <= STATUS_MAX_CHARS) return text;
  return `${sliceSurrogateSafe(text, STATUS_MAX_CHARS - 12).trimEnd()}\n[truncated]`;
}

/** `platform · short thread name` from a session thread key. */
function describeThread(threadKey: string): string {
  const separator = threadKey.indexOf(":");
  if (separator === -1) return shorten(threadKey);
  const platform = threadKey.slice(0, separator);
  const rest = threadKey.slice(separator + 1);
  return `${platform} ${shorten(rest)}`;
}

function shorten(value: string): string {
  return value.length <= 40 ? value : `…${value.slice(-39)}`;
}

function formatAge(seconds: number | null): string {
  if (seconds === null) return "?";
  return formatDuration(seconds);
}

function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

function countsByStatus(
  rows: Record<string, unknown>[] | null,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows ?? []) {
    const count = numberOrNull(row.count);
    if (count !== null) counts[String(row.status ?? "unknown")] = count;
  }
  return counts;
}

function ageSecondsFrom(value: unknown, nowMs: number): number | null {
  if (value instanceof Date) return (nowMs - value.getTime()) / 1000;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return (nowMs - parsed) / 1000;
  }
  return null;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}
