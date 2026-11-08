import { Hono } from 'hono';
import { getUser } from '../../auth/context';
import type { Env } from '../../env';
import { validate } from '../../lib/validate';
import { rateLimit, SOFT_LIMIT } from '../../middleware/rate-limit';
import { StartParamsBody, toStartDataResponse, toStartParams } from './schemas';

/** Python's `routers.base` part about the app opening: `/process_start`. Mounted with no prefix. */
export const startRoutes = new Hono<Env>().post(
  '/process_start',
  getUser,
  rateLimit(SOFT_LIMIT),
  validate('json', StartParamsBody),
  async (c) => {
    const data = await c.get('services').start.processStart(c.get('user'), toStartParams(c.req.valid('json')));
    return c.json(toStartDataResponse(data));
  },
);
