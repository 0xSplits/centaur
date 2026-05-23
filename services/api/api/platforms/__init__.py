"""Messaging-platform abstraction layer.

A ``MessagingPlatform`` owns everything that varies between the platforms
Centaur can deliver agent results to: text scrubbing, identity recovery,
system-prompt injection, live-streaming session lifecycle, thread-key
parsing, and active-thread tool-call capture.

One singleton per platform is registered in ``PLATFORMS``. Callers resolve
a platform by name (``resolve_platform("slack")``) or by inspecting the
delivery dict on an execution (``resolve_for_delivery(delivery)``). The
default fallback when the platform is missing or unknown is ``"dev"``,
which is a no-op implementation suitable for unit tests and the localhost
bypass path.

Built-in platforms are wired up by ``register_builtin_platforms()`` at the
bottom of this module, so simple ``from api.platforms import
resolve_platform`` works without explicit app-startup setup.

Platform-agnostic execution metadata keys
-----------------------------------------
The execution worker reads and writes several JSONB metadata keys on
``agent_execution_requests`` that are conceptually platform-agnostic but
historically Slack-named. Any platform that implements live streaming
must honor these spellings so the rest of the system stays platform-blind:

- ``slackbot_live_delivery`` (bool) — gate for live-session forwarding
- ``slackbot_agent_session_id`` (str) — opaque per-execution session id
- ``slackbot_live_delivery_failed`` (str) — reason live forwarding bailed
- ``slackbot_streamed_answer_chars`` (int) — chars already streamed live

A future schema-cleanup PR will rename these to ``live_session_*``; until
then platforms write under the legacy spellings.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, NamedTuple

import structlog

log = structlog.get_logger()


class ActiveThreadCapture(NamedTuple):
    """Result of matching a tool call for re-routing into the live session.

    ``text`` is what the platform wants forwarded into the live session as
    the agent's reply. ``envelope`` is the dict returned to the agent in
    place of the normal tool result so it knows the call was intercepted.
    """

    text: str
    envelope: dict[str, Any]


@dataclass(frozen=True)
class RequesterIdentity:
    """Who triggered an agent turn, as recovered from the messaging platform.

    Rendered into the system prompt so the agent can address the requester
    by handle, mention them in replies, and look up their GitHub identity.
    Construction is platform-agnostic; per-platform rendering of e.g.
    ``"Slack user ID: ..."`` lives on the platform's
    ``system_prompt_identity_lines`` method.
    """

    user_id: str
    mention: str
    github_handle: str | None = None
    github_handle_source: str | None = None
    github_handle_verified: bool = False
    github_handle_unavailable_reason: str | None = None


class MessagingPlatform:
    """Base implementation. Subclasses override what the platform supports.

    Every method has a working default so unrelated platforms (and tests
    that pass arbitrary platform names) keep working without raising.
    """

    name: str = ""

    # Text truncation limits used by the live-streaming projection.
    message_chunk_chars: int = 12_000
    step_chunk_chars: int = 12_000

    # Regex matching a leading ``<@USER_ID>`` mention prefix and capturing
    # the remaining text. Used by recovery-command normalization in the
    # ``messaging_thread_turn`` workflow. ``None`` means the platform has
    # no mention-prefix grammar; callers should fall through.
    mention_prefix_re: Any = None

    # ── Delivery predicates ────────────────────────────────────────────

    def is_delivery_for_me(self, delivery: dict[str, Any] | None) -> bool:
        return (
            isinstance(delivery, dict)
            and str(delivery.get("platform") or "") == self.name
        )

    # ── Text scrubbing ─────────────────────────────────────────────────

    def sanitize_text(
        self, text: str | None, *, preserve_edges: bool = False
    ) -> str:
        return text or ""

    def sanitize_event(self, value: Any) -> Any:
        return value

    def clip_text(self, value: Any, max_chars: int | None = None) -> str:
        text = (
            value
            if isinstance(value, str)
            else json.dumps(value, ensure_ascii=False, default=str)
        )
        text = text.strip()
        limit = max_chars or self.step_chunk_chars
        return text if len(text) <= limit else f"{text[: limit - 1]}…"

    # ── Thread-key parsing ─────────────────────────────────────────────

    def thread_key_destination(self, thread_key: str) -> str | None:
        """Return the channel/destination ID encoded in the thread_key, or None."""
        return None

    # ── Identity recovery ──────────────────────────────────────────────

    async def load_requester_identity(
        self, user_id: str | None
    ) -> RequesterIdentity | None:
        return None

    def system_prompt_identity_lines(
        self, identity: RequesterIdentity | None
    ) -> list[str]:
        return []

    def system_prompt_rules(self, *, user_id: str | None = None) -> list[str]:
        return []

    # ── Live-streaming session lifecycle ───────────────────────────────

    async def open_live_session(
        self,
        *,
        delivery: dict[str, Any],
        metadata: dict[str, Any],
        thread_key: str,
        title: str = "Centaur execution",
        header: str | None = None,
    ) -> str | None:
        return None

    async def session_text(
        self, session_id: str | None, markdown: str
    ) -> None:
        return None

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
        return None

    async def session_done(
        self, session_id: str | None, thread_id: str | None = None
    ) -> None:
        return None

    async def harness_event(
        self, session_id: str | None, event: dict[str, Any]
    ) -> dict[str, Any] | None:
        return None

    async def assistant_status(
        self, delivery: dict[str, Any], status: str
    ) -> None:
        return None

    # ── Channel post (workflow ctx.post_to_channel) ────────────────────

    async def send_channel_message(
        self,
        channel: str,
        text: str,
        *,
        thread_id: str | None = None,
    ) -> dict[str, Any]:
        """Post a message to a channel via this platform's outbound tool.

        Default raises so workflows fail loudly when they target a platform
        whose adapter doesn't implement outbound channel posts. Subclasses
        override to call the right tool (Slack → ``slack.send_message``,
        Discord → ``discord.send_message``, …).
        """
        raise NotImplementedError(
            f"platform {self.name!r} does not implement send_channel_message"
        )

    # ── Live tool-call capture ─────────────────────────────────────────

    def match_active_thread_capture(
        self,
        *,
        thread_key: str,
        tool_name: str,
        method_name: str,
        args: dict[str, Any],
    ) -> ActiveThreadCapture | None:
        """Pure-function check: should this tool call be re-routed through
        the live session instead of hitting the platform's API?

        Returns the text to forward + the response envelope on capture,
        ``None`` when the call should pass through to the normal tool
        path. The platform performs no I/O; ``tool_manager`` owns the
        live-session lookup (via ``runtime_control.get_live_session_id_for_thread``)
        and the actual ``session_text`` forward.

        Slack catches ``slack.send_message`` to the active thread; other
        platforms return ``None`` by default.
        """
        return None


# ── Registry ───────────────────────────────────────────────────────────

PLATFORMS: dict[str, MessagingPlatform] = {}


def register_platform(platform: MessagingPlatform) -> None:
    if not platform.name:
        raise ValueError("platform.name must be set before registration")
    PLATFORMS[platform.name] = platform


def resolve_platform(name: str | None) -> MessagingPlatform:
    """Return the registered platform, falling back to ``dev`` (no-op).

    Unknown platform names log a debug message and return the dev platform
    so callers don't need to special-case ``None``/unknown values.
    """
    if name and name in PLATFORMS:
        return PLATFORMS[name]
    if name:
        log.debug("resolve_platform_unknown", requested=name)
    return PLATFORMS["dev"]


def resolve_for_delivery(
    delivery: dict[str, Any] | None,
) -> MessagingPlatform:
    name: str | None = None
    if isinstance(delivery, dict):
        value = delivery.get("platform")
        if isinstance(value, str) and value:
            name = value
    return resolve_platform(name)


def resolve_for_thread_key(thread_key: str | None) -> MessagingPlatform | None:
    """Resolve a platform from the leading namespace of a thread_key
    (e.g. ``"slack:C123:..."`` → SlackPlatform). Returns None when the
    prefix doesn't match any registered platform.
    """
    if not thread_key or ":" not in thread_key:
        return None
    prefix = thread_key.split(":", 1)[0]
    return PLATFORMS.get(prefix)


def register_builtin_platforms() -> None:
    """Wire up the platforms that ship with the API.

    Called at module import time (below) so simple ``from api.platforms
    import resolve_platform`` works without explicit app-startup setup.
    Tests that need a clean registry can call ``PLATFORMS.clear()`` and
    re-invoke this.
    """
    from api.platforms.dev import DEV_PLATFORM
    from api.platforms.slack import SLACK_PLATFORM

    register_platform(DEV_PLATFORM)
    register_platform(SLACK_PLATFORM)


register_builtin_platforms()
