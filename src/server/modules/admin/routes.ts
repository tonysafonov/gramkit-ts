/**
 * Core admin routes: RBAC meta, users management and payment refunds (mounted at `/admin`). The audit log, tasks,
 * broadcasts, marketing links, overview and analytics are their own routers under the same prefix.
 *
 * Gating: reads, gift and revoke = admin; role change, reset and refund = owner.
 *
 * ROUTE ORDERING IS LOAD-BEARING: the static `/users` is declared before the dynamic `/users/:user_id`.
 *
 * ERROR MAPPING MUST THROW: every failure path throws (never returns an error response). The request transaction
 * commits unless the request throws, and the refund path writes its audit row before calling the provider: a
 * returned error response would commit a refund the provider never made.
 */
import { Hono } from 'hono';
import { adminUser, ownerUser } from '../../auth/rbac';
import { settings } from '../../config';
import type { Env } from '../../env';
import {
  AppError,
  BadRequestError,
  NotFoundError,
  PaymentNotFoundException,
  RefundNotAllowedException,
  UserNotFoundException,
} from '../../lib/errors';
import { validate } from '../../lib/validate';
import { ProviderRefundError } from '../payments/service';
import {
  AdminListQuery,
  AdminUsersQuery,
  ChangeRoleRequest,
  GiftSubscriptionRequest,
  PaymentIdParam,
  toAdminRbac,
  UserIdParam,
} from './schemas';

/** Run a service call, turning `UserNotFoundException` into the 404 Python's routes answer. */
async function orUserNotFound<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (e) {
    if (e instanceof UserNotFoundException) throw new NotFoundError(e.message);
    throw e;
  }
}

export const adminRoutes = new Hono<Env>()
  // Meta
  .get('/meta/rbac', adminUser, (c) => c.json(toAdminRbac(c.get('user'))))

  // Users
  .get('/users', adminUser, validate('query', AdminUsersQuery), async (c) => {
    const { params, role, userType } = c.req.valid('query');
    return c.json(await c.var.services.admin.listUsers(params, { role, userType }));
  })
  .get('/users/:user_id', adminUser, validate('param', UserIdParam), async (c) => {
    const detail = await c.var.services.admin.getUserDetail(c.req.valid('param').user_id);
    if (detail === null) throw new NotFoundError('User not found');
    return c.json(detail);
  })
  .get(
    '/users/:user_id/payments',
    adminUser,
    validate('param', UserIdParam),
    validate('query', AdminListQuery),
    async (c) => c.json(await c.var.services.admin.listPayments(c.req.valid('param').user_id, c.req.valid('query'))),
  )
  .get('/users/:user_id/subscriptions', adminUser, validate('param', UserIdParam), async (c) =>
    c.json(await c.var.services.admin.listSubscriptions(c.req.valid('param').user_id)),
  )
  .post(
    '/users/:user_id/gift-subscription',
    adminUser,
    validate('param', UserIdParam),
    validate('json', GiftSubscriptionRequest),
    async (c) => {
      const { user_id } = c.req.valid('param');
      const { duration } = c.req.valid('json');
      return c.json(
        await orUserNotFound(() => c.var.services.admin.giftSubscription(c.get('user'), user_id, duration)),
      );
    },
  )
  .post('/users/:user_id/revoke-subscription', adminUser, validate('param', UserIdParam), async (c) =>
    c.json(
      await orUserNotFound(() => c.var.services.admin.revokeSubscription(c.get('user'), c.req.valid('param').user_id)),
    ),
  )
  .post(
    '/users/:user_id/role',
    ownerUser,
    validate('param', UserIdParam),
    validate('json', ChangeRoleRequest),
    async (c) => {
      const { user_id } = c.req.valid('param');
      const { new_role } = c.req.valid('json');
      return c.json(await orUserNotFound(() => c.var.services.admin.changeRole(c.get('user'), user_id, new_role)));
    },
  )
  // DEBUG-only hard delete: a 404 when DEBUG is off, so the endpoint is invisible in production. An owner can't reset
  // their own account here (400): the audit row would point at the deleted actor.
  .post('/users/:user_id/reset', ownerUser, validate('param', UserIdParam), async (c) => {
    const { user_id } = c.req.valid('param');
    const actor = c.get('user');
    if (!settings.debug) throw new NotFoundError('Not found');
    if (user_id === actor.id) throw new BadRequestError("Can't reset your own account");
    await orUserNotFound(() => c.var.services.admin.resetUser(actor, user_id));
    return c.body(null, 204);
  })

  // Payments
  .post('/payments/:payment_id/refund', ownerUser, validate('param', PaymentIdParam), async (c) => {
    try {
      return c.json(await c.var.services.admin.refundPayment(c.get('user'), c.req.valid('param').payment_id));
    } catch (e) {
      if (e instanceof PaymentNotFoundException) throw new NotFoundError(e.message);
      if (e instanceof RefundNotAllowedException) throw new BadRequestError(e.message);
      if (e instanceof ProviderRefundError) {
        // Thrown (never returned) so the request's transaction rolls back: nothing changed here. If the provider did
        // refund (the call timed out after it), its refund notice finishes the job.
        throw new AppError(
          502,
          `The refund call failed: ${e.message}. If the Stars did go back, the payment is marked refunded when Telegram confirms it.`,
        );
      }
      throw e;
    }
  });
