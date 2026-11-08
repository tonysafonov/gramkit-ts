"""ORM models over the challenge's fixed schema (multicore-server-challenge `schema.sql`).

The schema is created by the challenge's seed, never by us: no migrations. A separate declarative base keeps
these tables (`users` among them) out of core's metadata.
"""

from datetime import datetime

from sqlalchemy import BigInteger, ForeignKey, Integer, Text
from sqlalchemy.dialects.postgresql import TIMESTAMP
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column
from sqlalchemy.sql.functions import func


class ConduitBase(DeclarativeBase):
    pass


class User(ConduitBase):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    username: Mapped[str] = mapped_column(Text, unique=True)
    email: Mapped[str] = mapped_column(Text, unique=True)
    password_hash: Mapped[str] = mapped_column(Text)
    bio: Mapped[str | None] = mapped_column(Text)
    image: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(TIMESTAMP(timezone=True), server_default=func.now())


class Follow(ConduitBase):
    __tablename__ = "follows"

    follower_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("users.id"), primary_key=True)
    followee_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("users.id"), primary_key=True)
    created_at: Mapped[datetime] = mapped_column(TIMESTAMP(timezone=True), server_default=func.now())


class Article(ConduitBase):
    __tablename__ = "articles"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    slug: Mapped[str] = mapped_column(Text, unique=True)
    author_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("users.id"))
    title: Mapped[str] = mapped_column(Text)
    description: Mapped[str] = mapped_column(Text)
    body: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(TIMESTAMP(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(TIMESTAMP(timezone=True), server_default=func.now())


class Tag(ConduitBase):
    __tablename__ = "tags"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(Text, unique=True)


class ArticleTag(ConduitBase):
    __tablename__ = "article_tags"

    article_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("articles.id"), primary_key=True)
    tag_id: Mapped[int] = mapped_column(Integer, ForeignKey("tags.id"), primary_key=True)


class Favorite(ConduitBase):
    __tablename__ = "favorites"

    user_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("users.id"), primary_key=True)
    article_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("articles.id"), primary_key=True)
    created_at: Mapped[datetime] = mapped_column(TIMESTAMP(timezone=True), server_default=func.now())


class Comment(ConduitBase):
    __tablename__ = "comments"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    article_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("articles.id"))
    author_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("users.id"))
    body: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(TIMESTAMP(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(TIMESTAMP(timezone=True), server_default=func.now())
