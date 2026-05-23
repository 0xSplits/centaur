"""Compatibility shim. The implementation lives in ``api.platforms.slack``;
this module remains so existing imports of ``sanitize_for_slack`` keep
working. New callers should import from ``api.platforms.slack``
directly; this shim is scheduled for removal in a future cleanup PR.
"""

from __future__ import annotations

import warnings

from api.platforms.slack import sanitize_for_slack  # noqa: F401

warnings.warn(
    "api.slack_sanitize is a back-compat shim; "
    "import sanitize_for_slack from api.platforms.slack instead.",
    DeprecationWarning,
    stacklevel=2,
)

__all__ = ["sanitize_for_slack"]
