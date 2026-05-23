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
"""

from __future__ import annotations

import json
import re
from typing import Any

import structlog

log = structlog.get_logger()


class MessagingPlatform:
    """Base implementation. Subclasses override what the platform supports.

    Every method has a working default so unrelated platforms (and tests
    that pass arbitrary platform names) keep working without raising.
    """

    name: str = ""

    # Text truncation limits used by the live-streaming projection.
    message_chunk_chars: int = 12_000
    step_chunk_chars: int = 12_000

    # Regex that matches a leading ``<@USER_ID>`` mention prefix and captures
    # the remaining text. Used by recovery-command normalisation in the
    # messaging_thread_turn workflow. Default never matches.
    mention_prefix_re: re.Pattern[str] = re.compile(r"(?!x)x")

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
    ) -> dict[str, str | bool] | None:
        return None

    def system_prompt_identity_lines(
        self, identity: dict[str, str | bool] | None
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

    async def capture_active_thread_tool_call(
        self,
        *,
        request: Any,
        sandbox_claims: dict[str, Any] | None,
        tool_name: str,
        method_name: str,
        args: dict[str, Any],
    ) -> dict[str, Any] | None:
        """If an agent tool call should be re-routed through the live session
        instead of hitting the platform's API, return a captured-result dict.

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
    return PLATFORMS.get("dev") or _DEV_FALLBACK


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


def resolve_for_metadata(
    metadata: dict[str, Any] | None,
) -> MessagingPlatform | None:
    """Resolve from metadata.platform if present; ``None`` otherwise.

    Unlike ``resolve_for_delivery``, this does not fall back to dev — it
    distinguishes "no platform recorded" from "dev platform".
    """
    if not isinstance(metadata, dict):
        return None
    value = metadata.get("platform")
    if isinstance(value, str) and value and value in PLATFORMS:
        return PLATFORMS[value]
    return None


# Defensive fallback used if resolve_platform runs before registration.
_DEV_FALLBACK = MessagingPlatform()
_DEV_FALLBACK.name = "dev"


# Eager imports so registration happens on package import. Kept at the
# bottom to avoid circular-import issues with platforms that import from
# api.* at module load.
from api.platforms import dev as _dev_module  # noqa: E402, F401
from api.platforms import slack as _slack_module  # noqa: E402, F401
