/**
 * Core admin routes: broadcasts (`/admin/broadcasts*`), mounted under `/admin` in `routes.ts`.
 *
 * ROUTE ORDERING IS LOAD-BEARING: every STATIC `/broadcasts/...` path (media, format, preview, send-now) is declared
 * BEFORE the dynamic `/broadcasts/:broadcast_id` (and its sub-paths), or the dynamic route would match first and
 * read "media" / "format" / ... as a broadcast id (422).
 *
 * Gating: send-now (immediate all-users blast) is owner only; everything else is admin. Every mutating endpoint
 * records an audit row (via the service). Domain errors are translated by THROWING, never by returning a response:
 * the request transaction commits unless an error leaves the request, so a returned error would commit whatever the
 * service wrote.
 */
import { Hono } from 'hono';
import { adminUser, ownerUser } from '../../auth/rbac';
import type { Env } from '../../env';
import {
  BadRequestError,
  BroadcastNotFoundException,
  InvalidBroadcastException,
  NotFoundError,
} from '../../lib/errors';
import { validate } from '../../lib/validate';
import {
  BroadcastCreateRequest,
  BroadcastFormatRequest,
  BroadcastIdParam,
  BroadcastMediaUploadForm,
  BroadcastPreviewRequest,
  BroadcastSendNowRequest,
  BroadcastUpdateRequest,
  toBroadcastDetailResponse,
  toBroadcastListResponse,
  toDeliveryStatsResponse,
  toMediaUploadResponse,
} from './schemas';

/** Run a service call and translate its domain errors to HTTP errors: not found is a 404, invalid is a 400. */
async function translated<T>(call: () => Promise<T>, options: { notFound?: boolean } = { notFound: true }): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (options.notFound && err instanceof BroadcastNotFoundException) throw new NotFoundError(err.message);
    if (err instanceof InvalidBroadcastException) throw new BadRequestError(err.message);
    throw err;
  }
}

export const broadcastsRoutes = new Hono<Env>()
  // Active + completed broadcasts, plus active-count-per-slot for the warning banner.
  .get('/broadcasts', adminUser, async (c) => {
    return c.json(toBroadcastListResponse(await c.var.services.broadcasts.listBroadcasts()));
  })

  // Create broadcast(s); records an audit row. `time_slot='both'` creates TWO rows.
  .post('/broadcasts', adminUser, validate('json', BroadcastCreateRequest), async (c) => {
    const { services, user } = c.var;
    return c.json(await translated(() => services.broadcasts.create(user, c.req.valid('json')), { notFound: false }));
  })

  // STATIC sub-paths (declared BEFORE the dynamic /broadcasts/:broadcast_id)

  // Upload media via multipart; the bot sends it to mint a reusable Telegram file_id.
  .post('/broadcasts/media', adminUser, validate('form', BroadcastMediaUploadForm), async (c) => {
    const { services, user } = c.var;
    const { file, message_type: messageType } = c.req.valid('form');
    const result = await translated(
      async () => {
        // Telegram's size limit is checked before the body is read into memory.
        services.broadcasts.checkUploadSize(messageType, file.size);
        const content = new Uint8Array(await file.arrayBuffer());
        return services.broadcasts.uploadMedia(user, { messageType, filename: file.name || 'upload', content });
      },
      { notFound: false },
    );
    return c.json(toMediaUploadResponse(result));
  })

  // Convert text + Telegram entities to the HTML the send pipeline ships.
  .post('/broadcasts/format', adminUser, validate('json', BroadcastFormatRequest), (c) => {
    const { text, entities } = c.req.valid('json');
    return c.json({ html: c.var.services.broadcasts.formatText(text, entities) });
  })

  // Send the composed message to the acting admin's OWN Telegram chat (no DB write).
  .post('/broadcasts/preview', adminUser, validate('json', BroadcastPreviewRequest), async (c) => {
    const { services, user } = c.var;
    const sent = await translated(() => services.broadcasts.preview(user, c.req.valid('json')), { notFound: false });
    return c.json({ sent });
  })

  // Trigger an immediate all-users blast (owner); reuses the worker job; records audit.
  .post('/broadcasts/send-now', ownerUser, validate('json', BroadcastSendNowRequest), async (c) => {
    const { services, user } = c.var;
    const queued = await translated(() => services.broadcasts.sendNow(user, c.req.valid('json')));
    return c.json({ queued });
  })

  // DYNAMIC /broadcasts/:broadcast_id routes (declared LAST)

  // Delivery counters (sent / success / fail / cycles + last_sent_at).
  .get('/broadcasts/:broadcast_id/stats', adminUser, validate('param', BroadcastIdParam), async (c) => {
    const { broadcast_id: broadcastId } = c.req.valid('param');
    const stats = await translated(() => c.var.services.broadcasts.getStats(broadcastId));
    return c.json(toDeliveryStatsResponse(stats));
  })

  // Full broadcast for the detail view / edit form (404 if missing).
  .get('/broadcasts/:broadcast_id', adminUser, validate('param', BroadcastIdParam), async (c) => {
    const detail = await c.var.services.broadcasts.getBroadcast(c.req.valid('param').broadcast_id);
    if (!detail) throw new NotFoundError('Broadcast not found');
    return c.json(toBroadcastDetailResponse(detail));
  })

  // Edit a single broadcast row; records an audit row. (A 'both' pair is two rows.)
  .patch(
    '/broadcasts/:broadcast_id',
    adminUser,
    validate('param', BroadcastIdParam),
    validate('json', BroadcastUpdateRequest),
    async (c) => {
      const { services, user } = c.var;
      const { broadcast_id: broadcastId } = c.req.valid('param');
      const detail = await translated(() => services.broadcasts.edit(user, broadcastId, c.req.valid('json')));
      return c.json(toBroadcastDetailResponse(detail));
    },
  )

  // Soft-cancel a broadcast (isActive = false); records an audit row.
  .post('/broadcasts/:broadcast_id/cancel', adminUser, validate('param', BroadcastIdParam), async (c) => {
    const { services, user } = c.var;
    const detail = await translated(() => services.broadcasts.cancel(user, c.req.valid('param').broadcast_id));
    return c.json(toBroadcastDetailResponse(detail));
  });
