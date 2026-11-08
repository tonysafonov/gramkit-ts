import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { getUser } from '../../auth/context';
import type { Env } from '../../env';
import { RequestValidationError } from '../../lib/errors';
import { validate } from '../../lib/validate';
import { HARD_LIMIT, rateLimit, SOFT_LIMIT } from '../../middleware/rate-limit';
import { requireUserId } from '../auth/routes';
import { CancelSubscriptionRequest, toSubscriptionResponse, toSubscriptionWithDetailsResponse } from './schemas';

/** `validate` reads a request with no JSON body as `{}`, which a schema of optional fields accepts; FastAPI gives a 422. */
const requireJsonBody = createMiddleware(async (c, next) => {
  if (!/json/i.test(c.req.header('content-type') ?? '')) {
    throw new RequestValidationError([{ type: 'missing', loc: ['body'], msg: 'Field required', input: null }]);
  }
  await next();
});

/** Full paths: `GET /subscriptions/` keeps its trailing slash, which a mounted `/` would lose. */
export const subscriptionsRoutes = new Hono<Env>()
  // The current subscription with details.
  .get('/subscriptions/', getUser, rateLimit(SOFT_LIMIT), async (c) => {
    const subscription = await c.get('services').subscriptions.getSubscriptionWithDetailsForUser(c.get('user').id);
    return c.json(toSubscriptionWithDetailsResponse(subscription));
  })
  // Cancel the current subscription, with an optional reason and feedback. Not for the shared guest (a 401): its
  // subscription would be every logged-out visitor's. Python lets it cancel.
  .post(
    '/subscriptions/cancel',
    getUser,
    rateLimit(HARD_LIMIT),
    requireJsonBody,
    validate('json', CancelSubscriptionRequest),
    async (c) => {
      const { reason, feedback } = c.req.valid('json');
      const subscription = await c.get('services').subscriptions.cancelSubscription(requireUserId(c), reason, feedback);
      return c.json(toSubscriptionResponse(subscription));
    },
  );
