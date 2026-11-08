# Fix step 1: one arq pool per process instead of create_pool() + close() (connect + PING) on every request.
from arq import create_pool
from arq.connections import ArqRedis, RedisSettings

from core.infrastructure.config import settings

_pool: ArqRedis | None = None


async def get_arq_pool() -> ArqRedis:
    global _pool
    if _pool is None:
        _pool = await create_pool(
            RedisSettings(host=settings.redis.host, port=settings.redis.port, password=settings.redis.password)
        )
    return _pool
