from sqlalchemy import RowMapping, Text, delete, exists, func, literal, select, update
from sqlalchemy.dialects.postgresql import insert

from app.infrastructure.database.models import Follow, User
from core.infrastructure.database.repo.base import BaseRepo

_USER_COLUMNS = (User.id, User.username, User.email, User.bio, User.image)


def following_expr(viewer: int, followee_id):
    """EXISTS (SELECT 1 FROM follows WHERE follower_id = viewer AND followee_id = <followee_id>)."""
    return exists().where(Follow.follower_id == viewer, Follow.followee_id == followee_id)


class UserRepo(BaseRepo[User]):
    def __init__(self, session):
        super().__init__(session)
        self.model_type = User

    async def create(self, username: str, email: str, password_hash: str) -> RowMapping:
        stmt = (
            insert(User).values(username=username, email=email, password_hash=password_hash).returning(*_USER_COLUMNS)
        )
        return (await self.session.execute(stmt)).mappings().one()

    async def get_for_login(self, email: str) -> RowMapping | None:
        stmt = select(*_USER_COLUMNS, User.password_hash).where(User.email == email)
        return (await self.session.execute(stmt)).mappings().one_or_none()

    async def get_row(self, user_id: int) -> RowMapping | None:
        stmt = select(*_USER_COLUMNS).where(User.id == user_id)
        return (await self.session.execute(stmt)).mappings().one_or_none()

    async def update_fields(
        self,
        user_id: int,
        email: str | None,
        username: str | None,
        password_hash: str | None,
        bio: str | None,
        image: str | None,
    ) -> RowMapping | None:
        stmt = (
            update(User)
            .where(User.id == user_id)
            .values(
                email=func.coalesce(literal(email, Text), User.email),
                username=func.coalesce(literal(username, Text), User.username),
                password_hash=func.coalesce(literal(password_hash, Text), User.password_hash),
                bio=func.coalesce(literal(bio, Text), User.bio),
                image=func.coalesce(literal(image, Text), User.image),
            )
            .returning(*_USER_COLUMNS)
        )
        return (await self.session.execute(stmt)).mappings().one_or_none()

    async def get_profile(self, viewer: int, username: str) -> RowMapping | None:
        stmt = select(
            User.id, User.username, User.bio, User.image, following_expr(viewer, User.id).label("following")
        ).where(User.username == username)
        return (await self.session.execute(stmt)).mappings().one_or_none()

    async def get_by_username(self, username: str) -> RowMapping | None:
        stmt = select(User.id, User.username, User.bio, User.image).where(User.username == username)
        return (await self.session.execute(stmt)).mappings().one_or_none()

    async def follow(self, follower_id: int, followee_id: int) -> None:
        stmt = insert(Follow).values(follower_id=follower_id, followee_id=followee_id).on_conflict_do_nothing()
        await self.session.execute(stmt)

    async def unfollow(self, follower_id: int, followee_id: int) -> None:
        stmt = delete(Follow).where(Follow.follower_id == follower_id, Follow.followee_id == followee_id)
        await self.session.execute(stmt)
