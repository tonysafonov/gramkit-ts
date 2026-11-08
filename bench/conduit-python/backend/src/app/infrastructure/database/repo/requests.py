"""Repository aggregator, composed like the templates' `RequestsRepo` (core repos via `self._core`)."""

from functools import cached_property

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.infrastructure.database.models import Tag
from app.infrastructure.database.repo.articles import ArticleRepo
from app.infrastructure.database.repo.comments import CommentRepo
from app.infrastructure.database.repo.users import UserRepo
from core.infrastructure.database.repo.base import BaseRepo
from core.infrastructure.database.repo.requests import CoreRequestsRepo


class TagRepo(BaseRepo[Tag]):
    def __init__(self, session):
        super().__init__(session)
        self.model_type = Tag

    async def all_names(self) -> list[str]:
        return list((await self.session.execute(select(Tag.name).order_by(Tag.name))).scalars().all())


class RequestsRepo:
    def __init__(self, session: AsyncSession):
        self.session = session
        self._core = CoreRequestsRepo(session)

    @cached_property
    def conduit_users(self) -> UserRepo:
        return UserRepo(self.session)

    @cached_property
    def articles(self) -> ArticleRepo:
        return ArticleRepo(self.session)

    @cached_property
    def comments(self) -> CommentRepo:
        return CommentRepo(self.session)

    @cached_property
    def tags(self) -> TagRepo:
        return TagRepo(self.session)
