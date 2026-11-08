/** Request-scoped storage, the `contextvars` of the Python app: set once by the request-id middleware. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export interface RequestContext {
  requestId: string;
  path?: string;
  method?: string;
  userId?: string;
  /** The language of the current request, see `i18n`. */
  locale?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Run `fn` with `ctx` as the current context (HTTP request, bot update, worker job). */
export const runWithRequestContext = <T>(ctx: RequestContext, fn: () => T): T => storage.run(ctx, fn);

export const getRequestContext = (): RequestContext | undefined => storage.getStore();

export const getRequestId = (): string | undefined => storage.getStore()?.requestId;

export const getUserId = (): string | undefined => storage.getStore()?.userId;

/** Set the user on the current context (after authentication), so every later log line carries it. */
export function setUserContext(userId: string): void {
  const ctx = storage.getStore();
  if (!ctx) throw new Error('Cannot set user context outside request lifecycle');
  ctx.userId = userId;
}

export const generateRequestId = (): string => randomUUID();
