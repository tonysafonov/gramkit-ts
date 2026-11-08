import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { groupInvites } from '../../db/schema';
import { Repos } from '../../repos';
import { Services } from '../../services';
import { asUser, createTestApp, createUser, type TestApp } from '../../testing';
import { MOCK_GUEST_USER_ID } from '../auth/resolve-user';
import { json } from '../users/test-json';
import { InviteError, isIntegrityError } from './service';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.close());

const services = () => new Services(new Repos(t.db), t.fakes.producer, t.fakes.bot.bot, t.fakes.redis, t.fakes.queue);

describe('GET /create_invite', () => {
  it('returns the bare code as a JSON string, for a group the creator administers', async () => {
    const user = await createUser(t.db);
    const res = await t.client.get('/create_invite', { headers: asUser(user) });
    expect(res.status).toBe(200);
    const code = await json(res);
    expect(code).toMatch(/^[0-9a-f]{12}$/);
    const [invite] = await t.db.select().from(groupInvites).where(eq(groupInvites.code, code));
    expect(invite?.creatorId).toBe(user.id);
    expect(invite?.usedCount).toBe(0);
    const days = ((invite?.expiresAt?.getTime() ?? 0) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(364);
    expect(days).toBeLessThanOrEqual(365);
    expect(await services().groups.isMember(invite?.groupId as number, user.id)).toBe(true);
  });
});

describe('GET /create_invite for the shared guest', () => {
  it('is a 401 and makes no group: whoever joined it would befriend every logged-out visitor', async () => {
    const res = await t.client.get('/create_invite');
    expect(res.status).toBe(401);
    expect(await json(res)).toEqual({ detail: { error: 'not_authenticated', message: 'Login required' } });
    expect(await t.db.select().from(groupInvites).where(eq(groupInvites.creatorId, MOCK_GUEST_USER_ID))).toEqual([]);
  });
});

describe('processInvite', () => {
  it('adds the invitee to the group and befriends every member', async () => {
    const [creator, second, invitee] = [await createUser(t.db), await createUser(t.db), await createUser(t.db)];
    const s = services();
    const code = await s.invites.createInvite(creator.id);
    const [invite] = await t.db.select().from(groupInvites).where(eq(groupInvites.code, code));
    await s.groups.addMember(invite?.groupId as number, second.id);

    const group = await s.invites.processInvite(code, invitee.id);
    expect(group.id).toBe(invite?.groupId);
    expect(group.users.map((u) => u.id).sort()).toEqual([creator.id, second.id, invitee.id].sort());
    expect(group.users.every((u) => !('passwordHash' in u))).toBe(true);
    expect((await s.users.getFriends(invitee.id)).map((u) => u.id).sort()).toEqual([creator.id, second.id].sort());
    expect((await s.users.getFriends(creator.id)).map((u) => u.id)).toContain(invitee.id);

    const [after] = await t.db.select().from(groupInvites).where(eq(groupInvites.code, code));
    expect(after?.usedCount).toBe(1);
  });

  it('is a no-op for a member already in the group', async () => {
    const [creator, invitee] = [await createUser(t.db), await createUser(t.db)];
    const s = services();
    const code = await s.invites.createInvite(creator.id);
    await s.invites.processInvite(code, invitee.id);
    const again = await s.invites.processInvite(code, invitee.id);
    expect(again.users).toEqual([]);
    const [invite] = await t.db.select().from(groupInvites).where(eq(groupInvites.code, code));
    expect(invite?.usedCount).toBe(1);
  });

  it('survives a friendship that exists but is inactive (unique violation), and the transaction stays usable', async () => {
    const [creator, invitee] = [await createUser(t.db), await createUser(t.db)];
    const s = services();
    await s.users.addFriend(creator.id, invitee.id);
    await t.db.execute(`update friendships set is_active = false` as never).catch(() => undefined);
    const code = await s.invites.createInvite(creator.id);
    await t.db.transaction(async (tx) => {
      const inTx = new Services(new Repos(tx), t.fakes.producer, t.fakes.bot.bot, t.fakes.redis, t.fakes.queue);
      await inTx.repos.users.updateUser(invitee.id, { displayName: 'before' });
      await inTx.invites.processInvite(code, invitee.id);
      expect((await inTx.users.getUserById(invitee.id))?.displayName).toBe('before');
    });
  });

  it('throws InviteError for an unknown code', async () => {
    const user = await createUser(t.db);
    await expect(services().invites.processInvite('nosuchcode00', user.id)).rejects.toThrow(InviteError);
  });

  it('deletes an expired invite and throws InviteError', async () => {
    const [creator, invitee] = [await createUser(t.db), await createUser(t.db)];
    const s = services();
    const code = await s.invites.createInvite(creator.id);
    await t.db
      .update(groupInvites)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(groupInvites.code, code));
    await expect(s.invites.processInvite(code, invitee.id)).rejects.toThrow('Invite expired');
    expect(await t.db.select().from(groupInvites).where(eq(groupInvites.code, code))).toEqual([]);
  });
});

describe('isIntegrityError', () => {
  it('recognises SQLSTATE class 23, also behind a cause', () => {
    expect(isIntegrityError(Object.assign(new Error('x'), { code: '23505' }))).toBe(true);
    expect(isIntegrityError(new Error('wrapped', { cause: Object.assign(new Error('x'), { code: '23503' }) }))).toBe(
      true,
    );
    expect(isIntegrityError(Object.assign(new Error('x'), { code: '08006' }))).toBe(false);
    expect(isIntegrityError('nope')).toBe(false);
  });
});
