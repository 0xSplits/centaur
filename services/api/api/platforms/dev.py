"""Dev platform: no-op everything. Used for localhost-bypass executions
and unit tests where no real messaging integration is wired up."""

from __future__ import annotations

from api.platforms import MessagingPlatform, register_platform


class DevPlatform(MessagingPlatform):
    name = "dev"


register_platform(DevPlatform())
