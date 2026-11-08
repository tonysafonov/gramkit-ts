"""Articles, tags on articles and favorites: SPEC.md's reference SQL, built with SQLAlchemy."""

from collections.abc import Sequence

from sqlalchemy import (
    BigInteger,
    RowMapping,
    Select,
    Text,
    any_,
    cast,
    delete,
    exists,
    func,
    literal,
    select,
    true,
    update,
)
from sqlalchemy.dialects.postgresql import ARRAY, insert
from sqlalchemy.orm import aliased

from app.infrastructure.database.models import Article, ArticleTag, Favorite, Follow, Tag, User
from app.infrastructure.database.repo.users import following_expr
from core.infrastructure.database.repo.base import BaseRepo

COUNT_CAP = 1000


def slugify(title):
    """SPEC.md SLUGIFY: trim(both '-' from lower(regexp_replace(x, '[^A-Za-z0-9]+', '-', 'g')))."""
    return func.btrim(func.lower(func.regexp_replace(title, "[^A-Za-z0-9]+", "-", "g")), "-")


def article_select(viewer: int, with_body: bool) -> Select:
    """ARTICLE_LIST_SELECT (ARTICLE_FULL_SELECT with the body)."""
    tag_list = func.array(
        select(Tag.name)
        .join(ArticleTag, ArticleTag.tag_id == Tag.id)
        .where(ArticleTag.article_id == Article.id)
        .order_by(Tag.name)
        .scalar_subquery()
    )
    favorites_count = select(func.count()).select_from(Favorite).where(Favorite.article_id == Article.id)
    favorited = exists().where(Favorite.article_id == Article.id, Favorite.user_id == viewer)
    columns = [Article.id, Article.slug, Article.title, Article.description]
    if with_body:
        columns.append(Article.body)
    columns += [
        Article.created_at,
        Article.updated_at,
        tag_list.label("tag_list"),
        favorites_count.scalar_subquery().label("favorites_count"),
        favorited.label("favorited"),
        User.username,
        User.bio,
        User.image,
        following_expr(viewer, Article.author_id).label("following"),
    ]
    return select(*columns).select_from(Article).join(User, User.id == Article.author_id)


def _capped_count(inner: Select) -> Select:
    return select(func.count()).select_from(inner.limit(COUNT_CAP).subquery())


def _tag_id(tag: str):
    return select(Tag.id).where(Tag.name == tag).scalar_subquery()


def _user_id(username: str):
    u = aliased(User)
    return select(u.id).where(u.username == username).scalar_subquery()


class ArticleRepo(BaseRepo[Article]):
    def __init__(self, session):
        super().__init__(session)
        self.model_type = Article

    async def _page(self, page: Select, count: Select) -> tuple[Sequence[RowMapping], int]:
        rows = (await self.session.execute(page)).mappings().all()
        total = (await self.session.execute(count)).scalar_one()
        return rows, total

    async def list_all(self, viewer: int, limit: int, offset: int):
        page = article_select(viewer, False).order_by(Article.id.desc()).limit(limit).offset(offset)
        return await self._page(page, _capped_count(select(literal(1)).select_from(Article)))

    async def list_by_tag(self, viewer: int, limit: int, offset: int, tag: str):
        ids = (
            select(ArticleTag.article_id)
            .where(ArticleTag.tag_id == _tag_id(tag))
            .order_by(ArticleTag.article_id.desc())
            .limit(limit)
            .offset(offset)
        )
        page = article_select(viewer, False).where(Article.id.in_(ids)).order_by(Article.id.desc())
        count = _capped_count(select(literal(1)).select_from(ArticleTag).where(ArticleTag.tag_id == _tag_id(tag)))
        return await self._page(page, count)

    async def list_by_author(self, viewer: int, limit: int, offset: int, author: str):
        page = (
            article_select(viewer, False)
            .where(Article.author_id == _user_id(author))
            .order_by(Article.id.desc())
            .limit(limit)
            .offset(offset)
        )
        count = _capped_count(select(literal(1)).select_from(Article).where(Article.author_id == _user_id(author)))
        return await self._page(page, count)

    async def list_favorited_by(self, viewer: int, limit: int, offset: int, username: str):
        ids = (
            select(Favorite.article_id)
            .where(Favorite.user_id == _user_id(username))
            .order_by(Favorite.article_id.desc())
            .limit(limit)
            .offset(offset)
        )
        page = article_select(viewer, False).where(Article.id.in_(ids)).order_by(Article.id.desc())
        count = _capped_count(select(literal(1)).select_from(Favorite).where(Favorite.user_id == _user_id(username)))
        return await self._page(page, count)

    async def feed(self, viewer: int, limit: int, offset: int):
        a2 = aliased(Article)
        latest = (
            select(a2.id)
            .where(a2.author_id == Follow.followee_id)
            .order_by(a2.id.desc())
            .limit(literal(limit, BigInteger) + literal(offset, BigInteger))
            .lateral("x")
        )
        ids = (
            select(latest.c.id)
            .select_from(Follow)
            .join(latest, true())
            .where(Follow.follower_id == viewer)
            .order_by(latest.c.id.desc())
            .limit(limit)
            .offset(offset)
        )
        page = article_select(viewer, False).where(Article.id.in_(ids)).order_by(Article.id.desc())
        followees = select(Follow.followee_id).where(Follow.follower_id == viewer)
        count = _capped_count(select(literal(1)).select_from(Article).where(Article.author_id.in_(followees)))
        return await self._page(page, count)

    async def get_full_by_slug(self, viewer: int, slug: str) -> RowMapping | None:
        stmt = article_select(viewer, True).where(Article.slug == slug)
        return (await self.session.execute(stmt)).mappings().one_or_none()

    async def get_full_by_id(self, viewer: int, article_id: int) -> RowMapping | None:
        stmt = article_select(viewer, True).where(Article.id == article_id)
        return (await self.session.execute(stmt)).mappings().one_or_none()

    async def get_id_by_slug(self, slug: str) -> int | None:
        return (await self.session.execute(select(Article.id).where(Article.slug == slug))).scalar_one_or_none()

    async def get_owner(self, slug: str) -> RowMapping | None:
        stmt = select(Article.id, Article.author_id).where(Article.slug == slug)
        return (await self.session.execute(stmt)).mappings().one_or_none()

    async def create(self, author_id: int, title: str, description: str, body: str) -> int:
        n = select(func.nextval(func.pg_get_serial_sequence("articles", "id")).label("id")).subquery("n")
        title_param = literal(title, Text)
        source = select(
            n.c.id,
            slugify(title_param) + "-" + cast(n.c.id, Text),
            literal(author_id, BigInteger),
            title_param,
            literal(description, Text),
            literal(body, Text),
        )
        stmt = (
            insert(Article)
            .from_select(["id", "slug", "author_id", "title", "description", "body"], source)
            .returning(Article.id)
        )
        return (await self.session.execute(stmt)).scalar_one()

    async def add_tags(self, article_id: int, tags: list[str]) -> None:
        names = literal(tags, ARRAY(Text))
        await self.session.execute(
            insert(Tag)
            .from_select(["name"], select(func.unnest(names)).distinct())
            .on_conflict_do_nothing(index_elements=["name"])
        )
        await self.session.execute(
            insert(ArticleTag).from_select(
                ["article_id", "tag_id"],
                select(literal(article_id, BigInteger), Tag.id).where(Tag.name == any_(names)),
            )
        )

    async def update_fields(self, article_id: int, title: str | None, description: str | None, body: str | None):
        title_param = literal(title, Text)
        stmt = (
            update(Article)
            .where(Article.id == article_id)
            .values(
                title=func.coalesce(title_param, Article.title),
                description=func.coalesce(literal(description, Text), Article.description),
                body=func.coalesce(literal(body, Text), Article.body),
                slug=Article.slug if title is None else slugify(title_param) + "-" + cast(Article.id, Text),
                updated_at=func.now(),
            )
        )
        await self.session.execute(stmt)

    async def delete(self, article_id: int) -> None:
        await self.session.execute(delete(Article).where(Article.id == article_id))

    async def favorite(self, user_id: int, article_id: int) -> None:
        stmt = insert(Favorite).values(user_id=user_id, article_id=article_id).on_conflict_do_nothing()
        await self.session.execute(stmt)

    async def unfavorite(self, user_id: int, article_id: int) -> None:
        await self.session.execute(
            delete(Favorite).where(Favorite.user_id == user_id, Favorite.article_id == article_id)
        )
