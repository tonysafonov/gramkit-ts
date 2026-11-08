/**
 * One error shape, the Python app's: `{"detail": ...}` for everything FastAPI would render.
 *
 * Throw an `AppError` subclass from a route or service; the global handler (`lib/error-handler.ts`) renders it. A
 * throw rolls the request's transaction back. Everything else that is thrown becomes a logged 500.
 *
 * `*Exception` classes are domain errors, the same classes as Python's `core/exceptions.py`: services throw them,
 * routes translate them into an HTTP error. One that reaches the global handler is a 500, as it is in Python.
 */
import type { ContentfulStatusCode } from 'hono/utils/http-status';

export class AppError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly detail: unknown,
    readonly headers?: Record<string, string>,
  ) {
    super(typeof detail === 'string' ? detail : JSON.stringify(detail));
    this.name = new.target.name;
  }

  /** The JSON body of the error response. */
  toBody(): unknown {
    return { detail: this.detail };
  }
}

export class BadRequestError extends AppError {
  constructor(detail: unknown = 'Bad Request') {
    super(400, detail);
  }
}

export class UnauthorizedError extends AppError {
  constructor(detail: unknown = 'Unauthorized', headers?: Record<string, string>) {
    super(401, detail, headers);
  }
}

export class ForbiddenError extends AppError {
  constructor(detail: unknown = 'Forbidden') {
    super(403, detail);
  }
}

export class NotFoundError extends AppError {
  constructor(detail: unknown = 'Not Found') {
    super(404, detail);
  }
}

export class ConflictError extends AppError {
  constructor(detail: unknown = 'Conflict') {
    super(409, detail);
  }
}

export class TooManyRequestsError extends AppError {
  constructor(detail: unknown = 'Too Many Requests', headers?: Record<string, string>) {
    super(429, detail, headers);
  }
}

/** slowapi's body is not the usual shape: `{"error": "Rate limit exceeded: 100 per 1 minute"}`. */
export class RateLimitExceededError extends AppError {
  constructor(limit: string) {
    super(429, `Rate limit exceeded: ${limit}`);
  }

  override toBody(): unknown {
    return { error: this.detail };
  }
}

/** How long a client should wait before retrying after an infrastructure failure, in seconds. */
export const RETRY_AFTER_SECONDS = 5;

/** The DB, Redis or the network failed: the client retries. Never a 401, never the guest fallback. */
export class ServiceUnavailableError extends AppError {
  constructor(detail: unknown = 'Service temporarily unavailable, please retry') {
    super(503, detail, { 'Retry-After': String(RETRY_AFTER_SECONDS) });
  }
}

/** One entry of FastAPI's validation error list. */
export interface ValidationErrorItem {
  type: string;
  loc: (string | number)[];
  msg: string;
  input?: unknown;
  ctx?: Record<string, unknown>;
}

/** FastAPI's 422: `{"detail": [{"type", "loc", "msg", "input"}]}`. */
export class RequestValidationError extends AppError {
  constructor(readonly errors: ValidationErrorItem[]) {
    super(422, errors);
  }
}

// Domain errors -------------------------------------------------------------------------------------------------

/** Base of the application's errors. `code` is the class name, as the app's `BackendException` has it. */
export class BackendException extends Error {
  readonly code: string;

  constructor(message = 'Service is unavailable', name?: string) {
    super(message);
    this.code = new.target.name;
    this.name = name ?? new.target.name;
  }
}

export class UserNotFoundException extends BackendException {}

export class PaymentException extends BackendException {}
export class PaymentNotFoundException extends PaymentException {}
/** The payment can't be refunded here (wrong status or provider). */
export class RefundNotAllowedException extends PaymentException {}

export class SubscriptionException extends BackendException {}

export class AdminTaskNotFoundException extends BackendException {}

export class BroadcastException extends BackendException {}
export class BroadcastNotFoundException extends BroadcastException {}
/** Broadcast content or a request about it is invalid (the message is user-facing). */
export class InvalidBroadcastException extends BroadcastException {}

export class MarketingLinkException extends BackendException {}
export class MarketingLinkNotFoundException extends MarketingLinkException {}
/** The code can't be registered: already registered, or one of the app's own codes. */
export class MarketingCodeNotAllowedException extends MarketingLinkException {}
