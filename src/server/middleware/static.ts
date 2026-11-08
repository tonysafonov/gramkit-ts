import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import type { Context, MiddlewareHandler } from 'hono';
import { getMimeType } from 'hono/utils/mime';

interface StaticOptions {
  /** Directory the files are read from. */
  root: string;
  /** URL prefix this directory is mounted under, e.g. `/static/images`. */
  prefix: string;
  /** `Cache-Control: public, max-age=N, immutable`. */
  cacheMaxAge?: number;
}

const notFound = (c: Context) => c.json({ detail: 'Not Found' }, 404);

/** The file under `base` a URL path names; `null` for a malformed path or one that climbs out of `base`. */
function resolveInside(base: string, urlPath: string): string | null {
  try {
    const file = resolve(base, decodeURIComponent(urlPath).replace(/^\/+/, ''));
    return file.startsWith(base + sep) ? file : null;
  } catch {
    return null;
  }
}

/** Static files with caching headers: etag, last-modified, 304s. A file that isn't there is a 404, nothing further. */
export function cachedStatic({ root, prefix, cacheMaxAge = 3600 }: StaticOptions): MiddlewareHandler {
  const base = resolve(root);
  const cacheControl = `public, max-age=${cacheMaxAge}, immutable`;

  return async (c) => {
    const file = resolveInside(base, c.req.path.slice(prefix.length));
    if (!file) return notFound(c);

    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) return notFound(c);

    const etag = `"${createHash('md5').update(`${info.mtimeMs}-${info.size}`).digest('hex')}"`;
    c.header('Cache-Control', cacheControl);
    c.header('ETag', etag);
    c.header('Last-Modified', info.mtime.toUTCString());
    if (c.req.header('if-none-match') === etag) return c.body(null, 304);

    c.header('Content-Type', getMimeType(file) ?? 'application/octet-stream');
    c.header('Content-Length', String(info.size));
    return c.body(Readable.toWeb(createReadStream(file)) as ReadableStream);
  };
}
