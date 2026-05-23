"""Dev platform: no-op everything. Used for localhost-bypass executions
and unit tests where no real messaging integration is wired up.

Registration happens centrally via
``api.platforms.register_builtin_platforms``; importing this module
does not register on its own.
"""

from __future__ import annotations

from api.platforms import MessagingPlatform


class DevPlatform(MessagingPlatform):
    name = "dev"


DEV_PLATFORM = DevPlatform()
