import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { groupInvites, groupMembers, users } from '../../db/schema';
import { asUser, createTestApp, createUser, type TestApp } from '../../testing';
import { MOCK_GUEST_USER_ID } from '../auth/resolve-user';
import { json } from '../users/test-json';
import { INTERNAL_REFERRAL_CODES } from './referrals';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.close());

const adminJobs = () => t.fakes.queue.jobs.filter((job) => job.jobName === 'admin_broadcast_job');
const events = (name: string, userId: string) =>
  t.fakes.posthog.events.filter((e) => e.event === name && e.distinctId === userId);
const start = (user: { id: string }, body: object) => t.client.post('/process_start', body, { headers: asUser(user) });
const fresh = () => createUser(t.db, { lastActivityDate: null, referralCode: null, timezone: 'UTC' });

describe('POST /process_start: a new user is announced once (regression: is_new was time-based and spammed)', () => {
  it('multiple calls send ONE admin notification', async () => {
    const user = await fresh();
    const before = adminJobs().length;
    expect((await start(user, { referal_id: 'r-first', timezone: 'UTC' })).status).toBe(200);
    const afterFirst = adminJobs().length;
    expect(afterFirst).toBe(before + 1);

    expect((await start(user, { referal_id: 'r-second', timezone: 'UTC' })).status).toBe(200);
    expect(adminJobs().length).toBe(afterFirst);
  });

  it('sends the new_user_registered event once', async () => {
    const user = await fresh();
    await start(user, { referal_id: 'r-test', timezone: 'UTC' });
    expect(events('new_user_registered', user.id)).toHaveLength(1);
    await start(user, { referal_id: 'r-test-again', timezone: 'UTC' });
    expect(events('new_user_registered', user.id)).toHaveLength(1);
    expect(events('user_returned', user.id)).toHaveLength(1);
  });

  it('works for a user without a referal code', async () => {
    const user = await fresh();
    const before = adminJobs().length;
    await start(user, { timezone: 'UTC' });
    const first = adminJobs().length;
    await start(user, { timezone: 'UTC' });
    expect(first).toBe(before + 1);
    expect(adminJobs().length).toBe(first);
  });

  it('the announcement names the user and the source', async () => {
    const user = await fresh();
    const before = adminJobs().length;
    await start(user, { referal_id: 'partner_post3', timezone: 'UTC' });
    const job = adminJobs()[before];
    expect(job?.payload).toMatchObject({ silent: true });
    const text = String((job?.payload as { text?: string } | undefined)?.text);
    expect(text).toContain('New user');
    expect(text).toContain('src <code>partner_post3</code>');
    expect(text).toContain('#newuser');
  });
});

describe('POST /process_start: referral source', () => {
  const referral = async (id: string) => (await t.db.select().from(users).where(eq(users.id, id)))[0]?.referralCode;

  it('stores an external code as the first-touch source', async () => {
    const user = await fresh();
    await start(user, { referal_id: 'partner_post3' });
    expect(await referral(user.id)).toBe('partner_post3');
    expect(events('new_user_registered', user.id)[0]?.properties).toMatchObject({
      $set_once: { referal_id: 'partner_post3', invite_code: null },
    });
  });

  it("never stores the app's own link codes", async () => {
    const user = await fresh();
    await start(user, { referal_id: 'dailynotification' });
    expect(await referral(user.id)).toBeNull();
    expect(events('new_user_registered', user.id)[0]?.properties).toMatchObject({ $set_once: { referal_id: null } });
  });

  it('a returning user is not re-attributed', async () => {
    const user = await fresh();
    await start(user, { referal_id: 'first_touch' });
    await start(user, { referal_id: 'second_touch' });
    expect(await referral(user.id)).toBe('first_touch');
  });

  it("the service's internal codes are the app's INTERNAL_REFERRAL_CODES", () => {
    const services = new t.api.state.servicesClass(
      t.api.state.reposClass ? new t.api.state.reposClass(t.db as never) : (undefined as never),
      t.fakes.producer,
      t.fakes.bot.bot,
      t.fakes.redis,
      t.fakes.queue,
    );
    expect(new Set(services.start.internalReferalIds)).toEqual(new Set(INTERNAL_REFERRAL_CODES));
    expect(INTERNAL_REFERRAL_CODES.has('dailynotification')).toBe(true);
  });
});

describe('POST /process_start: the response and the streak', () => {
  it('returns current_user, inviter and mode in snake_case, with the streak applied', async () => {
    const user = await fresh();
    const res = await start(user, { mode: 'draw', timezone: 'UTC' });
    expect(res.status).toBe(200);
    const data = await json(res);
    expect(data.mode).toBe('draw');
    expect(data.inviter).toBeNull();
    expect(data.current_user).toMatchObject({ id: user.id, current_streak: 1, total_active_days: 1 });
    expect(data.current_user.last_activity_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(data.current_user).not.toHaveProperty('password_hash');
  });

  it('mode is null when not sent and a bad mode is a 422', async () => {
    const user = await fresh();
    expect((await json(await start(user, {}))).mode).toBeNull();
    expect((await start(user, { mode: 'nope' })).status).toBe(422);
  });

  it('takes a valid timezone and ignores an invalid one', async () => {
    const user = await fresh();
    const res = await start(user, { timezone: 'Asia/Tokyo' });
    expect((await json(res)).current_user.timezone).toBe('Asia/Tokyo');
    const bad = await start(user, { timezone: 'Mars/Phobos' });
    expect((await json(bad)).current_user.timezone).toBe('Asia/Tokyo');
  });

  it('sets the $set person properties for a registered user, not for a guest', async () => {
    const user = await fresh();
    const before = t.fakes.posthog.events.length;
    await start(user, {});
    const set = t.fakes.posthog.events.slice(before).find((e) => e.event === '$set' && e.distinctId === user.id);
    expect(set?.properties).toMatchObject({ $set: { current_streak: 1 } });
  });

  it('a guest is not registered and gets no streak', async () => {
    const guest = await createUser(t.db, { userType: 'GUEST', telegramId: null, lastActivityDate: null });
    const before = adminJobs().length;
    const res = await start(guest, { timezone: 'Asia/Tokyo' });
    const data = await json(res);
    expect(data.current_user.current_streak).toBe(0);
    expect(data.current_user.last_activity_date).toBeNull();
    expect(adminJobs().length).toBe(before);
  });
});

describe('POST /process_start: invites', () => {
  it('applies a valid invite: inviter group in the response, friendship made', async () => {
    const creator = await createUser(t.db);
    const invitee = await fresh();
    const code = await json(await t.client.get('/create_invite', { headers: asUser(creator) }));

    const res = await start(invitee, { invite_code: code, timezone: 'UTC' });
    expect(res.status).toBe(200);
    const data = await json(res);
    expect(data.inviter.users.map((u: { id: string }) => u.id).sort()).toEqual([creator.id, invitee.id].sort());
    expect(data.inviter).toHaveProperty('photo_url');
    expect(events('invite_accepted', invitee.id)[0]?.properties).toMatchObject({ invite_code: code });
    const friends = await json(await t.client.get('/friends', { headers: asUser(invitee) }));
    expect(friends.map((u: { id: string }) => u.id)).toEqual([creator.id]);
  });

  it('the shared guest never joins: no group, no friends, still opens', async () => {
    // Every logged-out visitor is the guest: its friends' profiles would be readable by all of them
    const creator = await createUser(t.db);
    const code = await json(await t.client.get('/create_invite', { headers: asUser(creator) }));

    const res = await t.client.post('/process_start', { invite_code: code, timezone: 'UTC' });

    expect(res.status).toBe(200);
    const data = await json(res);
    expect(data.current_user.id).toBe(MOCK_GUEST_USER_ID);
    expect(data.inviter).toBeNull();
    expect(await t.db.select().from(groupMembers).where(eq(groupMembers.userId, MOCK_GUEST_USER_ID))).toEqual([]);
    const friends = await json(await t.client.get('/friends', { headers: asUser(creator) }));
    expect(friends).toEqual([]);
    const [invite] = await t.db.select().from(groupInvites).where(eq(groupInvites.code, code));
    expect(invite?.usedCount).toBe(0);
  });

  it('an unknown invite does not stop the app from opening', async () => {
    const user = await fresh();
    const res = await start(user, { invite_code: 'nosuchcode00', timezone: 'UTC' });
    expect(res.status).toBe(200);
    expect((await json(res)).inviter).toBeNull();
    expect(events('invite_accepted', user.id)).toHaveLength(0);
  });

  it('an expired invite does not stop the app, and is deleted for good', async () => {
    const creator = await createUser(t.db);
    const user = await fresh();
    const code = await json(await t.client.get('/create_invite', { headers: asUser(creator) }));
    await t.db
      .update(groupInvites)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(groupInvites.code, code));
    const res = await start(user, { invite_code: code });
    expect(res.status).toBe(200);
    expect((await json(res)).inviter).toBeNull();
    expect(await t.db.select().from(groupInvites).where(eq(groupInvites.code, code))).toEqual([]);
  });
});
