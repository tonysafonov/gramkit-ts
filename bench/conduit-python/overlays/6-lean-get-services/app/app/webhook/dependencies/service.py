# Fix step 6 (needs step 1's per-process get_bot / get_arq_pool): get_services resolves ONE FastAPI dependency,
# the request session. The Bot, arq pool, Redis client and RabbitMQ producer are per-process objects, so they
# are fetched by a plain call instead of four more Depends that FastAPI solves on every request.
from fastapi import Depends

from app.infrastructure.database.repo.requests import RequestsRepo
from app.services.requests import RequestsService
from app.webhook.dependencies.arq import get_arq_pool
from app.webhook.dependencies.bot import get_bot
from app.webhook.dependencies.database import get_repo
from app.webhook.dependencies.redis import redis_client
from core.infrastructure.config import settings
from core.infrastructure.rabbit.producer import RabbitMQProducer

_producer = RabbitMQProducer(settings.rabbit)


async def _services(repo: RequestsRepo) -> RequestsService:
    return RequestsService(repo, _producer, await get_bot(), redis_client, await get_arq_pool())


async def get_services(repo: RequestsRepo = Depends(get_repo, scope="function")) -> RequestsService:
    """The services for a request. The transaction commits before the response is sent."""
    return await _services(repo)


async def get_services_streaming(repo: RequestsRepo = Depends(get_repo, scope="request")) -> RequestsService:
    """The services for a streaming endpoint: the session stays open while the body streams."""
    return await _services(repo)
