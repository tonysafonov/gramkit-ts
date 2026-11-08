import type { Group, GroupMember, User } from '../../db/schema';
import { BaseService } from '../../lib/base-service';

/** Python raises `ValueError` here; `InvitesService.processInvite` catches it. */
export class AlreadyMemberError extends Error {}

export class GroupsService extends BaseService {
  /** Create a new group and add the creator as an admin member. */
  async create(creatorId: string, title: string | null = null, photoUrl: string | null = null): Promise<Group> {
    const group = await this.repos.groups.create({ title, creatorId, photoUrl });
    await this.repos.members.create({ groupId: group.id, userId: creatorId, isAdmin: true });
    return group;
  }

  /** Add a user to a group. Throws `AlreadyMemberError` if they're in it. */
  async addMember(groupId: number, userId: string, isAdmin = false): Promise<GroupMember> {
    if (await this.repos.members.getByMembership(groupId, userId)) {
      throw new AlreadyMemberError('User is already a member of this group');
    }
    return this.repos.members.create({ groupId, userId, isAdmin });
  }

  async removeMember(groupId: number, userId: string): Promise<void> {
    await this.repos.members.deleteMembership(groupId, userId);
  }

  getById(groupId: number): Promise<Group | null> {
    return this.repos.groups.getById(groupId);
  }

  /** All members of a group, as user rows. */
  getMembers(groupId: number): Promise<User[]> {
    return this.repos.members.getMembers(groupId);
  }

  async isMember(groupId: number, userId: string): Promise<boolean> {
    return (await this.repos.members.getByMembership(groupId, userId)) !== null;
  }
}
