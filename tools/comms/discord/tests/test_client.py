import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from client import DiscordClient


class _FakeStream:
    """Minimal stand-in for ``httpx.Client().stream(...)``'s response context."""

    def __init__(self, chunks, status_code=200):
        self._chunks = chunks
        self.status_code = status_code

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def iter_bytes(self):
        yield from self._chunks


def _fake_streaming_client(monkeypatch, chunks, *, status_code=200, expect_url=None):
    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def stream(self, method, url):
            assert method == "GET"
            if expect_url is not None:
                assert url == expect_url
            return _FakeStream(chunks, status_code=status_code)

    monkeypatch.setattr("client.httpx.Client", FakeClient)


def test_join_server_posts_invite_code(monkeypatch):
    client = DiscordClient(token="unused")

    def fake_request(method, endpoint, **kwargs):
        assert method == "POST"
        assert endpoint == "/invites/abc123"
        return {"code": "abc123", "guild": {"name": "Test"}}

    monkeypatch.setattr(client, "_request", fake_request)

    assert client.join_server("https://discord.gg/abc123")["guild"]["name"] == "Test"


def test_find_guild_exact_then_partial_name():
    client = DiscordClient(token="unused")
    discord_client = SimpleNamespace(
        guilds=[
            SimpleNamespace(id=1, name="General"),
            SimpleNamespace(id=2, name="Eth R&D"),
        ],
        get_guild=lambda guild_id: None,
    )

    assert client._find_guild(discord_client, "Eth R&D").id == 2
    assert client._find_guild(discord_client, "eth").id == 2


def test_find_channel_supports_hash_prefix_and_partial_name():
    client = DiscordClient(token="unused")
    channel = SimpleNamespace(id=11, name="announcements")
    discord_client = SimpleNamespace(
        guilds=[SimpleNamespace(text_channels=[channel])],
        get_channel=lambda channel_id: None,
    )

    assert client._find_channel(discord_client, "#announcements").id == 11
    assert client._find_channel(discord_client, "announce").id == 11


def test_format_message_surfaces_attachments():
    client = DiscordClient(token="unused")
    msg = SimpleNamespace(
        id=99,
        channel=SimpleNamespace(id=11, name="general"),
        author=SimpleNamespace(id=7, display_name="Ada"),
        created_at=SimpleNamespace(isoformat=lambda: "2026-01-01T00:00:00"),
        content="see file",
        reference=None,
        attachments=[
            SimpleNamespace(
                id=123,
                filename="report.pdf",
                url="https://cdn.discordapp.com/attachments/11/123/report.pdf",
                size=2048,
                content_type="application/pdf",
            )
        ],
    )

    formatted = client._format_message(msg)
    assert formatted["attachments"] == [
        {
            "id": "123",
            "filename": "report.pdf",
            "url": "https://cdn.discordapp.com/attachments/11/123/report.pdf",
            "size": 2048,
            "content_type": "application/pdf",
        }
    ]


def test_format_message_handles_no_attachments():
    client = DiscordClient(token="unused")
    msg = SimpleNamespace(
        id=99,
        channel=SimpleNamespace(id=11, name="general"),
        author=SimpleNamespace(id=7, display_name="Ada"),
        created_at=SimpleNamespace(isoformat=lambda: "2026-01-01T00:00:00"),
        content="hi",
        reference=None,
        attachments=[],
    )

    assert client._format_message(msg)["attachments"] == []


def test_upload_file_rejects_missing_path(tmp_path):
    client = DiscordClient(token="unused")
    missing = tmp_path / "nope.txt"

    try:
        client.upload_file("general", str(missing))
    except FileNotFoundError as exc:
        assert "nope.txt" in str(exc)
    else:
        raise AssertionError("expected FileNotFoundError for a missing upload path")


def test_download_url_streams_cdn_file(monkeypatch, tmp_path):
    client = DiscordClient(token="unused")
    url = "https://cdn.discordapp.com/attachments/11/123/report.pdf"
    _fake_streaming_client(monkeypatch, [b"hello-", b"bytes"], expect_url=url)

    result = client.download_url(url, output_dir=str(tmp_path))

    saved = tmp_path / "report.pdf"
    assert saved.read_bytes() == b"hello-bytes"
    assert result == {"path": str(saved), "size": 11, "url": url}


def test_download_url_rejects_non_cdn_host(tmp_path):
    client = DiscordClient(token="unused")

    with pytest.raises(ValueError, match="Discord CDN"):
        client.download_url("http://api:8000/internal/secrets", output_dir=str(tmp_path))

    # The guard fires before any network or filesystem work.
    assert list(tmp_path.iterdir()) == []


def test_download_url_rejects_oversized_response(monkeypatch, tmp_path):
    client = DiscordClient(token="unused")
    client._MAX_DOWNLOAD_BYTES = 4  # tighten the cap so two chunks trips it
    url = "https://cdn.discordapp.com/attachments/11/123/big.bin"
    _fake_streaming_client(monkeypatch, [b"aaaa", b"bbbb"], expect_url=url)

    with pytest.raises(ValueError, match="download limit"):
        client.download_url(url, output_dir=str(tmp_path))

    # The partially-written file is cleaned up.
    assert not (tmp_path / "big.bin").exists()
