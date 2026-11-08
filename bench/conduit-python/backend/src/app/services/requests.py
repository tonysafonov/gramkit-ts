"""Service aggregator, composed like the templates' `RequestsService` (core services via `self._core`)."""

from functools import cached_property

from aiogram import Bot
from arq import ArqRedis

from app.infrastructure.database.repo.requests import RequestsRepo
from app.services.conduit import ArticlesService, CommentsService, ConduitUsersService
from core.services.requests import CoreRequestsService


class RequestsService:
    def __init__(
        self,
        repo: RequestsRepo,
        producer=None,
        bot: Bot | None = None,
        redis=None,
        arq: ArqRedis | None = None,
    ):
        self.repo = repo
        self.producer = producer
        self.bot = bot
        self.redis = redis
        self.arq = arq
        self._core = CoreRequestsService(repo=repo._core, producer=producer, bot=bot, redis=redis, arq=arq)

    @cached_property
    def conduit_users(self) -> ConduitUsersService:
        return ConduitUsersService(self.repo, self.producer, self, self.bot)

    @cached_property
    def articles(self) -> ArticlesService:
        return ArticlesService(self.repo, self.producer, self, self.bot)

    @cached_property
    def comments(self) -> CommentsService:
        return CommentsService(self.repo, self.producer, self, self.bot)
