import type { MiddlewareHandler } from 'hono';

interface SecurityConfig {
  csp: string;
  /** Strict-Transport-Security, in production. */
  hstsEnabled: boolean;
}

/**
 * CSP, X-Frame-Options, X-Content-Type-Options, X-XSS-Protection and (in prod) HSTS on every response.
 *
 * Set before `next()`: Hono then puts them on whatever the route renders, errors included, without rebuilding the
 * response. A raw `new Response()` from a handler would skip them: render with `c.json`, `c.body`, `c.newResponse`.
 */
export function securityHeaders({ csp, hstsEnabled }: SecurityConfig): MiddlewareHandler {
  const headers = Object.entries({
    'Content-Security-Policy': csp,
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'X-XSS-Protection': '1; mode=block',
    ...(hstsEnabled ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}),
  });

  return (c, next) => {
    for (const [name, value] of headers) c.header(name, value);
    return next();
  };
}
