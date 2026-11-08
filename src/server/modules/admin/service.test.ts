/**
 * AdminService on the app's aggregator. Config owners come through the `ownerIds` seam, spied on, never through
 * `settings`. Port of `tests/integration/test_admin_service.py`.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { adminAuditLogs, PaymentProvider, PaymentStatus, payments, UserRole } from '../../db/schema';
import { PaymentNotFoundException, RefundNotAllowedException, UserNotFoundException } from '../../lib/errors';
import type { Services } from '../../services';
import { createTestApp, createUser, type TestApp } from '../../testing';
import { ProviderRefundError } from '../payments/service';
import { AdminService } from './service';
import { makeServices } from './testing';

let t: TestApp;
let services: Services;

beforeAll(async () => {
  t = await createTestApp();
  services = makeServices(t);
});
afterAll(() => t.close());
afterEach(() => vi.restoreAllMocks());

const seedUser = (role: string = UserRole.USER) => createUser(t.db, { role });
const auditRows = (action: string, targetId: string) =>
  t.db
    .select()
    .from(adminAuditLogs)
    .where(and(eq(adminAuditLogs.action, action), eq(adminAuditLogs.targetId, targetId)));

describe('buildDetail', () => {
  it('flags a config owner for a configured telegram id', async () => {
    const user = await seedUser();
    vi.spyOn(AdminService.prototype, 'ownerIds').mockReturnValue(new Set([user.telegramId as number]));

    const detail = await services.admin.getUserDetail(user.id);

    expect(detail?.is_config_owner).toBe(true);
    expect(detail?.has_active_subscription).toBe(false);
    expect(detail?.payments_count).toBe(0);
  });

  it('does not flag a config owner otherwise', async () => {
    const user = await seedUser();
    vi.spyOn(AdminService.prototype, 'ownerIds').mockReturnValue(new Set());

    const detail = await services.admin.buildDetail(user);

    expect(detail.is_config_owner).toBe(false);
  });

  it('returns null for an unknown user', async () => {
    expect(await services.admin.getUserDetail(randomUUID())).toBeNull();
  });
});

describe('requireUser', () => {
  it('throws for an unknown id', async () => {
    const failure = services.admin.requireUser(randomUUID());
    await expect(failure).rejects.toBeInstanceOf(UserNotFoundException);
    await expect(failure).rejects.toThrow('User not found');
  });

  it('returns the row', async () => {
    const user = await seedUser();
    expect((await services.admin.requireUser(user.id)).id).toBe(user.id);
  });
});

describe('changeRole', () => {
  it('applies and audits a config owner', async () => {
    const actor = await seedUser(UserRole.OWNER);
    const target = await seedUser();
    vi.spyOn(AdminService.prototype, 'ownerIds').mockReturnValue(new Set([target.telegramId as number]));

    const detail = await services.admin.changeRole(actor, target.id, 'admin');

    expect(detail.role).toBe('admin');
    const rows = await auditRows('change_role', target.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actorUserId).toBe(actor.id);
    expect(rows[0]?.actorRole).toBe(actor.role);
    expect(rows[0]?.targetType).toBe('user');
    expect(rows[0]?.detail).toEqual({ previous_role: 'user', new_role: 'admin', config_owner: true });
  });

  it('throws for an unknown user and writes nothing', async () => {
    const actor = await seedUser(UserRole.OWNER);
    const missing = randomUUID();

    await expect(services.admin.changeRole(actor, missing, 'admin')).rejects.toBeInstanceOf(UserNotFoundException);

    expect(await auditRows('change_role', missing)).toEqual([]);
  });
});

describe('resetUser', () => {
  it('deletes the user and the audit row survives', async () => {
    const actor = await seedUser(UserRole.OWNER);
    const target = await seedUser();

    await services.admin.resetUser(actor, target.id);

    expect(await services.repos.users.getById(target.id)).toBeNull();
    const rows = await auditRows('reset_user', target.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.detail?.role).toBe('user');
  });
});

describe('refundPayment: error mapping (the provider call itself is faked)', () => {
  async function seedPayment(): Promise<string> {
    const user = await seedUser();
    const [payment] = await t.db
      .insert(payments)
      .values({
        userId: user.id,
        productId: 'TEST_PRODUCT',
        providerId: PaymentProvider.TELEGRAM_STARS,
        amount: 100,
        currency: 'XTR',
        status: PaymentStatus.SUCCEEDED,
      })
      .returning();
    return (payment as { id: string }).id;
  }

  const fakePayments = (error: Error) =>
    Object.defineProperty(services, 'payments', {
      configurable: true,
      value: { refundPayment: vi.fn().mockRejectedValue(error) },
    });

  afterEach(() => {
    // Drop the instance override so the prototype getter shows again.
    Reflect.deleteProperty(services, 'payments');
  });

  it('throws not found for an unknown payment', async () => {
    const actor = await seedUser(UserRole.OWNER);

    const failure = services.admin.refundPayment(actor, randomUUID());
    await expect(failure).rejects.toBeInstanceOf(PaymentNotFoundException);
    await expect(failure).rejects.toThrow('Payment not found');
  });

  it('lets RefundNotAllowedException through, and an unexpected error stays what it is', async () => {
    const actor = await seedUser(UserRole.OWNER);
    const paymentId = await seedPayment();
    fakePayments(new RefundNotAllowedException("can't be refunded from here"));

    const failure = services.admin.refundPayment(actor, paymentId);
    await expect(failure).rejects.toBeInstanceOf(RefundNotAllowedException);
    await expect(failure).rejects.toThrow("can't be refunded from here");

    const bug = new Error('a bug');
    fakePayments(bug);
    await expect(services.admin.refundPayment(actor, paymentId)).rejects.toBe(bug);
  });

  it('lets a provider error propagate after the audit row', async () => {
    // The audit row is written BEFORE the provider call; the provider error propagates unchanged so the route can
    // throw (and the request transaction rolls both back).
    const actor = await seedUser(UserRole.OWNER);
    const paymentId = await seedPayment();
    fakePayments(new ProviderRefundError('telegram said no'));

    await expect(services.admin.refundPayment(actor, paymentId)).rejects.toBeInstanceOf(ProviderRefundError);

    const rows = await t.db
      .select()
      .from(adminAuditLogs)
      .where(and(eq(adminAuditLogs.action, 'refund_payment'), eq(adminAuditLogs.actorUserId, actor.id)));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.detail?.payment_id).toBe(paymentId);
  });
});
