import { and, eq } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { BaseRepo } from '../../db/repo/base';
import { type GroupMember, groupMembers, groups, type User, users } from '../../db/schema';

export class GroupsRepo extends BaseRepo<typeof groups> {
  constructor(db: Db) {
    super(db, groups, groups.id);
  }
}

/** `group_members` has the composite key (group_id, user_id): look rows up with `getByMembership`. */
export class GroupMembersRepo extends BaseRepo<typeof groupMembers> {
  constructor(db: Db) {
    super(db, groupMembers, groupMembers.id);
  }

  async getMembers(groupId: number): Promise<User[]> {
    const rows = await this.db
      .select({ user: users })
      .from(users)
      .innerJoin(groupMembers, eq(groupMembers.userId, users.id))
      .where(eq(groupMembers.groupId, groupId));
    return rows.map((row) => row.user);
  }

  async getByMembership(groupId: number, userId: string): Promise<GroupMember | null> {
    const rows = await this.db
      .select()
      .from(groupMembers)
      .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, userId)));
    return rows[0] ?? null;
  }

  async deleteMembership(groupId: number, userId: string): Promise<boolean> {
    const rows = await this.db
      .delete(groupMembers)
      .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, userId)))
      .returning({ groupId: groupMembers.groupId });
    return rows.length > 0;
  }
}
