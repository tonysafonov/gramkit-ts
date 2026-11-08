import os

from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from core.infrastructure.config import DatabaseSettings

# Fix step 3: a bounded pool. gramkit ships pool_size=20 + max_overflow=200 per engine and per worker (and the
# template's request engine sits next to create_api's own), so under load the workers open more connections
# than Postgres allows (max_connections = 100) and requests fail with "too many clients". Here: DB_POOL_SIZE
# per worker (default 10, the reference's 10 per core with one worker per core), no overflow; extra requests
# wait for a connection instead of failing.
POOL_SIZE = int(os.getenv("DB_POOL_SIZE", "10"))


def create_engine(db: DatabaseSettings, echo=False):
    engine = create_async_engine(
        db.url,
        query_cache_size=1200,
        pool_size=POOL_SIZE,
        max_overflow=0,
        pool_timeout=30,
        pool_recycle=1800,
        pool_pre_ping=True,
        future=True,
        echo=echo,
    )
    return engine


def create_session_pool(engine):
    session_pool = async_sessionmaker(bind=engine, expire_on_commit=False)
    return session_pool
