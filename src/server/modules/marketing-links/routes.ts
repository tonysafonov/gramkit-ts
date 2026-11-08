/**
 * Core admin routes: marketing links (`/admin/marketing-links*`).
 *
 * One acquisition code per external placement, its Mini App / bot links and what it brought (users, activated,
 * payers, revenue). Admin-gated; mutations are audit-logged by the service.
 *
 * Error mapping must THROW: the service throws `MarketingCodeNotAllowedException` / `MarketingLinkNotFoundException`
 * and the handlers translate them by throwing an `AppError`. The request transaction commits unless something is
 * thrown, so a returned error response would commit whatever the service wrote.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { adminUser } from '../../auth/rbac';
import type { UserEnv } from '../../env';
import {
  BadRequestError,
  MarketingCodeNotAllowedException,
  MarketingLinkNotFoundException,
  NotFoundError,
} from '../../lib/errors';
import { validate } from '../../lib/validate';
import {
  MarketingLinkCreateRequest,
  MarketingLinkUpdateRequest,
  toMarketingLinkItemResponse,
  toMarketingLinkListResponse,
} from './schemas';

const LinkId = z.object({ link_id: z.coerce.number().int() });

/** Registered codes first (newest first), then codes seen in users but never registered. */
export const marketingLinksRoutes = new Hono<UserEnv>()
  .get('/marketing-links', adminUser, async (c) =>
    c.json(toMarketingLinkListResponse(await c.var.services.marketingLinks.listLinks())),
  )
  .post('/marketing-links', adminUser, validate('json', MarketingLinkCreateRequest), async (c) => {
    try {
      const item = await c.var.services.marketingLinks.create(c.var.user, c.req.valid('json'));
      return c.json(toMarketingLinkItemResponse(item));
    } catch (err) {
      if (err instanceof MarketingCodeNotAllowedException) throw new BadRequestError(err.message);
      throw err;
    }
  })
  .patch(
    '/marketing-links/:link_id',
    adminUser,
    validate('param', LinkId),
    validate('json', MarketingLinkUpdateRequest),
    async (c) => {
      try {
        const { link_id: linkId } = c.req.valid('param');
        const item = await c.var.services.marketingLinks.update(c.var.user, linkId, c.req.valid('json'));
        return c.json(toMarketingLinkItemResponse(item));
      } catch (err) {
        if (err instanceof MarketingLinkNotFoundException) throw new NotFoundError(err.message);
        throw err;
      }
    },
  );
