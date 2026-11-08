import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Repos } from '../../repos';
import { Services } from '../../services';
import { createTestApp, createUser, type TestApp } from '../../testing';
import { AlreadyMemberError } from './service';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.close());

const services = () => new Services(new Repos(t.db), t.fakes.producer, t.fakes.bot.bot, t.fakes.redis, t.fakes.queue);

describe('GroupsService', () => {
  it('create adds the creator as an admin member', async () => {
    const creator = await createUser(t.db);
    const s = services();
    const group = await s.groups.create(creator.id, 'Friends');
    expect(group).toMatchObject({ title: 'Friends', creatorId: creator.id, photoUrl: null });
    const members = await s.groups.getMembers(group.id);
    expect(members.map((m) => m.id)).toEqual([creator.id]);
    expect(await s.groups.isMember(group.id, creator.id)).toBe(true);
    const row = await s.repos.members.getByMembership(group.id, creator.id);
    expect(row?.isAdmin).toBe(true);
  });

  it('addMember refuses a second time, removeMember removes', async () => {
    const [creator, other] = [await createUser(t.db), await createUser(t.db)];
    const s = services();
    const group = await s.groups.create(creator.id);
    const member = await s.groups.addMember(group.id, other.id);
    expect(member.isAdmin).toBe(false);
    await expect(s.groups.addMember(group.id, other.id)).rejects.toBeInstanceOf(AlreadyMemberError);
    await s.groups.removeMember(group.id, other.id);
    expect(await s.groups.isMember(group.id, other.id)).toBe(false);
    expect(await s.groups.getById(group.id)).toMatchObject({ id: group.id });
    expect(await s.groups.getById(2_000_000_000)).toBeNull();
  });
});
