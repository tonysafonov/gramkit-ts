"""Conduit services: users/auth, profiles, articles, favorites, comments, tags.

Services take and return plain values and schemas, raise `app.exceptions` errors, and only flush (the
request's `get_repo` transaction commits), as everywhere in gramkit.
"""

import time
from collections.abc import Sequence

import bcrypt
import jwt
from sqlalchemy import RowMapping
from sqlalchemy.exc import IntegrityError
from starlette.concurrency import run_in_threadpool

from app.exceptions import ForbiddenError, NotFoundError, UnauthorizedError, UnprocessableError
from app.schemas import (
    ArticleListItemOut,
    ArticleOut,
    ArticlesResponse,
    CommentOut,
    NewArticle,
    ProfileOut,
    UpdateArticle,
    UpdateUser,
    UserOut,
    iso,
)
from core.infrastructure.config import settings
from core.services.base import BaseService

TOKEN_TTL_S = 30 * 24 * 3600
BCRYPT_COST = 10


def new_token(user_id: int) -> str:
    now = int(time.time())
    return jwt.encode({"sub": str(user_id), "iat": now, "exp": now + TOKEN_TTL_S}, settings.jwt_secret, "HS256")


def _hash_password(password: str) -> str:
    try:
        return bcrypt.hashpw(password.encode(), bcrypt.gensalt(BCRYPT_COST)).decode()
    except ValueError:  # bcrypt 5 rejects passwords over 72 bytes
        raise UnprocessableError("password is too long")


def _check_password(password: str, password_hash: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode(), password_hash.encode())
    except ValueError:
        return False


def _user(row: RowMapping, token: str) -> UserOut:
    return UserOut(email=row["email"], token=token, username=row["username"], bio=row["bio"], image=row["image"])


def _profile(row: RowMapping, following: bool) -> ProfileOut:
    return ProfileOut(username=row["username"], bio=row["bio"], image=row["image"], following=following)


def _article_fields(row: RowMapping) -> dict:
    return {
        "slug": row["slug"],
        "title": row["title"],
        "description": row["description"],
        "tagList": row["tag_list"],
        "createdAt": iso(row["created_at"]),
        "updatedAt": iso(row["updated_at"]),
        "favorited": row["favorited"],
        "favoritesCount": row["favorites_count"],
        "author": _profile(row, row["following"]),
    }


def _article(row: RowMapping) -> ArticleOut:
    return ArticleOut(body=row["body"], **_article_fields(row))


def _comment(row: RowMapping, following: bool) -> CommentOut:
    return CommentOut(
        id=row["id"],
        createdAt=iso(row["created_at"]),
        updatedAt=iso(row["updated_at"]),
        body=row["body"],
        author=_profile(row, following),
    )


class ConduitUsersService(BaseService):
    async def register(self, username: str, email: str, password: str) -> UserOut:
        password_hash = await run_in_threadpool(_hash_password, password)
        try:
            row = await self.repo.conduit_users.create(username, email, password_hash)
        except IntegrityError:
            raise UnprocessableError("username or email already taken")
        return _user(row, new_token(row["id"]))

    async def login(self, email: str, password: str) -> UserOut:
        row = await self.repo.conduit_users.get_for_login(email)
        if row is None or not await run_in_threadpool(_check_password, password, row["password_hash"]):
            raise UnauthorizedError("invalid email or password")
        return _user(row, new_token(row["id"]))

    async def current(self, user_id: int, token: str) -> UserOut:
        row = await self.repo.conduit_users.get_row(user_id)
        if row is None:
            raise UnauthorizedError("user not found")
        return _user(row, token)

    async def update(self, user_id: int, token: str, data: UpdateUser) -> UserOut:
        password_hash = None
        if data.password is not None:
            password_hash = await run_in_threadpool(_hash_password, data.password)
        try:
            row = await self.repo.conduit_users.update_fields(
                user_id, data.email, data.username, password_hash, data.bio, data.image
            )
        except IntegrityError:
            raise UnprocessableError("username or email already taken")
        if row is None:
            raise UnauthorizedError("user not found")
        return _user(row, token)

    async def profile(self, viewer: int, username: str) -> ProfileOut:
        row = await self.repo.conduit_users.get_profile(viewer, username)
        if row is None:
            raise NotFoundError("profile not found")
        return _profile(row, row["following"])

    async def set_follow(self, viewer: int, username: str, follow: bool) -> ProfileOut:
        row = await self.repo.conduit_users.get_by_username(username)
        if row is None:
            raise NotFoundError("profile not found")
        if follow:
            await self.repo.conduit_users.follow(viewer, row["id"])
        else:
            await self.repo.conduit_users.unfollow(viewer, row["id"])
        return _profile(row, follow)


class ArticlesService(BaseService):
    @staticmethod
    def _page(result: tuple[Sequence[RowMapping], int]) -> ArticlesResponse:
        rows, total = result
        return ArticlesResponse(articles=[ArticleListItemOut(**_article_fields(r)) for r in rows], articlesCount=total)

    async def list(
        self, viewer: int, limit: int, offset: int, tag: str, author: str, favorited: str
    ) -> ArticlesResponse:
        # Only the first non-empty filter applies, in the order tag, author, favorited.
        repo = self.repo.articles
        if tag:
            return self._page(await repo.list_by_tag(viewer, limit, offset, tag))
        if author:
            return self._page(await repo.list_by_author(viewer, limit, offset, author))
        if favorited:
            return self._page(await repo.list_favorited_by(viewer, limit, offset, favorited))
        return self._page(await repo.list_all(viewer, limit, offset))

    async def feed(self, viewer: int, limit: int, offset: int) -> ArticlesResponse:
        return self._page(await self.repo.articles.feed(viewer, limit, offset))

    async def get(self, viewer: int, slug: str) -> ArticleOut:
        row = await self.repo.articles.get_full_by_slug(viewer, slug)
        if row is None:
            raise NotFoundError("article not found")
        return _article(row)

    async def _full(self, viewer: int, article_id: int) -> ArticleOut:
        return _article(await self.repo.articles.get_full_by_id(viewer, article_id))

    async def create(self, viewer: int, data: NewArticle) -> ArticleOut:
        article_id = await self.repo.articles.create(viewer, data.title, data.description, data.body)
        if data.tagList:
            await self.repo.articles.add_tags(article_id, data.tagList)
        return await self._full(viewer, article_id)

    async def _owned_id(self, viewer: int, slug: str) -> int:
        row = await self.repo.articles.get_owner(slug)
        if row is None:
            raise NotFoundError("article not found")
        if row["author_id"] != viewer:
            raise ForbiddenError("not the author of this article")
        return row["id"]

    async def update(self, viewer: int, slug: str, data: UpdateArticle) -> ArticleOut:
        article_id = await self._owned_id(viewer, slug)
        await self.repo.articles.update_fields(article_id, data.title, data.description, data.body)
        return await self._full(viewer, article_id)

    async def delete(self, viewer: int, slug: str) -> None:
        await self.repo.articles.delete(await self._owned_id(viewer, slug))

    async def set_favorite(self, viewer: int, slug: str, favorite: bool) -> ArticleOut:
        article_id = await self.repo.articles.get_id_by_slug(slug)
        if article_id is None:
            raise NotFoundError("article not found")
        if favorite:
            await self.repo.articles.favorite(viewer, article_id)
        else:
            await self.repo.articles.unfavorite(viewer, article_id)
        return await self._full(viewer, article_id)

    async def tags(self) -> list[str]:
        return await self.repo.tags.all_names()


class CommentsService(BaseService):
    async def _article_id(self, slug: str) -> int:
        article_id = await self.repo.articles.get_id_by_slug(slug)
        if article_id is None:
            raise NotFoundError("article not found")
        return article_id

    async def list(self, viewer: int, slug: str) -> list[CommentOut]:
        article_id = await self._article_id(slug)
        rows = await self.repo.comments.list_for_article(viewer, article_id)
        return [_comment(r, r["following"]) for r in rows]

    async def add(self, viewer: int, slug: str, body: str) -> CommentOut:
        article_id = await self._article_id(slug)
        return _comment(await self.repo.comments.create(article_id, viewer, body), False)

    async def delete(self, viewer: int, slug: str, comment_id: int) -> None:
        author_id = await self.repo.comments.get_author_id(comment_id, slug)
        if author_id is None:
            raise NotFoundError("comment not found")
        if author_id != viewer:
            raise ForbiddenError("not the author of this comment")
        await self.repo.comments.delete(comment_id)
