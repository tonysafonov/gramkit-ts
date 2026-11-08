# Fix step 1: one Bot per process instead of one per request (aiogram builds an aiohttp session, and with it an
# SSL context that loads the CA bundle, in Bot()). Nothing in a request closes it; it lives as long as the worker.
from aiogram import Bot
from aiogram.client.default import DefaultBotProperties

from core.infrastructure.config import settings
from core.infrastructure.telegram.retry import with_retries

_bot: Bot | None = None


async def get_bot() -> Bot:
    global _bot
    if _bot is None:
        _bot = with_retries(Bot(token=settings.bot.token, default=DefaultBotProperties(parse_mode="Markdown")))
    return _bot
