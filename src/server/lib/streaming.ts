import type { Context } from 'hono';
import type { Env } from '../env';

/**
 * Tell the access log and the request tracker that this response streams: call it in the handler, and call what it
 * returns when the body ends. Without it the request counts as done when the handler returns.
 *
 *     .get('/stream', (c) => {
 *       const end = trackStream(c);
 *       return streamSSE(c, async (stream) => { try { ... } finally { end(); } });
 *     })
 */
export function trackStream(c: Context<Env>): () => void {
  let end = () => {};
  c.set(
    'streamDone',
    new Promise<void>((resolve) => {
      end = resolve;
    }),
  );
  return end;
}
