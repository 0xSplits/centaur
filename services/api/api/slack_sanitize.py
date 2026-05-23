"""Compatibility shim. The implementation moved to ``api.platforms.slack``;
this module remains so existing imports of ``sanitize_for_slack`` keep
working."""

from __future__ import annotations

from api.platforms.slack import sanitize_for_slack  # noqa: F401

__all__ = ["sanitize_for_slack"]
