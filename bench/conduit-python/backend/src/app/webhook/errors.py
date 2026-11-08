"""Every error as `{"errors": {"body": [<message>]}}` (SPEC.md "Formats").

Unlike the templates (routers translate errors to `HTTPException`), the spec needs one error shape for every
status, so the domain errors get a handler. Router-level 404/405 and validation 422 get the same shape.
"""

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.exceptions import BackendException


def error_response(status_code: int, message: str) -> JSONResponse:
    return JSONResponse({"errors": {"body": [message]}}, status_code=status_code)


async def _backend_error(request: Request, exc: BackendException) -> JSONResponse:
    return error_response(exc.status_code, exc.message)


async def _http_error(request: Request, exc: StarletteHTTPException) -> JSONResponse:
    return error_response(exc.status_code, str(exc.detail).lower())


async def _validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
    err = exc.errors()[0]
    where = ".".join(str(p) for p in err["loc"][1:]) or err["loc"][0]
    return error_response(422, f"{where}: {err['msg']}")


def register_error_handlers(app: FastAPI) -> None:
    app.add_exception_handler(BackendException, _backend_error)
    app.add_exception_handler(StarletteHTTPException, _http_error)
    app.add_exception_handler(RequestValidationError, _validation_error)
