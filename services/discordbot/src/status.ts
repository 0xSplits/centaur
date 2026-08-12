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
  /** Session title (the conversation name the bots set), when present. */
  title: string;
  /** Display name of whoever triggered the turn, when recorded. */
  who: string;
};

export type DailyRow = {
  /** UTC calendar date, `YYYY-MM-DD`. */
  day: string;
  failed: number;
  runs: number;
};

export type StatusReport = {
  apiHealthy: boolean | null;
  apiReady: boolean | null;
  collectedNotes: string[];
  /** Runs per UTC day, oldest→today, zero-filled to exactly 7 entries. */
  daily: DailyRow[];
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
    title: String(row.title ?? ""),
    who: String(row.user_name ?? ""),
  });

  const [apiHealthy, apiReady, recent, tally, inFlight, sandboxes, warm, daily] =
    await Promise.all([
      probe("/healthz"),
      probe("/readyz"),
      query(
        "recent turns",
        `SELECT e.thread_key, e.status,
                left(coalesce(e.error, ''), ${ERROR_SNIPPET_CHARS}) AS error,
                e.created_at,
                extract(epoch FROM (e.completed_at - e.started_at)) AS duration_seconds,
                e.metadata ->> 'user_name' AS user_name,
                coalesce(s.title, s.metadata ->> 'discord_conversation_name',
                         s.metadata ->> 'linear_conversation_name',
                         s.metadata ->> 'slack_conversation_name') AS title
         FROM session_executions e
         LEFT JOIN sessions s ON s.thread_key = e.thread_key
         ORDER BY e.created_at DESC
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
        `SELECT e.thread_key, e.status, '' AS error, e.created_at,
                NULL AS duration_seconds,
                e.metadata ->> 'user_name' AS user_name,
                coalesce(s.title, s.metadata ->> 'discord_conversation_name',
                         s.metadata ->> 'linear_conversation_name',
                         s.metadata ->> 'slack_conversation_name') AS title
         FROM session_executions e
         LEFT JOIN sessions s ON s.thread_key = e.thread_key
         WHERE e.status IN ('queued', 'running')
         ORDER BY e.created_at ASC
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
      // Claimed/failed rows are never deleted — they're lifetime history, so
      // an unfiltered count reads like a leak ("868 claimed"). Only ready/
      // evicting are current facts; show claimed/failed as 24h churn.
      query(
        "warm pool",
        `SELECT status, count(*)::int AS count
         FROM session_warm_sandboxes
         WHERE status IN ('ready', 'evicting')
            OR updated_at > now() - interval '24 hours'
         GROUP BY status`,
      ),
      query(
        "7-day histogram",
        `SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
                count(*)::int AS runs,
                (count(*) FILTER (WHERE status = 'failed'))::int AS failed
         FROM session_executions
         WHERE created_at > now() - interval '7 days'
         GROUP BY 1
         ORDER BY 1`,
      ),
    ]);

  return {
    apiHealthy,
    apiReady,
    collectedNotes: notes,
    daily: zeroFilledWeek(daily ?? [], now),
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

// Short ASCII tags: emoji are double-width in Discord's code blocks and wreck
// column alignment, which is the whole point of the tabular layout.
const STATUS_TAG: Record<string, string> = {
  cancelled: "cxl",
  completed: "ok",
  failed: "FAIL",
  queued: "que",
  running: "run",
};

const TAG_WIDTH = 5;
const THREAD_WIDTH = 24;
const WHO_WIDTH = 10;

// Internal actor ids nobody recognizes → the name the team knows.
const WHO_ALIAS: Record<string, string> = {
  "github-pr-manager": "gerard",
};
const AGE_WIDTH = 4;
const DUR_WIDTH = 5;
const ERROR_LINE_CHARS = 60;
const BAR_WIDTH = 16;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function weekdayLabel(dayIso: string): string {
  const parsed = new Date(`${dayIso}T00:00:00Z`);
  const label = WEEKDAYS[parsed.getUTCDay()];
  return label ?? "???";
}

/**
 * Discord has no table markup; the closest thing is a monospace code block
 * with hand-padded columns. Header line stays OUTSIDE the block (bold + emoji
 * work there); rows stay ~50 chars wide to limit wrapping on mobile.
 */
export function formatStatus(report: StatusReport): string {
  const mark = (value: boolean | null): string =>
    value === null ? "❓" : value ? "✅" : "❌";
  const header =
    `**gerard status** · api-rs ${mark(report.apiHealthy)} ` +
    `ready ${mark(report.apiReady)} · db ${report.dbOk ? "✅" : "❌"}`;

  const lines: string[] = [];

  const tallyEntries = Object.entries(report.tally).sort();
  if (tallyEntries.length > 0) {
    lines.push(
      `24h: ${tallyEntries
        .map(([status, count]) => `${count} ${STATUS_TAG[status] ?? status}`)
        .join(" · ")}`,
    );
    lines.push("");
  }

  const tableRow = (
    tag: string,
    thread: string,
    who: string,
    age: string,
    took: string,
  ): string =>
    `${tag.padEnd(TAG_WIDTH)} ${fit(thread, THREAD_WIDTH)} ` +
    `${fit(who, WHO_WIDTH, "head")} ${age.padStart(AGE_WIDTH)} ` +
    `${took.padStart(DUR_WIDTH)}`;

  // One table: in-flight turns first (no duration yet), then settled recent
  // turns. The recent query also returns queued/running rows — skip those so
  // an in-flight turn isn't listed twice. AGE = when the turn was requested,
  // TOOK = how long it ran.
  const turnRow = (row: ExecutionRow): string =>
    tableRow(
      STATUS_TAG[row.status] ?? row.status,
      threadLabel(row),
      WHO_ALIAS[row.who] ?? row.who,
      formatAge(row.ageSeconds),
      row.durationSeconds !== null ? formatDuration(row.durationSeconds) : "-",
    ).trimEnd();
  const settled = report.recent.filter(
    (row) => row.status !== "queued" && row.status !== "running",
  );
  const turns = [...report.inFlight, ...settled];
  if (turns.length > 0) {
    lines.push(tableRow("", "THREAD", "WHO", "AGE", "TOOK").trimEnd());
    for (const row of turns) {
      lines.push(turnRow(row));
      if (row.error) {
        lines.push(`      └ ${row.error.slice(0, ERROR_LINE_CHARS)}`);
      }
    }
  }

  const sandboxBits: string[] = [];
  if (report.sandboxes.length > 0) {
    sandboxBits.push(`${report.sandboxes.length} active`);
  }
  // ready/evicting are the pool's current state; claimed/failed rows are
  // historical (the collect query already windows them to 24h).
  const warmLine = (statuses: string[]): string =>
    statuses
      .filter((status) => (report.warmPool[status] ?? 0) > 0)
      .map((status) => `${report.warmPool[status]} ${status}`)
      .join(", ");
  const warmNow = warmLine(["ready", "evicting"]);
  const warmChurn = warmLine(["claimed", "failed"]);
  if (warmNow) sandboxBits.push(`warm: ${warmNow}`);
  if (warmChurn) sandboxBits.push(`warm 24h: ${warmChurn}`);
  if (sandboxBits.length > 0) {
    lines.push("");
    lines.push(`sandboxes: ${sandboxBits.join(" · ")}`);
  }

  for (const note of report.collectedNotes) lines.push(`! ${note}`);
  if (!report.dbOk && report.collectedNotes.length === 0) {
    lines.push("! session database unreachable — turn history unavailable");
  }

  // 7-day histogram, in its OWN code block below the live view: the bar
  // encodes ONE measure (runs); failures get their own labeled column rather
  // than a second scale or color-alone marking; the failure rate is a plain
  // stat line.
  const histogramLines: string[] = [];
  const week = report.daily;
  const totalRuns = week.reduce((sum, day) => sum + day.runs, 0);
  if (totalRuns > 0) {
    const totalFailed = week.reduce((sum, day) => sum + day.failed, 0);
    const maxRuns = Math.max(...week.map((day) => day.runs));
    histogramLines.push(`     ${"LAST 7 DAYS".padEnd(BAR_WIDTH + 1)}RUNS FAIL`);
    for (const day of week) {
      const bar = "█".repeat(
        day.runs === 0
          ? 0
          : Math.max(1, Math.round((day.runs / maxRuns) * BAR_WIDTH)),
      );
      const fail = day.failed > 0 ? String(day.failed) : "-";
      histogramLines.push(
        `${weekdayLabel(day.day)}  ${bar.padEnd(BAR_WIDTH + 1)}` +
          `${String(day.runs).padStart(4)} ${fail.padStart(4)}`,
      );
    }
    const rate = (totalFailed / totalRuns) * 100;
    histogramLines.push(
      `7d: ${totalRuns} runs · ${totalFailed} failed (${rate.toFixed(1)}%)`,
    );
  }
  const histogram = histogramLines.join("\n");
  const histogramBlock = histogram ? `\n\`\`\`\n${histogram}\n\`\`\`` : "";

  if (lines.length === 0 && !histogramBlock) return header;
  const body = lines.join("\n");
  // The histogram block is small and fixed-size; give the live view whatever
  // budget remains under Discord's cap.
  const budget =
    STATUS_MAX_CHARS - header.length - histogramBlock.length - 20;
  const bounded =
    body.length <= budget
      ? body
      : `${sliceSurrogateSafe(body, budget - 12).trimEnd()}\n[truncated]`;
  const liveBlock = lines.length > 0 ? `\n\`\`\`\n${bounded}\n\`\`\`` : "";
  return `${header}${liveBlock}${histogramBlock}`;
}

/**
 * Human label for a turn: the session title when the bots set one, otherwise
 * a friendlier rendering of the thread key ("GH PR splits-teams#1799" beats
 * "github-manage:0xSplits/splits-teams:1799"; raw Discord ids stay raw).
 */
function threadLabel(row: { threadKey: string; title: string }): string {
  if (row.title.trim()) return row.title.trim();
  const parts = row.threadKey.split(":");
  const platform = parts[0] ?? row.threadKey;
  const rest = parts.slice(1).join(":");
  if (platform === "github-manage" && parts.length >= 3) {
    const repo = (parts[1] ?? "").split("/").pop() ?? parts[1];
    return `GH PR ${repo}#${parts[2]}`;
  }
  if (platform.startsWith("github")) return `GH ${rest}`;
  if (platform === "linear") return `Linear ${rest}`;
  if (platform === "slack") return `Slack ${rest}`;
  if (platform === "discord") return `Discord ${rest}`;
  return row.threadKey;
}

/**
 * Truncate + pad to the column. Middle ellipsis by default so both ends stay
 * readable ("GH PR splits-con…eams#1799", "Discord 90294…:1391220231" — the
 * head names the thing, the tail discriminates); plain head-cut for names.
 */
function fit(value: string, width: number, keep: "edges" | "head" = "edges"): string {
  if (value.length <= width) return value.padEnd(width);
  if (keep === "head" || width < 12) {
    return `${value.slice(0, width - 1)}…`;
  }
  const tail = 7;
  return `${value.slice(0, width - tail - 1)}…${value.slice(-tail)}`;
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

/** The last 7 UTC calendar days (oldest→today), zero-filling days with no runs. */
function zeroFilledWeek(
  rows: Record<string, unknown>[],
  nowMs: number,
): DailyRow[] {
  const byDay = new Map<string, { failed: number; runs: number }>();
  for (const row of rows) {
    byDay.set(String(row.day ?? ""), {
      failed: numberOrNull(row.failed) ?? 0,
      runs: numberOrNull(row.runs) ?? 0,
    });
  }
  const days: DailyRow[] = [];
  for (let offset = 6; offset >= 0; offset -= 1) {
    const day = new Date(nowMs - offset * 86_400_000)
      .toISOString()
      .slice(0, 10);
    days.push({ day, failed: 0, runs: 0, ...byDay.get(day) });
  }
  return days;
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
