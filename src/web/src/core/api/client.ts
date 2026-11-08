/**
 * Transport for the typed API clients (`@/api`): base URL, platform-aware auth headers, error classification.
 *
 * Base URL resolution (in order):
 * 1. `VITE_API_HOST`, when set and not `/` (a tunnel or a separate API origin)
 * 2. `/api`: the dev server proxies it to the backend, and in production nginx does (the server's `WEB__API_ROOT_PATH`).
 *
 * Headers sent on every request:
 * - `initData`: Telegram WebApp initialization data (empty on the web, where the session cookie authenticates)
 * - `Mock-Platform`: asks the backend to accept the mock user carried in initData (debug builds only)
 *
 * Errors: a non-2xx response throws an `ApiError` (see `@core/errors`) with the retry classification TanStack Query's
 * retry logic reads; a failed fetch throws a network `ApiError` (status 0).
 */
import { classifyHttpError, classifyNetworkError } from '@core/errors';

// Login-as switch: gates the Mock-Platform header that tells the backend to authenticate as the mock user carried in
// initData. Independent of the TG-platform mock (telegram vs web) toggle.
const LOGIN_AS_KEY = 'telegram-platform-login-as';

function readInitData(): string {
  if (typeof window === 'undefined') return '';
  return (window as { Telegram?: { WebApp?: { initData?: string } } }).Telegram?.WebApp?.initData ?? '';
}

function isLoginAsEnabled(): boolean {
  if (import.meta.env.VITE_DEBUG !== 'true' || typeof window === 'undefined') return false;
  try {
    return localStorage.getItem(LOGIN_AS_KEY) === 'true';
  } catch {
    return false;
  }
}

function resolveApiBaseUrl(): string {
  const envUrl = import.meta.env.VITE_API_HOST;
  if (envUrl && envUrl !== '/') return envUrl.replace(/\/$/, '');
  return '/api';
}

/** The API base URL, without a trailing slash: absolute or a path. */
export const API_BASE_URL = resolveApiBaseUrl();

function withAuthHeaders(source?: HeadersInit): Headers {
  const headers = new Headers(source);
  headers.set('initData', readInitData());
  if (isLoginAsEnabled()) headers.set('Mock-Platform', 'true');
  return headers;
}

/**
 * Fetch for `hc` clients: adds the auth headers and cookies, throws classified errors. Responses that get back to the
 * caller are always 2xx, so the typed result is the success body.
 */
export const apiClientFetch: typeof fetch = async (input, init) => {
  let response: Response;
  try {
    response = await fetch(input, {
      ...init,
      headers: withAuthHeaders(init?.headers),
      credentials: 'include',
    });
  } catch (error) {
    throw classifyNetworkError(error instanceof Error ? error : new Error('Network error'));
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => undefined)) as Record<string, unknown> | undefined;
    throw classifyHttpError(response.status, body);
  }
  return response;
};

/**
 * Raw fetch with the same base URL and auth headers (does not throw on non-2xx). For streams and multipart uploads,
 * where the caller reads the Response itself.
 */
export function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${API_BASE_URL}${path.startsWith('/') ? path : `/${path}`}`, {
    ...init,
    headers: withAuthHeaders(init?.headers),
    credentials: 'include',
  });
}

/** Socket.io connection options type. */
export interface SocketOptions {
  url: string | undefined;
  options: {
    path: string;
    auth: Record<string, string>;
    withCredentials: boolean;
    transports: ('websocket' | 'polling')[];
    reconnection: boolean;
    reconnectionAttempts: number;
    reconnectionDelay: number;
  };
}

/**
 * Socket.io connection options with the right URL, path and auth. Handles both relative bases (dev proxy, nginx) and
 * absolute URLs.
 *
 * Usage:
 *   const { url, options } = getSocketOptions();
 *   const socket = io(url, options);
 */
export function getSocketOptions(): SocketOptions {
  const isAbsolute = API_BASE_URL.startsWith('http');
  const pathname = isAbsolute ? new URL(API_BASE_URL).pathname.replace(/\/$/, '') : API_BASE_URL;

  return {
    url: isAbsolute ? new URL(API_BASE_URL).origin : undefined,
    options: {
      path: `${pathname}/socket.io`,
      auth: {
        initData: readInitData(),
        ...(isLoginAsEnabled() ? { mockPlatform: 'true' } : {}),
      },
      withCredentials: true,
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
    },
  };
}
