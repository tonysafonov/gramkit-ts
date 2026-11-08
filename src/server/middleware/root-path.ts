import { getPath } from 'hono/utils/url';

/**
 * Strips the proxy's prefix from the path Hono routes on, so routing works whether the proxy passes the full path or
 * strips it. Hono picks the route before any middleware runs, so this is its `getPath` option, not a middleware.
 */
export const rootPathGetter = (rootPath: string) => (request: Request) => {
  const path = getPath(request);
  return rootPath && path.startsWith(rootPath) ? path.slice(rootPath.length) || '/' : path;
};
