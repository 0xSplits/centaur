import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from client import DiscordClient


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


def _stub_channel(client, monkeypatch, calls):
    async def thread_send(content):
        calls.setdefault("sent", []).append(content)

    thread = SimpleNamespace(
        id=99,
        name="design chat",
        parent_id=11,
        owner_id=5,
        archived=False,
        guild=SimpleNamespace(id=1),
        type=SimpleNamespace(name="public_thread"),
        jump_url="https://discord.com/channels/1/99",
        send=thread_send,
    )

    class FakeChannel:
        id = 11

        async def fetch_message(self, message_id):
            calls["fetched"] = message_id
            return SimpleNamespace(id=message_id)

        async def create_thread(self, **kwargs):
            calls["create"] = kwargs
            return thread

    monkeypatch.setattr(client, "_find_channel", lambda discord_client, name: FakeChannel())

    async def fake_with_client(action):
        return await action(object())

    monkeypatch.setattr(client, "_with_client", fake_with_client)


def test_create_thread_from_message_branches_off_starter(monkeypatch):
    client = DiscordClient(token="unused")
    calls = {}
    _stub_channel(client, monkeypatch, calls)

    result = client.create_thread("general", "design chat", from_message_id="123")

    assert calls["fetched"] == 123
    assert calls["create"]["message"].id == 123
    assert "type" not in calls["create"]
    assert "sent" not in calls
    assert result == {
        "id": "99",
        "name": "design chat",
        "parent_id": "11",
        "guild_id": "1",
        "owner_id": "5",
        "type": "public_thread",
        "archived": False,
        "url": "https://discord.com/channels/1/99",
    }


def test_create_thread_standalone_posts_initial_content(monkeypatch):
    import discord

    client = DiscordClient(token="unused")
    calls = {}
    _stub_channel(client, monkeypatch, calls)

    result = client.create_thread("general", "design chat", content="kickoff", private=True)

    assert calls["create"]["type"] == discord.ChannelType.private_thread
    assert "message" not in calls["create"]
    assert calls["sent"] == ["kickoff"]
    assert result["id"] == "99"
