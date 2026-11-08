import { Hono } from 'hono';
import { adminUser } from '../../auth/rbac';
import type { Env } from '../../env';
import { validate } from '../../lib/validate';
import { AuditLogQuery } from './schemas';

export const auditLogRoutes = new Hono<Env>()
  /** Paginated audit trail of mutating admin/owner actions. */
  .get('/audit-log', adminUser, validate('query', AuditLogQuery), async (c) => {
    const { params, ...filters } = c.req.valid('query');
    return c.json(await c.var.services.auditLog.list(params, filters));
  })
  /** Distinct audit actions recorded so far (for the action filter). */
  .get('/audit-log/actions', adminUser, async (c) => c.json(await c.var.services.auditLog.listActions()));
