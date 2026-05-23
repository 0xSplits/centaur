"""Compatibility shim. The implementation moved to ``api.platforms.slack``;
this module re-exports the module-level helpers and delegates the async
session helpers to the registered ``SlackPlatform`` singleton so existing
``from api import slackbot_client`` callers keep working.

Phase 1 callers should resolve a platform via
``api.platforms.resolve_for_delivery(delivery)`` and call methods on it
directly. This shim will be removed once those migrations land.
"""

from __future__ import annotations

from typing import Any

from api.platforms.slack import (
    SLACK_PLATFORM,
    channel_id,
    enabled,
    is_slack_delivery,
    recipient_team_id,
    recipient_user_id,
    sanitize_slack_event,
    slackbot_post as post,
    thread_ts,
)

__all__ = [
    "channel_id",
    "enabled",
    "harness_event",
    "is_slack_delivery",
    "open_agent_session",
    "post",
    "recipient_team_id",
    "recipient_user_id",
    "sanitize_slack_event",
    "session_done",
    "session_step",
    "session_text",
    "set_status",
    "thread_ts",
]


async def open_agent_session(
    *,
    delivery: dict[str, Any],
    metadata: dict[str, Any],
    thread_key: str,
    title: str = "Centaur execution",
    header: str | None = None,
) -> str | None:
    return await SLACK_PLATFORM.open_live_session(
        delivery=delivery,
        metadata=metadata,
        thread_key=thread_key,
        title=title,
        header=header,
    )


async def session_text(session_id: str | None, markdown: str) -> None:
    return await SLACK_PLATFORM.session_text(session_id, markdown)


async def session_step(
    session_id: str | None,
    *,
    step_id: str,
    title: str,
    status: str = "in_progress",
    details: str | None = None,
    output: str | None = None,
) -> None:
    return await SLACK_PLATFORM.session_step(
        session_id,
        step_id=step_id,
        title=title,
        status=status,
        details=details,
        output=output,
    )


async def session_done(
    session_id: str | None, thread_id: str | None = None
) -> None:
    return await SLACK_PLATFORM.session_done(session_id, thread_id)


async def harness_event(
    session_id: str | None, event: dict[str, Any]
) -> dict[str, Any] | None:
    return await SLACK_PLATFORM.harness_event(session_id, event)


async def set_status(delivery: dict[str, Any], status: str) -> None:
    return await SLACK_PLATFORM.assistant_status(delivery, status)
