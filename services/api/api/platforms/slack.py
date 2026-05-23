"""Slack messaging platform: text scrubbing, identity recovery,
system-prompt injection, live-streaming session, and active-thread
``slack.send_message`` capture.

Everything Slack-specific lives here. Thin shims at
``api/slack_sanitize.py`` and ``api/slackbot_client.py`` re-export the
public surface for back-compat with older callers.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
from collections.abc import Callable
from dataclasses import replace
from typing import Any

import httpx
import structlog

from api.platforms import ActiveThreadCapture, MessagingPlatform, RequesterIdentity

log = structlog.get_logger()

# ── Text scrubbing ────────────────────────────────────────────────────

_THREAD_TRAILER_RE = re.compile(
    r"(?:^|\s)(?:Agent|Codex|Amp|Claude\s+Code|Pi)\s+thread\s+`?[0-9a-f-]{8,}`?(?:,\s*with\s+interactive\s+elements)?(?=\s*$|[.!?]\s*$)",
    re.IGNORECASE | re.MULTILINE,
)
_EXECUTION_TRAILER_RE = re.compile(
    r"\b(?:Execution|execution_id)\s*[:=]\s*`?exe_[0-9a-f]{16}`?",
    re.IGNORECASE,
)
_CURL_EXIT_RE = re.compile(r"curl:?\s*\((\d+)\):?\s*[^\n]{0,200}", re.IGNORECASE)

_TEXT_KEYS = {
    "content",
    "delta",
    "details",
    "error",
    "message",
    "output",
    "result",
    "summary",
    "text",
    "title",
}


def _replace_matching_json_objects(
    text: str,
    predicate: Callable[[dict[str, Any]], bool],
    replacement: str,
) -> str:
    decoder = json.JSONDecoder()
    out: list[str] = []
    index = 0
    while index < len(text):
        if text[index] != "{":
            out.append(text[index])
            index += 1
            continue
        try:
            value, end = decoder.raw_decode(text[index:])
        except ValueError:
            out.append(text[index])
            index += 1
            continue
        if isinstance(value, dict) and predicate(value):
            out.append(replacement)
            index += end
            continue
        out.append(text[index])
        index += 1
    return "".join(out)


def _is_k8s_status(value: dict[str, Any]) -> bool:
    return value.get("kind") == "Status" and any(
        key in value for key in ("status", "reason", "code", "message")
    )


def _is_tool_error_envelope(value: dict[str, Any]) -> bool:
    return "error_type" in value and any(
        key in value for key in ("detail", "error", "status_code")
    )


def sanitize_for_slack(text: str | None, *, preserve_edges: bool = False) -> str:
    """Strip known plumbing leaks from ``text``. Idempotent; empty input → ``""``."""
    if not text:
        return ""
    sanitized = _replace_matching_json_objects(
        text, _is_k8s_status, "[k8s status omitted]"
    )
    sanitized = _replace_matching_json_objects(
        sanitized, _is_tool_error_envelope, "[tool error omitted]"
    )
    sanitized = _THREAD_TRAILER_RE.sub("", sanitized)
    sanitized = _EXECUTION_TRAILER_RE.sub("[execution id omitted]", sanitized)
    sanitized = _CURL_EXIT_RE.sub(r"transport_error(\1)", sanitized)
    sanitized = re.sub(r"[ \t]+\n", "\n", sanitized)
    sanitized = re.sub(r"\n{3,}", "\n\n", sanitized)
    return sanitized if preserve_edges else sanitized.strip()


def sanitize_slack_event(value: Any) -> Any:
    if isinstance(value, str):
        return sanitize_for_slack(value, preserve_edges=True)
    if isinstance(value, list):
        return [sanitize_slack_event(item) for item in value]
    if isinstance(value, dict):
        sanitized: dict[str, Any] = {}
        for key, item in value.items():
            if isinstance(item, (dict, list)) or key in _TEXT_KEYS:
                sanitized[key] = sanitize_slack_event(item)
            else:
                sanitized[key] = item
        return sanitized
    return value


# ── Slackbot HTTP client ──────────────────────────────────────────────

_RETRYABLE_STATUS = frozenset({408, 429, 500, 502, 503, 504})
_RETRY_ATTEMPTS = 3
_RETRY_BASE_DELAY_S = 0.25


def _base_url() -> str:
    return os.getenv("SLACKBOT_URL", "").strip().rstrip("/")


def _api_key() -> str:
    return os.getenv("SLACKBOT_API_KEY", "").strip()


def enabled() -> bool:
    return bool(_base_url() and _api_key())


async def slackbot_post(
    path: str,
    body: dict[str, Any],
    *,
    timeout: httpx.Timeout | None = None,
) -> dict[str, Any] | None:
    base_url = _base_url()
    api_key = _api_key()
    if not base_url or not api_key:
        return None
    request_timeout = timeout or httpx.Timeout(8.0, connect=2.0)
    last_status: int | None = None
    last_response: str | None = None
    last_error: str | None = None
    for attempt in range(_RETRY_ATTEMPTS):
        try:
            async with httpx.AsyncClient(timeout=request_timeout) as client:
                response = await client.post(
                    f"{base_url}{path}",
                    headers={
                        "Authorization": f"Bearer {api_key}",
                        "Content-Type": "application/json",
                    },
                    json=body,
                )
                text = response.text
                if response.is_success:
                    if not text:
                        return {}
                    data = response.json()
                    return data if isinstance(data, dict) else {}
                last_status = response.status_code
                last_response = text[:500]
                if response.status_code not in _RETRYABLE_STATUS:
                    log.warning(
                        "slackbot_call_failed",
                        path=path,
                        status=response.status_code,
                        response=last_response,
                    )
                    return None
        except Exception as exc:
            last_error = str(exc)
        if attempt + 1 < _RETRY_ATTEMPTS:
            await asyncio.sleep(_RETRY_BASE_DELAY_S * (2**attempt))
    log.warning(
        "slackbot_call_failed",
        path=path,
        status=last_status,
        response=last_response,
        error=last_error,
        attempts=_RETRY_ATTEMPTS,
    )
    return None


# ── Delivery field extraction (Slack-shaped) ──────────────────────────


def is_slack_delivery(delivery: dict[str, Any] | None) -> bool:
    return isinstance(delivery, dict) and str(delivery.get("platform") or "") == "slack"


def channel_id(delivery: dict[str, Any]) -> str:
    return str(delivery.get("channel") or delivery.get("channel_id") or "").strip()


def thread_ts(delivery: dict[str, Any]) -> str:
    return str(delivery.get("thread_ts") or "").strip()


def recipient_team_id(delivery: dict[str, Any], thread_key: str) -> str:
    value = str(
        delivery.get("recipient_team_id")
        or delivery.get("team_id")
        or delivery.get("team")
        or ""
    ).strip()
    if value:
        return value
    parts = thread_key.split(":")
    return parts[1] if len(parts) >= 2 and parts[0] == "slack" else ""


def recipient_user_id(delivery: dict[str, Any], metadata: dict[str, Any]) -> str:
    return str(
        delivery.get("recipient_user_id")
        or delivery.get("user_id")
        or metadata.get("user_id")
        or ""
    ).strip()


def slack_thread_key_to_channel(thread_key: str) -> str:
    """Extract the channel ID from a ``slack:CHANNEL:TS`` thread_key.

    Returns ``""`` if the thread_key does not have the slack shape.
    """
    parts = thread_key.split(":")
    if len(parts) >= 3 and parts[0] == "slack":
        # slack:TEAM:CHANNEL:TS (4-part) or slack:CHANNEL:TS (3-part)
        return parts[2] if len(parts) >= 4 else parts[1]
    return ""


# ── GitHub identity extraction from Slack profiles ────────────────────

_GITHUB_HANDLE_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$")
_GITHUB_URL_RE = re.compile(
    r"(?:https?://)?github\.com/([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)",
    re.IGNORECASE,
)
_GITHUB_LABEL_RE = re.compile(r"\bgithub\b", re.IGNORECASE)
_GITHUB_PREFIX_RE = re.compile(
    r"\bgithub\b\s*(?:username|user|handle|profile)?\s*[:/@-]?\s*@?([A-Za-z0-9][A-Za-z0-9-]{0,38})",
    re.IGNORECASE,
)


def _valid_github_handle(value: str) -> str | None:
    # Accept inputs like " @octocat ", "@octocat/repo", or "octocat/" by
    # stripping surrounding whitespace + leading ``@`` and lopping off
    # any trailing path segment before pattern matching.
    candidate = value.strip("@ \t\n").rstrip("/").split("/", 1)[0]
    return candidate if _GITHUB_HANDLE_RE.match(candidate) else None


def extract_github_handle_from_slack_profile(
    profile: dict[str, Any],
) -> tuple[str | None, str | None, str]:
    """Return ``(handle, source, unavailable_reason)`` from Slack profile fields."""
    custom_fields = profile.get("custom_fields")
    if not isinstance(custom_fields, dict) or not custom_fields:
        return None, None, "no GitHub custom field found on Slack profile"

    saw_github_field = False
    for label, raw_value in custom_fields.items():
        label_text = str(label or "").strip()
        value = str(raw_value or "").strip()
        if not value:
            continue

        label_mentions_github = bool(_GITHUB_LABEL_RE.search(label_text))
        value_mentions_github = bool(_GITHUB_LABEL_RE.search(value))
        if not label_mentions_github and not value_mentions_github:
            continue
        saw_github_field = True

        source = (
            f'Slack profile custom field "{label_text}"'
            if label_text
            else "Slack profile custom field"
        )
        url_match = _GITHUB_URL_RE.search(value)
        if url_match:
            handle = _valid_github_handle(url_match.group(1))
            if handle:
                return f"@{handle}", source, ""

        prefixed_match = _GITHUB_PREFIX_RE.search(value)
        if prefixed_match:
            handle = _valid_github_handle(prefixed_match.group(1))
            if handle:
                return f"@{handle}", source, ""

        if label_mentions_github:
            handle = _valid_github_handle(value)
            if handle:
                return f"@{handle}", source, ""

    if saw_github_field:
        return (
            None,
            None,
            "GitHub profile field did not contain a valid GitHub handle",
        )
    return None, None, "no GitHub custom field found on Slack profile"


# ── Mention prefix used by recovery-command normalization ─────────────

_SLACK_ID_MENTION_RE = re.compile(
    r"^<@[WU][A-Z0-9]+>\s*[:,;-]?\s*(.*)$", re.IGNORECASE
)


# ── Slack channel-ID shape, used inside match_active_thread_capture ───

_SLACK_CHANNEL_ID_RE = re.compile(r"^[CDG][A-Z0-9]+$")


# ── Slack-flavoured system-prompt formatting rules ────────────────────

_SLACK_FORMATTING_RULES: tuple[str, ...] = (
    "- Use standard markdown links `[Display Text](URL)` for hyperlinks",
    "- Do NOT use Slack-native `<URL|text>` link syntax",
    "- Preserve Slack user mentions (`<@UXXXXXXX>`) exactly as-is — only use these for actual Slack users",
    "- For Twitter/X handles, link to the profile WITHOUT an @ prefix in the display text: `[handle](https://x.com/handle)` (NOT `[@handle](...)`)",
    "- Prefer concise, well-structured markdown; long replies may be split across multiple Slack messages",
    "- Markdown tables are allowed and may render as native Slack tables when the structure is clean",
    "- NEVER put links/URLs inside code blocks (``` ```) — they won't be clickable. Use markdown tables or plain text with `[text](url)` links instead",
)


# ── Platform implementation ───────────────────────────────────────────


def _identity_with_unavailable_reason(
    base: RequesterIdentity, reason: str
) -> RequesterIdentity:
    return replace(
        base,
        github_handle_verified=False,
        github_handle_unavailable_reason=reason,
    )


class SlackPlatform(MessagingPlatform):
    name = "slack"
    mention_prefix_re = _SLACK_ID_MENTION_RE

    # ── Scrubbing ──────────────────────────────────────────────────

    def sanitize_text(
        self, text: str | None, *, preserve_edges: bool = False
    ) -> str:
        return sanitize_for_slack(text, preserve_edges=preserve_edges)

    def sanitize_event(self, value: Any) -> Any:
        return sanitize_slack_event(value)

    # ── Thread-key parsing ─────────────────────────────────────────

    def thread_key_destination(self, thread_key: str) -> str | None:
        result = slack_thread_key_to_channel(thread_key)
        return result or None

    # ── Identity recovery ──────────────────────────────────────────

    async def load_requester_identity(
        self, user_id: str | None
    ) -> RequesterIdentity | None:
        if not user_id:
            return None
        base = RequesterIdentity(user_id=user_id, mention=f"<@{user_id}>")
        try:
            from api.app import get_tool_manager

            profile = await get_tool_manager().call_tool_raw(
                "slack", "get_user_profile", {"user_id": user_id}
            )
        except Exception as exc:
            log.warning(
                "requester_identity_lookup_failed",
                platform=self.name,
                user_id=user_id,
                error=str(exc),
            )
            return _identity_with_unavailable_reason(
                base, "Slack profile could not be fetched"
            )

        if not isinstance(profile, dict) or profile.get("error"):
            error = str(profile.get("error") or "Slack profile could not be fetched")
            log.warning(
                "requester_identity_lookup_failed",
                platform=self.name,
                user_id=user_id,
                error=error,
            )
            return _identity_with_unavailable_reason(
                base, "Slack profile could not be fetched"
            )

        handle, source, reason = extract_github_handle_from_slack_profile(profile)
        if handle:
            return replace(
                base,
                github_handle=handle,
                github_handle_source=source or "Slack profile custom field",
                github_handle_verified=True,
            )
        return _identity_with_unavailable_reason(base, reason)

    def system_prompt_identity_lines(
        self, identity: RequesterIdentity | None
    ) -> list[str]:
        if identity is None:
            return []
        lines = [
            "",
            "## Requester Identity",
            "",
            f"- Slack user ID: {identity.user_id}",
            f"- Slack mention: {identity.mention}",
        ]
        if identity.github_handle_verified:
            lines.extend(
                [
                    f"- GitHub handle from Slack profile: {identity.github_handle}",
                    f"- GitHub handle source: {identity.github_handle_source}",
                    "- GitHub handle verified: yes",
                ]
            )
        else:
            lines.extend(
                [
                    "- GitHub handle from Slack profile: unavailable",
                    "- GitHub handle unavailable reason: "
                    f"{identity.github_handle_unavailable_reason}",
                    "- GitHub handle verified: no",
                ]
            )
        return lines

    def system_prompt_rules(self, *, user_id: str | None = None) -> list[str]:
        lines = ["", "## Slack Formatting Rules", "", *_SLACK_FORMATTING_RULES]
        if user_id:
            lines.append(
                f"- After completing a long task, tag the requester with their real Slack mention: <@{user_id}>"
            )
        return lines

    # ── Live-streaming session lifecycle ───────────────────────────

    async def open_live_session(
        self,
        *,
        delivery: dict[str, Any],
        metadata: dict[str, Any],
        thread_key: str,
        title: str = "Centaur execution",
        header: str | None = None,
    ) -> str | None:
        if not enabled() or not is_slack_delivery(delivery):
            return None
        channel = channel_id(delivery)
        parent_ts = thread_ts(delivery)
        if not channel or not parent_ts:
            return None
        body: dict[str, Any] = {
            "channel": channel,
            "parent_ts": parent_ts,
            "recipient_team_id": recipient_team_id(delivery, thread_key),
            "recipient_user_id": recipient_user_id(delivery, metadata),
            "title": title,
        }
        header_text = (header or "").strip()
        if header_text:
            body["header"] = header_text
        result = await slackbot_post("/api/slack/agent-sessions", body)
        session_id = str((result or {}).get("session_id") or "").strip()
        return session_id or None

    async def session_text(
        self, session_id: str | None, markdown: str
    ) -> None:
        sanitized = sanitize_for_slack(markdown)
        if not session_id or not sanitized.strip():
            return
        await slackbot_post(
            f"/api/slack/agent-sessions/{session_id}/text",
            {"markdown": sanitized},
        )

    async def session_step(
        self,
        session_id: str | None,
        *,
        step_id: str,
        title: str,
        status: str = "in_progress",
        details: str | None = None,
        output: str | None = None,
    ) -> None:
        if not session_id or not step_id or not title:
            return
        body: dict[str, Any] = {
            "id": step_id,
            "title": sanitize_for_slack(title),
            "status": status,
        }
        if details:
            body["details"] = sanitize_for_slack(details)
        if output:
            body["output"] = sanitize_for_slack(output)
        await slackbot_post(
            f"/api/slack/agent-sessions/{session_id}/step", body
        )

    async def session_done(
        self, session_id: str | None, thread_id: str | None = None
    ) -> None:
        if not session_id:
            return
        body: dict[str, Any] = {}
        if thread_id:
            body["thread_id"] = thread_id
        await slackbot_post(
            f"/api/slack/agent-sessions/{session_id}/done", body
        )

    async def harness_event(
        self, session_id: str | None, event: dict[str, Any]
    ) -> dict[str, Any] | None:
        if not session_id:
            return None
        return await slackbot_post(
            f"/api/slack/agent-sessions/{session_id}/harness-event",
            {"event": sanitize_slack_event(event)},
            timeout=httpx.Timeout(60.0, connect=2.0),
        )

    async def assistant_status(
        self, delivery: dict[str, Any], status: str
    ) -> None:
        if not enabled() or not is_slack_delivery(delivery):
            return
        channel = channel_id(delivery)
        ts = thread_ts(delivery)
        if not channel or not ts:
            return
        await slackbot_post(
            "/api/slack/assistant/status",
            {"channel_id": channel, "thread_ts": ts, "status": status},
        )

    # ── Outbound channel post ──────────────────────────────────────

    async def send_channel_message(
        self,
        channel: str,
        text: str,
        *,
        thread_id: str | None = None,
    ) -> dict[str, Any]:
        from api.app import get_tool_manager

        args: dict[str, Any] = {
            "channel": channel,
            "text": text,
            "no_attribution": True,
        }
        if thread_id:
            args["thread_ts"] = thread_id
        raw = await get_tool_manager().call_tool("slack", "send_message", args)
        try:
            result = json.loads(raw) if isinstance(raw, str) else raw
        except json.JSONDecodeError:
            result = {"raw": raw}
        if isinstance(result, dict) and result.get("error"):
            raise RuntimeError(str(result["error"]))
        return result

    # ── Live tool-call capture ─────────────────────────────────────

    def match_active_thread_capture(
        self,
        *,
        thread_key: str,
        tool_name: str,
        method_name: str,
        args: dict[str, Any],
    ) -> ActiveThreadCapture | None:
        if tool_name != "slack" or method_name != "send_message":
            return None
        parts = thread_key.split(":")
        if len(parts) < 4 or parts[0] != "slack":
            return None
        active_channel = parts[2]
        active_thread_ts = parts[3]
        requested_channel = str(
            args.get("channel") or args.get("channel_id") or ""
        ).lstrip("#")
        requested_thread_ts = str(args.get("thread_ts") or "")
        channel_is_id = bool(_SLACK_CHANNEL_ID_RE.match(requested_channel))
        if channel_is_id and requested_channel != active_channel:
            return None
        if requested_thread_ts and requested_thread_ts != active_thread_ts:
            return None
        text = str(args.get("text") or args.get("message") or "").strip()
        if not text:
            return None
        return ActiveThreadCapture(
            text=text,
            envelope={
                "captured": True,
                "message": "Captured into the active Slackbot live reply; no separate Slack message was posted.",
                "channel": active_channel,
                "thread_ts": active_thread_ts,
            },
        )


# ── Singleton ─────────────────────────────────────────────────────────
# Registration is centralized via api.platforms.register_builtin_platforms;
# this module only exposes the singleton.

SLACK_PLATFORM = SlackPlatform()
