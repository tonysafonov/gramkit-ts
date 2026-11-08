import type { MiddlewareHandler } from 'hono';

const ALLOW_METHODS = 'DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT';
const METHODS = new Set(ALLOW_METHODS.split(', '));
const PREFLIGHT_MAX_AGE = '600';

interface CorsConfig {
  allowOrigins: string[];
  /** Must match the whole origin. */
  allowOriginRegex?: RegExp | null;
}

/**
 * Starlette's `CORSMiddleware` with `allow_credentials=True`, every method and every header. A request with no
 * Origin passes through. A preflight is answered here and goes no further.
 */
export function cors({ allowOrigins, allowOriginRegex }: CorsConfig): MiddlewareHandler {
  const origins = new Set(allowOrigins);
  const isAllowed = (origin: string) => origins.has(origin) || allowOriginRegex?.test(origin) === true;

  return async (c, next) => {
    const origin = c.req.header('origin');
    if (!origin) return next();

    const requestedMethod = c.req.header('access-control-request-method');
    if (c.req.method === 'OPTIONS' && requestedMethod) {
      const failures: string[] = [];
      c.header('Vary', 'Origin');
      c.header('Access-Control-Allow-Methods', ALLOW_METHODS);
      c.header('Access-Control-Max-Age', PREFLIGHT_MAX_AGE);
      c.header('Access-Control-Allow-Credentials', 'true');
      if (isAllowed(origin)) c.header('Access-Control-Allow-Origin', origin);
      else failures.push('origin');
      if (!METHODS.has(requestedMethod)) failures.push('method');
      const requestedHeaders = c.req.header('access-control-request-headers');
      if (requestedHeaders) c.header('Access-Control-Allow-Headers', requestedHeaders);
      return failures.length ? c.text(`Disallowed CORS ${failures.join(', ')}`, 400) : c.text('OK', 200);
    }

    c.header('Access-Control-Allow-Credentials', 'true');
    if (isAllowed(origin)) {
      c.header('Access-Control-Allow-Origin', origin);
      c.header('Vary', 'Origin', { append: true });
    }
    return next();
  };
}
