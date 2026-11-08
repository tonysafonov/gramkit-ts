class BackendException(Exception):
    """Base for this app's domain errors; `webhook/errors.py` maps each to its status."""

    status_code = 500

    def __init__(self, message: str):
        self.message = message
        self.code = self.__class__.__name__
        super().__init__(message)


class UnauthorizedError(BackendException):
    status_code = 401


class ForbiddenError(BackendException):
    status_code = 403


class NotFoundError(BackendException):
    status_code = 404


class UnprocessableError(BackendException):
    status_code = 422
