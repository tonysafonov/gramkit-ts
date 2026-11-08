"""Conduit on gramkit: the same `create_api` (middleware, lifespan, error handler) as the templates.

Wired like today's template (apps/template-vue/backend/src/app/webhook/app.py): core's own `get_services`
builds the app's `RequestsService` (`services_class=`), with the process-wide Bot / arq pool opened in
create_api's lifespan. No dependency_overrides: core's dependencies are real dependencies.
"""

from app.infrastructure import setup_infrastructure

setup_infrastructure()

from app.infrastructure.database.repo.requests import RequestsRepo
from app.services.requests import RequestsService
from app.webhook.errors import register_error_handlers
from app.webhook.routers import conduit
from core.infrastructure.config import settings
from core.infrastructure.fastapi import create_api

app = create_api(
    config=settings.web,
    db_config=settings.db,
    repo_class=RequestsRepo,
    services_class=RequestsService,
    routers=[conduit.router],
    title="Conduit on gramkit",
    version="bench",
)
register_error_handlers(app)
