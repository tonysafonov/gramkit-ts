import { Hono } from 'hono';
import { getUser } from '../../auth/context';
import type { Env } from '../../env';
import { HARD_LIMIT, rateLimit } from '../../middleware/rate-limit';
import { requireUserId } from '../auth/routes';

/**
 * Python's `routers.base` part about invites: `/create_invite`. Mounted with no prefix. Signed-in users only: the
 * guest is every logged-out visitor, and whoever joined its group would be their friend.
 */
export const invitesRoutes = new Hono<Env>().get('/create_invite', getUser, rateLimit(HARD_LIMIT), async (c) => {
  // The body is the bare code, a JSON string
  return c.json(await c.get('services').invites.createInvite(requireUserId(c)));
});
