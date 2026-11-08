"""Conduit auth: `Authorization: Token <jwt>` (HS256, `sub` = user id), verified on every request.

The app-level counterpart of core's `get_user` (`core.infrastructure.fastapi.auth`), used only by Conduit's
own routes (it doesn't replace core's `get_user`): a dependency that every endpoint takes, logs the user at
DEBUG and sets the Sentry / request-log user, as core does per request.
"""

from dataclasses import dataclass
from typing import Annotated

import jwt
from fastapi import Depends, Request

from app.exceptions import UnauthorizedError
from core.infrastructure.config import settings
from core.infrastructure.logging import get_logger
from core.infrastructure.sentry_context import set_sentry_user

logger = get_logger(__name__)

INT64_MAX = 2**63 - 1


@dataclass(slots=True, frozen=True)
class Viewer:
    user_id: int  # 0 = anonymous
    token: str | None


ANONYMOUS = Viewer(0, None)


def parse_uint(s: str) -> int | None:
    """ASCII digits only (no sign, spaces or '_'), fitting a bigint; else None."""
    if not s or not s.isascii() or not s.isdigit():
        return None
    n = int(s)
    return n if n <= INT64_MAX else None


def _parse_authorization(header: str) -> Viewer:
    if not header.startswith("Token "):
        raise UnauthorizedError("invalid authorization header")
    token = header[6:]
    try:
        claims = jwt.decode(
            token,
            settings.jwt_secret,
            algorithms=["HS256"],
            options={"require": ["exp", "sub"], "verify_iat": False},
        )
    except jwt.PyJWTError:
        raise UnauthorizedError("invalid or expired token")
    sub = claims["sub"]
    user_id = parse_uint(sub) if isinstance(sub, str) else None
    if not user_id:
        raise UnauthorizedError("invalid token subject")
    logger.debug("Conduit user %s authenticated", user_id)  # as core's get_user: the access-log line carries the user
    set_sentry_user(user_id=str(user_id), username=None, email=None, tg_username=None)
    return Viewer(user_id, token)


async def get_viewer_required(request: Request) -> Viewer:
    header = request.headers.get("authorization")
    if not header:
        raise UnauthorizedError("authorization required")
    return _parse_authorization(header)


async def get_viewer_optional(request: Request) -> Viewer:
    header = request.headers.get("authorization")
    if not header:  # an empty header counts as absent
        return ANONYMOUS
    return _parse_authorization(header)


AuthRequired = Annotated[Viewer, Depends(get_viewer_required)]
AuthOptional = Annotated[Viewer, Depends(get_viewer_optional)]
