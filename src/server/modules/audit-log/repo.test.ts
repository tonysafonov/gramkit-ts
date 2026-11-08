/**
 * AuditLogRepo against real PostgreSQL: create, the action / actor / target filters, free-text search, the date range,
 * and `ON DELETE SET NULL` on the actor FK (the trail outlives the user). Port of
 * `tests/integration/repositories/test_audit_log_repo.py`.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminAuditLogs, type NewAuditLog, type User, UserRole, users } from '../../db/schema';
import { Repos } from '../../repos';
import { createTestApp, createUser, type TestApp } from '../../testing';
import type { AdminListParams } from '../admin/schemas';

let t: TestApp;
let repo: Repos['auditLog'];

beforeAll(async () => {
  t = await createTestApp();
  repo = new Repos(t.db).auditLog;
});
afterAll(() => t.close());

const params = (overrides: Partial<AdminListParams> = {}): AdminListParams => ({
  page: 1,
  pageSize: 25,
  sortDir: 'desc',
  ...overrides,
});
const short = () => randomUUID().slice(0, 8);
const seedUser = (role: string = UserRole.ADMIN) => createUser(t.db, { role, username: `actor_${short()}` });

const row = (actor: User | null, action: string, extra: Partial<NewAuditLog> = {}) =>
  repo.create({
    actorUserId: actor?.id ?? null,
    actorTelegramId: actor?.telegramId ?? null,
    actorUsername: actor?.username ?? null,
    actorRole: 'admin',
    action,
    ...extra,
  });

describe('create', () => {
  it('persists a row with an id and a timestamp', async () => {
    const actor = await seedUser();

    const created = await row(actor, 'gift_subscription', { targetType: 'user', targetId: 'abc', detail: { a: 1 } });

    expect(typeof created.id).toBe('number');
    expect(created.createdAt).toBeInstanceOf(Date);
    expect(created.actorUserId).toBe(actor.id);
    expect(created.detail).toEqual({ a: 1 });
  });
});

describe('filters', () => {
  it('action returns only that action', async () => {
    const actor = await seedUser();
    const action = `act_${short()}`;
    await row(actor, action);
    await row(actor, action);
    await row(actor, `other_${short()}`);

    const [rows, total] = await repo.listFiltered(params(), { action });

    expect(total).toBe(2);
    expect(new Set(rows.map((r) => r.action))).toEqual(new Set([action]));
  });

  it('actor returns only that actor', async () => {
    const actor = await seedUser();
    const other = await seedUser();
    await row(actor, 'change_role');
    await row(other, 'change_role');

    const [rows, total] = await repo.listFiltered(params(), { actorUserId: actor.id });

    expect(total).toBe(1);
    expect(rows[0]?.actorUserId).toBe(actor.id);
  });

  it('target user matches user targets only', async () => {
    const actor = await seedUser();
    const targetId = randomUUID();
    await row(actor, 'gift_subscription', { targetType: 'user', targetId });
    // Same id string but a different target type must not match.
    await row(actor, 'admin_task:x', { targetType: 'admin_task', targetId });

    const [rows, total] = await repo.listFiltered(params(), { targetUserId: targetId });

    expect(total).toBe(1);
    expect(rows[0]?.targetType).toBe('user');
    expect(rows[0]?.targetId).toBe(targetId);
  });

  it('search matches the action case-insensitively', async () => {
    const actor = await seedUser();
    const marker = short();
    await row(actor, `needle_${marker}`);
    await row(actor, `hay_${short()}`);

    const [rows, total] = await repo.listFiltered(params({ search: `NEEDLE_${marker.toUpperCase()}` }));

    expect(total).toBe(1);
    expect(rows[0]?.action).toBe(`needle_${marker}`);
  });

  it('matches LIKE metacharacters in the search literally', async () => {
    const actor = await seedUser();
    const marker = short();
    const literal = await row(actor, `lit_${marker}_x`);
    await row(actor, `lit_${marker}Zx`); // would match if "_" were a LIKE pattern character

    const [rows, total] = await repo.listFiltered(params({ search: `${marker}_x` }));
    expect(total).toBe(1);
    expect(rows[0]?.id).toBe(literal.id);

    const [, none] = await repo.listFiltered(params({ search: `lit_${marker}%x` }));
    expect(none).toBe(0);
  });

  it('bounds created_at with the date range', async () => {
    const actor = await seedUser();
    const action = `dated_${short()}`;
    const now = Date.now();
    const day = 24 * 3600 * 1000;
    await row(actor, action, { createdAt: new Date(now - 10 * day) });
    const inside = await row(actor, action, { createdAt: new Date(now - 5 * day) });
    await row(actor, action, { createdAt: new Date(now - 1 * day) });

    const [rows, total] = await repo.listFiltered(
      params({ dateFrom: new Date(now - 6 * day), dateTo: new Date(now - 4 * day) }),
      { action },
    );

    expect(total).toBe(1);
    expect(rows[0]?.id).toBe(inside.id);
  });

  it('returns the unpaginated total', async () => {
    const actor = await seedUser();
    const action = `paged_${short()}`;
    for (let i = 0; i < 3; i++) await row(actor, action);

    const [rows, total] = await repo.listFiltered(params({ page: 2, pageSize: 2 }), { action });

    expect(total).toBe(3);
    expect(rows).toHaveLength(1);
  });
});

describe('actor deletion', () => {
  it('sets actor_user_id to null and keeps the row (ON DELETE SET NULL)', async () => {
    const actor = await seedUser();
    const created = await row(actor, 'reset_user', { targetType: 'user', targetId: randomUUID() });
    const telegramId = actor.telegramId;

    await t.db.delete(users).where(eq(users.id, actor.id));
    const [after] = await t.db.select().from(adminAuditLogs).where(eq(adminAuditLogs.id, created.id));

    expect(after?.actorUserId).toBeNull();
    expect(after?.actorTelegramId).toBe(telegramId);
    expect(after?.action).toBe('reset_user');
  });
});

describe('distinctActions', () => {
  it('is sorted and deduplicated', async () => {
    const actor = await seedUser();
    const marker = short();
    for (const action of [`${marker}_b`, `${marker}_a`, `${marker}_b`]) await row(actor, action);

    const actions = await repo.distinctActions();

    expect(actions.filter((a) => a.startsWith(marker))).toEqual([`${marker}_a`, `${marker}_b`]);
    expect(actions).toHaveLength(new Set(actions).size);
  });

  it('respects the limit', async () => {
    const actor = await seedUser();
    for (let i = 0; i < 3; i++) await row(actor, `lim_${short()}_${i}`);

    expect(await repo.distinctActions(2)).toHaveLength(2);
  });
});
