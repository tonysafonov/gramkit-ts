from collections.abc import Sequence

from sqlalchemy import BigInteger, RowMapping, Text, delete, literal, select
from sqlalchemy.dialects.postgresql import insert

from app.infrastructure.database.models import Article, Comment, User
from app.infrastructure.database.repo.users import following_expr
from core.infrastructure.database.repo.base import BaseRepo

COMMENTS_CAP = 100


class CommentRepo(BaseRepo[Comment]):
    def __init__(self, session):
        super().__init__(session)
        self.model_type = Comment

    async def list_for_article(self, viewer: int, article_id: int) -> Sequence[RowMapping]:
        stmt = (
            select(
                Comment.id,
                Comment.body,
                Comment.created_at,
                Comment.updated_at,
                User.username,
                User.bio,
                User.image,
                following_expr(viewer, Comment.author_id).label("following"),
            )
            .join(User, User.id == Comment.author_id)
            .where(Comment.article_id == article_id)
            .order_by(Comment.created_at.desc(), Comment.id.desc())
            .limit(COMMENTS_CAP)
        )
        return (await self.session.execute(stmt)).mappings().all()

    async def create(self, article_id: int, author_id: int, body: str) -> RowMapping:
        c = (
            insert(Comment)
            .values(
                article_id=literal(article_id, BigInteger),
                author_id=literal(author_id, BigInteger),
                body=literal(body, Text),
            )
            .returning(Comment.id, Comment.body, Comment.created_at, Comment.updated_at, Comment.author_id)
            .cte("c")
        )
        stmt = select(c.c.id, c.c.body, c.c.created_at, c.c.updated_at, User.username, User.bio, User.image).join(
            User, User.id == c.c.author_id
        )
        return (await self.session.execute(stmt)).mappings().one()

    async def get_author_id(self, comment_id: int, slug: str) -> int | None:
        stmt = (
            select(Comment.author_id)
            .join(Article, Article.id == Comment.article_id)
            .where(Comment.id == comment_id, Article.slug == slug)
        )
        return (await self.session.execute(stmt)).scalar_one_or_none()

    async def delete(self, comment_id: int) -> None:
        await self.session.execute(delete(Comment).where(Comment.id == comment_id))
