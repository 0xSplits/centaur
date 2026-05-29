from __future__ import annotations


def test_default_harness_defaults_to_codex(monkeypatch):
    from api.harness_config import default_harness

    monkeypatch.delenv("CENTAUR_DEFAULT_HARNESS", raising=False)

    assert default_harness() == "codex"


def test_default_harness_supports_aliases(monkeypatch):
    from api.harness_config import default_harness

    monkeypatch.setenv("CENTAUR_DEFAULT_HARNESS", "claude")
    assert default_harness() == "claude-code"

    monkeypatch.setenv("CENTAUR_DEFAULT_HARNESS", "pi")
    assert default_harness() == "pi-mono"


def test_default_harness_ignores_unknown_values(monkeypatch):
    from api.harness_config import default_harness

    monkeypatch.setenv("CENTAUR_DEFAULT_HARNESS", "unknown")

    assert default_harness() == "codex"


def test_default_persona_unset_is_none(monkeypatch):
    from api.harness_config import default_persona

    monkeypatch.delenv("CENTAUR_DEFAULT_PERSONA", raising=False)

    assert default_persona() is None


def test_default_persona_blank_is_none(monkeypatch):
    from api.harness_config import default_persona

    monkeypatch.setenv("CENTAUR_DEFAULT_PERSONA", "   ")

    assert default_persona() is None


def test_default_persona_returns_name(monkeypatch):
    from api.harness_config import default_persona

    monkeypatch.setenv("CENTAUR_DEFAULT_PERSONA", "  eng  ")

    assert default_persona() == "eng"
