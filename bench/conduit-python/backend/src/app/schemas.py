"""Request bodies and response objects (SPEC.md "Formats"). Field names are the API's camelCase."""

from datetime import UTC, datetime
from typing import Annotated

from pydantic import BaseModel, Field

NonEmpty = Annotated[str, Field(min_length=1)]


def iso(ts: datetime) -> str:
    """RFC 3339 UTC with exactly 3 fractional digits (truncated) and 'Z'."""
    ts = ts.astimezone(UTC)
    return f"{ts:%Y-%m-%dT%H:%M:%S}.{ts.microsecond // 1000:03d}Z"


# ---------------------------------------------------------------- requests


class NewUser(BaseModel):
    username: NonEmpty
    email: NonEmpty
    password: NonEmpty


class NewUserBody(BaseModel):
    user: NewUser


class LoginUser(BaseModel):
    email: NonEmpty
    password: NonEmpty


class LoginBody(BaseModel):
    user: LoginUser


class UpdateUser(BaseModel):
    email: NonEmpty | None = None
    username: NonEmpty | None = None
    password: NonEmpty | None = None
    bio: str | None = None
    image: str | None = None


class UpdateUserBody(BaseModel):
    user: UpdateUser


class NewArticle(BaseModel):
    title: NonEmpty
    description: NonEmpty
    body: NonEmpty
    tagList: list[NonEmpty] | None = None  # noqa: N815 (API field name)


class NewArticleBody(BaseModel):
    article: NewArticle


class UpdateArticle(BaseModel):
    title: NonEmpty | None = None
    description: NonEmpty | None = None
    body: NonEmpty | None = None


class UpdateArticleBody(BaseModel):
    article: UpdateArticle


class NewComment(BaseModel):
    body: NonEmpty


class NewCommentBody(BaseModel):
    comment: NewComment


# ---------------------------------------------------------------- responses


class UserOut(BaseModel):
    email: str
    token: str
    username: str
    bio: str | None
    image: str | None


class UserResponse(BaseModel):
    user: UserOut


class ProfileOut(BaseModel):
    username: str
    bio: str | None
    image: str | None
    following: bool


class ProfileResponse(BaseModel):
    profile: ProfileOut


class ArticleListItemOut(BaseModel):
    slug: str
    title: str
    description: str
    tagList: list[str]  # noqa: N815
    createdAt: str  # noqa: N815
    updatedAt: str  # noqa: N815
    favorited: bool
    favoritesCount: int  # noqa: N815
    author: ProfileOut


class ArticleOut(ArticleListItemOut):
    body: str


class ArticleResponse(BaseModel):
    article: ArticleOut


class ArticlesResponse(BaseModel):
    articles: list[ArticleListItemOut]
    articlesCount: int  # noqa: N815


class CommentOut(BaseModel):
    id: int
    createdAt: str  # noqa: N815
    updatedAt: str  # noqa: N815
    body: str
    author: ProfileOut


class CommentResponse(BaseModel):
    comment: CommentOut


class CommentsResponse(BaseModel):
    comments: list[CommentOut]


class TagsResponse(BaseModel):
    tags: list[str]
