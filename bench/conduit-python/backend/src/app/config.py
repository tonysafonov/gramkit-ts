"""Conduit benchmark app configuration (gramkit `Settings`, same components as the templates).

The benchmark box passes `DATABASE_URL`, `JWT_SECRET`, `HOST` and `PORT` (Arjay's multicore challenge,
SPEC.md "Runtime contract"); `DATABASE_URL` is split into the `db` component here. Everything else keeps
the gramkit defaults, so the app runs as a template app would.
"""

import os
from urllib.parse import unquote, urlsplit

from pydantic_settings import BaseSettings, SettingsConfigDict

from core.infrastructure.config import (
    BotSettings,
    DatabaseSettings,
    EmailSettings,
    ObservabilitySettings,
    OpenAISettings,
    PaymentSettings,
    RabbitSettings,
    RBACSettings,
    RedisSettings,
    SessionSettings,
    WebSettings,
)


def _db_from_url(url: str, base: DatabaseSettings) -> DatabaseSettings:
    """The connection from DATABASE_URL; the pool size (DB__POOL_SIZE / DB__MAX_OVERFLOW) stays from `base`."""
    parts = urlsplit(url)
    return base.model_copy(update=dict(
        host=parts.hostname or "localhost",
        port=parts.port or 5432,
        user=unquote(parts.username or "postgres"),
        password=unquote(parts.password or ""),
        name=parts.path.lstrip("/") or "conduit",
    ))


class Settings(BaseSettings):
    model_config = SettingsConfigDict(extra="ignore", env_nested_delimiter="__")

    app_name: str = "conduit"
    debug: bool = False
    debug_username: str = ""

    db: DatabaseSettings = DatabaseSettings()
    redis: RedisSettings = RedisSettings()
    rabbit: RabbitSettings = RabbitSettings()
    session: SessionSettings = SessionSettings()
    # A template app has a bot token, so create_api's lifespan opens one aiogram Bot per process with it
    # (core.infrastructure.fastapi.clients). A well-formed placeholder keeps that the same here; nothing is
    # ever sent with it.
    bot: BotSettings = BotSettings(token="123456789:conduit-bench-placeholder-token")
    web: WebSettings = WebSettings(frontend_url="http://localhost")
    payment: PaymentSettings = PaymentSettings()
    email: EmailSettings = EmailSettings()
    openai: OpenAISettings = OpenAISettings()
    observability: ObservabilitySettings = ObservabilitySettings()
    rbac: RBACSettings = RBACSettings()

    jwt_secret: str = "dev-secret"

    def model_post_init(self, __context) -> None:
        object.__setattr__(self.session, "cookie_name", f"{self.app_name}_session")
        object.__setattr__(self.session, "key_prefix", f"{self.app_name}:session:")
        if url := os.getenv("DATABASE_URL"):
            object.__setattr__(self, "db", _db_from_url(url, self.db))


settings = Settings()
