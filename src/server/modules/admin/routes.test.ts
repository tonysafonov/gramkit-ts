/**
 * The admin API contract: RBAC meta, audit log, admin tasks (incl. the app's `users_overview`), users list / detail /
 * sub-lists, gift, revoke, role change, reset, refund, and the Overview. Port of `testing/contracts/admin.py`,
 * `testing/contracts/admin_statistics.py` (Overview part; the analytics routes belong to the analytics module) and the
 * app's `test_admin_tasks.py` / `contracts/api/test_admin_routes.py`.
 *
 * Rule: every owner-gated endpoint has an admin -> 403 test, and every admin-gated endpoint a user -> 403 test.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { settings } from '../../config';
import { PaymentProvider, PaymentStatus, payments, UserRole } from '../../db/schema';
import { asUser, createTestApp, createUser, type TestApp } from '../../testing';
import { type AdminTask, adminTask, adminTaskRegistry } from '../admin-tasks/registry';

// The wire body of a response, loosely typed: the tests assert its shape.
// biome-ignore lint/suspicious/noExplicitAny: a response body
const json = async (res: Response): Promise<any> => res.json();

let t: TestApp;
let admin: { headers: Record<string, string> };
let owner: { headers: Record<string, string> };
let user: { headers: Record<string, string> };
let ownerId: string;

beforeAll(async () => {
  t = await createTestApp();
  admin = { headers: asUser(await createUser(t.db, { role: UserRole.ADMIN })) };
  const ownerUser = await createUser(t.db, { role: UserRole.OWNER });
  ownerId = ownerUser.id;
  owner = { headers: asUser(ownerUser) };
  user = { headers: asUser(await createUser(t.db, { role: UserRole.USER })) };
});
afterAll(() => t.close());

const seedUser = async (username?: string): Promise<string> =>
  (await createUser(t.db, { username: username ?? `target_${randomUUID().slice(0, 8)}`, role: UserRole.USER })).id;

async function seedCardPayment(userId: string): Promise<string> {
  const [payment] = await t.db
    .insert(payments)
    .values({
      userId,
      productId: 'TEST_PRODUCT',
      providerId: PaymentProvider.YOOKASSA,
      amount: 555,
      currency: 'RUB',
      status: PaymentStatus.SUCCEEDED,
    })
    .returning();
  return (payment as { id: string }).id;
}

const auditRows = async (action: string, userId: string) => {
  const res = await t.client.get(`/admin/audit-log?action=${action}&target_user_id=${userId}`, admin);
  expect(res.status).toBe(200);
  // biome-ignore lint/suspicious/noExplicitAny: audit rows, asserted loosely
  return (await json(res)).items as Record<string, any>[];
};

describe('RBAC meta', () => {
  it('returns the admin capabilities', async () => {
    const res = await t.client.get('/admin/meta/rbac', admin);

    expect(res.status).toBe(200);
    const data = await json(res);
    expect(typeof data.role).toBe('string');
    expect(data.is_admin).toBe(true);
    expect(typeof data.is_owner).toBe('boolean');
    // Admin (not owner) cannot perform destructive actions.
    expect(data.can_perform_destructive).toBe(data.is_owner);
  });

  it('is forbidden for a non-admin', async () => {
    expect((await t.client.get('/admin/meta/rbac', user)).status).toBe(403);
  });
});

describe('audit log', () => {
  it('returns the paginated envelope', async () => {
    const res = await t.client.get('/admin/audit-log', admin);

    expect(res.status).toBe(200);
    const data = await json(res);
    expect(Array.isArray(data.items)).toBe(true);
    expect(Number.isInteger(data.total)).toBe(true);
    expect(data.page).toBe(1);
    expect(Number.isInteger(data.page_size)).toBe(true);
    expect(Number.isInteger(data.total_pages)).toBe(true);
  });

  it('echoes the pagination params', async () => {
    const data = await json(await t.client.get('/admin/audit-log?page=2&page_size=5', admin));

    expect(data.page).toBe(2);
    expect(data.page_size).toBe(5);
  });

  it('rejects out-of-range pagination with a 422', async () => {
    expect((await t.client.get('/admin/audit-log?page_size=101', admin)).status).toBe(422);
    expect((await t.client.get('/admin/audit-log?page=0', admin)).status).toBe(422);
    expect((await t.client.get('/admin/audit-log?sort_dir=sideways', admin)).status).toBe(422);
  });

  it('is forbidden for a non-admin', async () => {
    expect((await t.client.get('/admin/audit-log', user)).status).toBe(403);
  });

  it('lists the recorded actions as strings', async () => {
    const userId = await seedUser();
    await t.client.post(`/admin/users/${userId}/gift-subscription`, { duration: 'week' }, admin);

    const res = await t.client.get('/admin/audit-log/actions', admin);

    expect(res.status).toBe(200);
    const actions = await json(res);
    expect(Array.isArray(actions)).toBe(true);
    expect(actions.every((a: unknown) => typeof a === 'string')).toBe(true);
    expect(actions).toContain('gift_subscription');
  });

  it('forbids the actions list for a non-admin', async () => {
    expect((await t.client.get('/admin/audit-log/actions', user)).status).toBe(403);
  });
});

describe('tasks (list: admin, run: owner)', () => {
  let saved: Map<string, AdminTask>;
  let name: string;
  let calls: boolean[];

  /** Register a uniquely named destructive probe task, as the contract's `probe_task` fixture does. */
  const registerProbe = () => {
    saved = new Map(adminTaskRegistry);
    name = `contract_probe_${randomUUID().slice(0, 8)}`;
    calls = [];
    adminTask(name, 'Contract probe.', { destructive: true }, async (_db, { dryRun }) => {
      calls.push(dryRun);
      return { applied: !dryRun, probe: true };
    });
  };
  afterEach(() => {
    adminTaskRegistry.clear();
    for (const [key, task] of saved ?? []) adminTaskRegistry.set(key, task);
  });

  it('lists a registered task', async () => {
    registerProbe();

    const res = await t.client.get('/admin/tasks', admin);

    expect(res.status).toBe(200);
    const tasks = (await json(res)) as { name: string; description: string; destructive: boolean }[];
    expect(tasks.every((task) => Object.keys(task).sort().join() === 'description,destructive,name')).toBe(true);
    const probe = tasks.find((task) => task.name === name);
    expect(probe?.destructive).toBe(true);
    expect(probe?.description).toBe('Contract probe.');
  });

  it('forbids listing for a non-admin', async () => {
    expect((await t.client.get('/admin/tasks', user)).status).toBe(403);
  });

  it('forbids running for an admin', async () => {
    registerProbe();

    expect((await t.client.post(`/admin/tasks/${name}`, {}, admin)).status).toBe(403);
    expect(calls).toEqual([]);
  });

  it('forbids running for a non-admin', async () => {
    registerProbe();

    expect((await t.client.post(`/admin/tasks/${name}`, {}, user)).status).toBe(403);
    expect(calls).toEqual([]);
  });

  it('answers 404 for an unknown task', async () => {
    const unknown = `no_such_task_${randomUUID().slice(0, 8)}`;

    const res = await t.client.post(`/admin/tasks/${unknown}`, {}, owner);

    expect(res.status).toBe(404);
    expect((await json(res)).detail).toBe(`Unknown task: ${unknown}`);
  });

  it('defaults to a dry run', async () => {
    registerProbe();

    const res = await t.client.post(`/admin/tasks/${name}`, {}, owner);

    expect(res.status).toBe(200);
    const data = await json(res);
    expect(data.task).toBe(name);
    expect(data.dry_run).toBe(true);
    expect(data.result).toEqual({ applied: false, probe: true });
    expect(calls).toEqual([true]);
  });

  it('applies on dry_run false', async () => {
    registerProbe();

    const res = await t.client.post(`/admin/tasks/${name}`, { dry_run: false }, owner);

    expect(res.status).toBe(200);
    const data = await json(res);
    expect(data.dry_run).toBe(false);
    expect(data.result).toEqual({ applied: true, probe: true });
    expect(calls).toEqual([false]);
  });

  it('writes an audit row for every run', async () => {
    registerProbe();
    await t.client.post(`/admin/tasks/${name}`, {}, owner);

    const res = await t.client.get(`/admin/audit-log?action=admin_task:${name}`, owner);

    expect(res.status).toBe(200);
    const rows = (await json(res)).items;
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_role).toBe('owner');
    expect(rows[0].target_type).toBe('admin_task');
    expect(rows[0].target_id).toBe(name);
    expect(rows[0].detail).toEqual({ dry_run: true, result: { applied: false, probe: true } });
  });

  it('lists and runs the app task users_overview', async () => {
    const listed = await t.client.get('/admin/tasks', owner);
    expect(listed.status).toBe(200);
    expect(((await json(listed)) as { name: string }[]).map((task) => task.name)).toContain('users_overview');

    const res = await t.client.post('/admin/tasks/users_overview', {}, owner);

    expect(res.status).toBe(200);
    const data = await json(res);
    expect(data.task).toBe('users_overview');
    expect(data.result.applied).toBe(false);
    expect(data.result.by_role.owner).toBeGreaterThanOrEqual(1);
    expect(Object.values(data.result.by_type as Record<string, number>).reduce((a, b) => a + b, 0)).toBe(
      data.result.total_users,
    );
    expect(data.result.new_last_7_days).toBeGreaterThanOrEqual(1);
  });
});

describe('users list', () => {
  it('returns the paginated envelope', async () => {
    const res = await t.client.get('/admin/users', admin);

    expect(res.status).toBe(200);
    const data = await json(res);
    expect(Array.isArray(data.items)).toBe(true);
    expect(Number.isInteger(data.total)).toBe(true);
    expect(data.page).toBe(1);
  });

  it('narrows rows with the role filter', async () => {
    await seedUser();

    const res = await t.client.get('/admin/users?role=admin', admin);

    expect(res.status).toBe(200);
    const items = (await json(res)).items as { role: string }[];
    expect(items.length).toBeGreaterThan(0); // the admin client's own user
    expect(items.every((item) => item.role === 'admin')).toBe(true);
  });

  it('finds a seeded username by search', async () => {
    const username = `needle_${randomUUID().slice(0, 8)}`;
    const userId = await seedUser(username);

    const data = await json(await t.client.get(`/admin/users?search=${username}`, admin));

    expect(data.total).toBe(1);
    expect(data.items[0].id).toBe(userId);
    expect(data.items[0].username).toBe(username);
  });

  it('is forbidden for a non-admin', async () => {
    expect((await t.client.get('/admin/users', user)).status).toBe(403);
  });
});

describe('user detail', () => {
  it('returns the core fields', async () => {
    const userId = await seedUser();

    const res = await t.client.get(`/admin/users/${userId}`, admin);

    expect(res.status).toBe(200);
    const data = await json(res);
    expect(data.id).toBe(userId);
    expect(data.role).toBe('user');
    expect(typeof data.user_type).toBe('string');
    expect(Number.isInteger(data.payments_count)).toBe(true);
    expect(data.active_subscription).toBeNull();
    expect(data.has_active_subscription).toBe(false);
    expect(typeof data.is_config_owner).toBe('boolean');
    // App-specific data is served by app endpoints, never on the core detail.
    expect(data).not.toHaveProperty('balance');
  });

  it('answers 404 for an unknown user', async () => {
    const res = await t.client.get(`/admin/users/${randomUUID()}`, admin);

    expect(res.status).toBe(404);
    expect((await json(res)).detail).toBe('User not found');
  });

  it('answers 422 for a non-UUID id', async () => {
    expect((await t.client.get('/admin/users/not-a-uuid', admin)).status).toBe(422);
  });

  it('is forbidden for a non-admin', async () => {
    expect((await t.client.get(`/admin/users/${await seedUser()}`, user)).status).toBe(403);
  });
});

describe('per-user sub-lists', () => {
  it('returns the payments envelope', async () => {
    const userId = await seedUser();
    await seedCardPayment(userId);

    const res = await t.client.get(`/admin/users/${userId}/payments`, admin);

    expect(res.status).toBe(200);
    const data = await json(res);
    expect(data.total).toBe(1);
    expect(typeof data.items[0].status).toBe('string');
    expect(data.items[0].amount).toBe(555);
  });

  it('returns the subscriptions list', async () => {
    const res = await t.client.get(`/admin/users/${await seedUser()}/subscriptions`, admin);

    expect(res.status).toBe(200);
    expect(Array.isArray(await json(res))).toBe(true);
  });

  it('forbids the payments for a non-admin', async () => {
    expect((await t.client.get(`/admin/users/${await seedUser()}/payments`, user)).status).toBe(403);
  });

  it('forbids the subscriptions for a non-admin', async () => {
    expect((await t.client.get(`/admin/users/${await seedUser()}/subscriptions`, user)).status).toBe(403);
  });
});

describe('gift / revoke (admin)', () => {
  it('gifts, activates and audits', async () => {
    const userId = await seedUser();

    const res = await t.client.post(`/admin/users/${userId}/gift-subscription`, { duration: 'week' }, admin);

    expect(res.status).toBe(200);
    const data = await json(res);
    expect(data.has_active_subscription).toBe(true);
    expect(typeof data.active_subscription.status).toBe('string');

    const rows = await auditRows('gift_subscription', userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actor_role).toBe('admin');
    expect(rows[0]?.detail.duration).toBe('week');
  });

  it('answers 404 when gifting an unknown user', async () => {
    const res = await t.client.post(`/admin/users/${randomUUID()}/gift-subscription`, { duration: 'week' }, admin);
    expect(res.status).toBe(404);
  });

  it('rejects an unknown duration with a 422', async () => {
    const res = await t.client.post(
      `/admin/users/${await seedUser()}/gift-subscription`,
      { duration: 'decade' },
      admin,
    );
    expect(res.status).toBe(422);
  });

  it('forbids gifting for a non-admin', async () => {
    const res = await t.client.post(`/admin/users/${await seedUser()}/gift-subscription`, { duration: 'week' }, user);
    expect(res.status).toBe(403);
  });

  it('revokes and audits', async () => {
    const userId = await seedUser();
    // Gift first so there is something to revoke.
    await t.client.post(`/admin/users/${userId}/gift-subscription`, { duration: 'week' }, admin);

    const res = await t.client.post(`/admin/users/${userId}/revoke-subscription`, undefined, admin);

    expect(res.status).toBe(200);
    const rows = await auditRows('revoke_subscription', userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.detail).toEqual({ reason: 'admin_revoked' });
  });

  it('forbids revoking for a non-admin', async () => {
    const res = await t.client.post(`/admin/users/${await seedUser()}/revoke-subscription`, undefined, user);
    expect(res.status).toBe(403);
  });
});

describe('role change (owner)', () => {
  it('changes the role and audits', async () => {
    const userId = await seedUser();

    const res = await t.client.post(`/admin/users/${userId}/role`, { new_role: 'admin' }, owner);

    expect(res.status).toBe(200);
    expect((await json(res)).role).toBe('admin');
    const rows = await auditRows('change_role', userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actor_role).toBe('owner');
    expect(rows[0]?.detail.previous_role).toBe('user');
    expect(rows[0]?.detail.new_role).toBe('admin');
  });

  it('rejects an unknown role with a 422', async () => {
    const res = await t.client.post(`/admin/users/${await seedUser()}/role`, { new_role: 'god' }, owner);
    expect(res.status).toBe(422);
  });

  it('is forbidden for an admin', async () => {
    const res = await t.client.post(`/admin/users/${await seedUser()}/role`, { new_role: 'admin' }, admin);
    expect(res.status).toBe(403);
  });

  it('is forbidden for a non-admin', async () => {
    const res = await t.client.post(`/admin/users/${await seedUser()}/role`, { new_role: 'admin' }, user);
    expect(res.status).toBe(403);
  });
});

describe('reset (owner, DEBUG-only)', () => {
  const debugBefore = settings.debug;
  afterEach(() => {
    settings.debug = debugBefore;
  });

  it('answers 404 when DEBUG is off, even for an owner', async () => {
    settings.debug = false;

    const res = await t.client.post(`/admin/users/${await seedUser()}/reset`, undefined, owner);

    expect(res.status).toBe(404);
  });

  it('is forbidden for an admin when DEBUG is on (a 404 cannot mask the gate)', async () => {
    settings.debug = true;

    const res = await t.client.post(`/admin/users/${await seedUser()}/reset`, undefined, admin);

    expect(res.status).toBe(403);
  });

  it('hard-deletes the user (204) and the audit row survives', async () => {
    settings.debug = true;
    const userId = await seedUser();

    const res = await t.client.post(`/admin/users/${userId}/reset`, undefined, owner);

    expect(res.status).toBe(204);
    expect((await t.client.get(`/admin/users/${userId}`, owner)).status).toBe(404);
    const rows = await auditRows('reset_user', userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.target_id).toBe(userId);
    expect(rows[0]?.detail.role).toBe('user');
  });

  it('refuses a self-reset (400) and the owner survives', async () => {
    settings.debug = true;

    const res = await t.client.post(`/admin/users/${ownerId}/reset`, undefined, owner);

    expect(res.status).toBe(400);
    expect((await json(res)).detail).toBe("Can't reset your own account");
    expect((await t.client.get(`/admin/users/${ownerId}`, owner)).status).toBe(200);
  });

  it('answers 404 for an unknown user when DEBUG is on', async () => {
    settings.debug = true;

    expect((await t.client.post(`/admin/users/${randomUUID()}/reset`, undefined, owner)).status).toBe(404);
  });
});

describe('refund (owner)', () => {
  it('is forbidden for an admin', async () => {
    const paymentId = await seedCardPayment(await seedUser());

    expect((await t.client.post(`/admin/payments/${paymentId}/refund`, undefined, admin)).status).toBe(403);
  });

  it('answers 404 for an unknown payment', async () => {
    const res = await t.client.post(`/admin/payments/${randomUUID()}/refund`, undefined, owner);

    expect(res.status).toBe(404);
    expect((await json(res)).detail).toBe('Payment not found');
  });

  it('refuses a card payment (400, with the service reason)', async () => {
    // A provider without a refund API here: YooKassa refunds are made in its dashboard.
    const paymentId = await seedCardPayment(await seedUser());

    const res = await t.client.post(`/admin/payments/${paymentId}/refund`, undefined, owner);

    expect(res.status).toBe(400);
    expect(typeof (await json(res)).detail).toBe('string');
  });
});

describe('Overview', () => {
  it('has the core blocks, not degraded', async () => {
    const res = await t.client.get('/admin/statistics/overview', admin);
    expect(res.status, await res.clone().text()).toBe(200);
    const data = await json(res);

    expect(data.error).toBeNull();
    expect(typeof data.date).toBe('string');
    for (const key of [
      'total',
      'new_today',
      'new_this_week',
      'new_this_month',
      'new_prev_day',
      'new_prev_week',
      'new_prev_month',
      'dau',
      'wau',
      'mau',
    ]) {
      expect(Number.isInteger(data.users[key]), key).toBe(true);
    }
    // Revenue is per-currency maps (never a scalar sum).
    for (const key of ['alltime', 'today', 'this_week', 'this_month']) {
      expect(typeof data.revenue[key], key).toBe('object');
    }
    expect(typeof data.product_sales.alltime).toBe('object');
    expect(typeof data.product_sales.today).toBe('object');
    expect(Number.isInteger(data.subscriptions.active_subscribers)).toBe(true);

    expect(Array.isArray(data.cards)).toBe(true);
    for (const card of data.cards) {
      expect(['number', 'percent', 'currency']).toContain(card.format);
      expect(Array.isArray(card.sparkline)).toBe(true);
    }
  });

  it('counts a seeded revenue', async () => {
    await seedCardPayment(await seedUser());

    const data = await json(await t.client.get('/admin/statistics/overview', admin));

    expect(data.revenue.alltime.RUB).toBeGreaterThanOrEqual(555);
  });

  it('is forbidden for a non-admin', async () => {
    expect((await t.client.get('/admin/statistics/overview', user)).status).toBe(403);
  });
});

describe('route table', () => {
  it('does not mount the legacy demo stubs', async () => {
    for (const path of ['/admin/stats', '/admin/me', '/admin/demo-action']) {
      expect((await t.client.get(path, admin)).status, path).toBe(404);
    }
  });

  it('mounts the core admin API', async () => {
    for (const path of ['/admin/users', '/admin/audit-log', '/admin/meta/rbac']) {
      expect((await t.client.get(path, admin)).status, path).toBe(200);
    }
  });
});
