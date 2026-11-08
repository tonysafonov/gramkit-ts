"""Infrastructure setup, as in the templates' `setup_infrastructure()` (logging, Logfire, PostHog).

No i18n, broadcast keyboards or admin metrics: Conduit has no bot or admin area.
"""

from core.infrastructure.config import settings
from core.infrastructure.logfire import setup_logfire
from core.infrastructure.logging import setup_logging
from core.infrastructure.posthog import setup_posthog
from core.infrastructure.redis import RedisClient

redis_client = RedisClient(settings.redis)


def setup_infrastructure() -> None:
    setup_logging()
    setup_logfire(settings.observability.logfire_token, settings.observability.logfire_environment)
    setup_posthog(settings.observability.posthog_api_key, settings.observability.posthog_host)
