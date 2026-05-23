"""Tests for the messaging-platform abstraction in api.platforms."""

from __future__ import annotations

import pytest

from api.platforms import (
    MessagingPlatform,
    PLATFORMS,
    resolve_for_delivery,
    resolve_for_thread_key,
    resolve_platform,
)
from api.platforms.dev import DevPlatform
from api.platforms.slack import SLACK_PLATFORM, SlackPlatform


def test_registry_includes_slack_and_dev():
    assert isinstance(PLATFORMS["slack"], SlackPlatform)
    assert isinstance(PLATFORMS["dev"], DevPlatform)


def test_resolve_platform_known_name():
    assert resolve_platform("slack") is SLACK_PLATFORM


def test_resolve_platform_unknown_falls_back_to_dev():
    fallback = resolve_platform("not-a-real-platform")
    assert fallback.name == "dev"


def test_resolve_platform_none_falls_back_to_dev():
    fallback = resolve_platform(None)
    assert fallback.name == "dev"


def test_resolve_for_delivery_reads_platform_key():
    assert resolve_for_delivery({"platform": "slack"}) is SLACK_PLATFORM
    assert resolve_for_delivery({"platform": "dev"}).name == "dev"
    assert resolve_for_delivery({}).name == "dev"
    assert resolve_for_delivery(None).name == "dev"


def test_resolve_for_thread_key_matches_prefix():
    assert resolve_for_thread_key("slack:C123:1700.0001") is SLACK_PLATFORM
    assert resolve_for_thread_key("dev:foo").name == "dev"
    assert resolve_for_thread_key("nonexistent:foo") is None
    assert resolve_for_thread_key("") is None
    assert resolve_for_thread_key(None) is None


def test_slack_platform_owns_slack_delivery_identification():
    assert SLACK_PLATFORM.is_delivery_for_me({"platform": "slack"}) is True
    assert SLACK_PLATFORM.is_delivery_for_me({"platform": "dev"}) is False
    assert SLACK_PLATFORM.is_delivery_for_me({}) is False
    assert SLACK_PLATFORM.is_delivery_for_me(None) is False


def test_slack_sanitize_strips_known_plumbing_leaks():
    out = SLACK_PLATFORM.sanitize_text(
        'Done. {"kind":"Status","status":"Failure","reason":"AlreadyExists"} '
        "Codex thread `019e3c91-4030-7910`"
    )
    assert "k8s status omitted" in out
    assert "Codex thread" not in out


def test_slack_thread_key_destination_pulls_channel():
    assert SLACK_PLATFORM.thread_key_destination("slack:C123:1700.0001") == "C123"
    assert SLACK_PLATFORM.thread_key_destination("slack:T1:C123:1700.0001") == "C123"
    assert SLACK_PLATFORM.thread_key_destination("dev:nothing") is None


def test_dev_platform_is_noop():
    dev = PLATFORMS["dev"]
    assert dev.sanitize_text("hello {with} json") == "hello {with} json"
    assert dev.system_prompt_rules(user_id="U1") == []
    assert dev.system_prompt_identity_lines({"x": "y"}) == []
    assert dev.thread_key_destination("slack:C1:1700.0001") is None


def test_slack_system_prompt_rules_mentions_requester_when_user_id_present():
    rules_with_user = SLACK_PLATFORM.system_prompt_rules(user_id="U999")
    rules_without_user = SLACK_PLATFORM.system_prompt_rules()
    assert any("U999" in line for line in rules_with_user)
    assert not any("U999" in line for line in rules_without_user)


def test_slack_identity_lines_branch_on_verified():
    verified = SLACK_PLATFORM.system_prompt_identity_lines(
        {
            "slack_user_id": "U1",
            "slack_mention": "<@U1>",
            "github_handle": "@octocat",
            "github_handle_source": "Slack profile custom field",
            "github_handle_verified": True,
        }
    )
    assert any("@octocat" in line for line in verified)
    assert any("verified: yes" in line for line in verified)

    unverified = SLACK_PLATFORM.system_prompt_identity_lines(
        {
            "slack_user_id": "U2",
            "slack_mention": "<@U2>",
            "github_handle_verified": False,
            "github_handle_unavailable_reason": "no GitHub field",
        }
    )
    assert any("unavailable" in line for line in unverified)
    assert any("verified: no" in line for line in unverified)


@pytest.mark.asyncio
async def test_base_send_channel_message_raises_for_unimplemented_platforms():
    base = MessagingPlatform()
    base.name = "stub"
    with pytest.raises(NotImplementedError):
        await base.send_channel_message("c", "t")
