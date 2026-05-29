from __future__ import annotations

import os


_DEFAULT_HARNESS_ALIASES: dict[str, str] = {
    "amp": "amp",
    "claude": "claude-code",
    "claude-code": "claude-code",
    "codex": "codex",
    "pi": "pi-mono",
    "pi-mono": "pi-mono",
}


def default_harness() -> str:
    raw = (os.getenv("CENTAUR_DEFAULT_HARNESS") or "codex").strip().lower()
    return _DEFAULT_HARNESS_ALIASES.get(raw, "codex")


def default_persona() -> str | None:
    """Deployment-wide default persona for spawns that select none.

    The persona analogue of ``CENTAUR_DEFAULT_HARNESS``. The value is a persona
    name (a persona directory/``pyproject.toml`` ``type = "persona"`` entry,
    matched case-sensitively, as personas are keyed by directory name). When
    unset (the default) there is no default overlay and bare spawns run under
    the base system prompt — preserving today's behavior.
    """
    return (os.getenv("CENTAUR_DEFAULT_PERSONA") or "").strip() or None
