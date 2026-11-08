"""The 19 Conduit endpoints (SPEC.md "Endpoints"). Thin: parse, call a service, wrap the result."""

from dataclasses import dataclass
from typing import Annotated

from fastapi import APIRouter, Depends, Request, Response

from app.exceptions import NotFoundError, UnprocessableError
from app.schemas import (
    ArticleResponse,
    ArticlesResponse,
    CommentResponse,
    CommentsResponse,
    LoginBody,
    NewArticleBody,
    NewCommentBody,
    NewUserBody,
    ProfileResponse,
    TagsResponse,
    UpdateArticleBody,
    UpdateUserBody,
    UserResponse,
)
from app.services.requests import RequestsService
from app.webhook.auth import AuthOptional, AuthRequired, parse_uint
from app.webhook.dependencies.service import get_services

router = APIRouter(prefix="/api")

Services = Annotated[RequestsService, Depends(get_services)]


@dataclass(slots=True, frozen=True)
class Page:
    limit: int
    offset: int


def get_page(request: Request) -> Page:
    """limit (default 20, 1-100) and offset (default 0, >= 0). A present parameter, even empty, must be
    valid; with repeats the first value counts."""
    q = request.query_params
    limit, offset = 20, 0
    if "limit" in q:
        limit = parse_uint(q.getlist("limit")[0])
        if limit is None or not 1 <= limit <= 100:
            raise UnprocessableError("limit must be an integer from 1 to 100")
    if "offset" in q:
        offset = parse_uint(q.getlist("offset")[0])
        if offset is None:
            raise UnprocessableError("offset must be an integer >= 0")
    return Page(limit, offset)


PageParams = Annotated[Page, Depends(get_page)]


def _first(request: Request, name: str) -> str:
    values = request.query_params.getlist(name)
    return values[0] if values else ""


# ---------------------------------------------------------------- users and auth


@router.post("/users", status_code=201, response_model=UserResponse)
async def register(body: NewUserBody, services: Services):
    u = body.user
    return UserResponse(user=await services.conduit_users.register(u.username, u.email, u.password))


@router.post("/users/login", response_model=UserResponse)
async def login(body: LoginBody, services: Services):
    return UserResponse(user=await services.conduit_users.login(body.user.email, body.user.password))


@router.get("/user", response_model=UserResponse)
async def current_user(viewer: AuthRequired, services: Services):
    return UserResponse(user=await services.conduit_users.current(viewer.user_id, viewer.token))


@router.put("/user", response_model=UserResponse)
async def update_user(body: UpdateUserBody, viewer: AuthRequired, services: Services):
    return UserResponse(user=await services.conduit_users.update(viewer.user_id, viewer.token, body.user))


# ---------------------------------------------------------------- profiles


@router.get("/profiles/{username}", response_model=ProfileResponse)
async def get_profile(username: str, viewer: AuthOptional, services: Services):
    return ProfileResponse(profile=await services.conduit_users.profile(viewer.user_id, username))


@router.post("/profiles/{username}/follow", response_model=ProfileResponse)
async def follow(username: str, viewer: AuthRequired, services: Services):
    return ProfileResponse(profile=await services.conduit_users.set_follow(viewer.user_id, username, True))


@router.delete("/profiles/{username}/follow", response_model=ProfileResponse)
async def unfollow(username: str, viewer: AuthRequired, services: Services):
    return ProfileResponse(profile=await services.conduit_users.set_follow(viewer.user_id, username, False))


# ---------------------------------------------------------------- articles


@router.get("/articles", response_model=ArticlesResponse)
async def list_articles(request: Request, viewer: AuthOptional, page: PageParams, services: Services):
    return await services.articles.list(
        viewer.user_id,
        page.limit,
        page.offset,
        tag=_first(request, "tag"),
        author=_first(request, "author"),
        favorited=_first(request, "favorited"),
    )


@router.get("/articles/feed", response_model=ArticlesResponse)
async def feed(viewer: AuthRequired, page: PageParams, services: Services):
    return await services.articles.feed(viewer.user_id, page.limit, page.offset)


@router.get("/articles/{slug}", response_model=ArticleResponse)
async def get_article(slug: str, viewer: AuthOptional, services: Services):
    return ArticleResponse(article=await services.articles.get(viewer.user_id, slug))


@router.post("/articles", status_code=201, response_model=ArticleResponse)
async def create_article(body: NewArticleBody, viewer: AuthRequired, services: Services):
    return ArticleResponse(article=await services.articles.create(viewer.user_id, body.article))


@router.put("/articles/{slug}", response_model=ArticleResponse)
async def update_article(slug: str, body: UpdateArticleBody, viewer: AuthRequired, services: Services):
    return ArticleResponse(article=await services.articles.update(viewer.user_id, slug, body.article))


@router.delete("/articles/{slug}", status_code=204)
async def delete_article(slug: str, viewer: AuthRequired, services: Services):
    await services.articles.delete(viewer.user_id, slug)
    return Response(status_code=204)


# ---------------------------------------------------------------- favorites


@router.post("/articles/{slug}/favorite", response_model=ArticleResponse)
async def favorite(slug: str, viewer: AuthRequired, services: Services):
    return ArticleResponse(article=await services.articles.set_favorite(viewer.user_id, slug, True))


@router.delete("/articles/{slug}/favorite", response_model=ArticleResponse)
async def unfavorite(slug: str, viewer: AuthRequired, services: Services):
    return ArticleResponse(article=await services.articles.set_favorite(viewer.user_id, slug, False))


# ---------------------------------------------------------------- comments


@router.get("/articles/{slug}/comments", response_model=CommentsResponse)
async def list_comments(slug: str, viewer: AuthOptional, services: Services):
    return CommentsResponse(comments=await services.comments.list(viewer.user_id, slug))


@router.post("/articles/{slug}/comments", status_code=201, response_model=CommentResponse)
async def add_comment(slug: str, body: NewCommentBody, viewer: AuthRequired, services: Services):
    return CommentResponse(comment=await services.comments.add(viewer.user_id, slug, body.comment.body))


@router.delete("/articles/{slug}/comments/{comment_id}", status_code=204)
async def delete_comment(slug: str, comment_id: str, viewer: AuthRequired, services: Services):
    cid = parse_uint(comment_id)
    if cid is None:
        raise NotFoundError("comment not found")
    await services.comments.delete(viewer.user_id, slug, cid)
    return Response(status_code=204)


# ---------------------------------------------------------------- tags


@router.get("/tags", response_model=TagsResponse)
async def tags(services: Services):
    return TagsResponse(tags=await services.articles.tags())
