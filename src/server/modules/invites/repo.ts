import type { Db } from '../../db/client';
import { BaseRepo } from '../../db/repo/base';
import { type GroupInvite, groupInvites, type NewGroupInvite } from '../../db/schema';

export class InvitesRepo extends BaseRepo<typeof groupInvites> {
  constructor(db: Db) {
    super(db, groupInvites, groupInvites.code);
  }

  /** The invite with this code, or `null`. */
  getByCode(code: string): Promise<GroupInvite | null> {
    return this.getById(code);
  }

  /**
   * Insert in a savepoint: a code collision raises a unique violation the caller retries on, and the request's
   * transaction stays usable.
   */
  override async create(data: NewGroupInvite): Promise<GroupInvite> {
    return this.db.transaction(async (tx) => {
      const rows = await tx.insert(groupInvites).values(data).returning();
      const row = rows[0];
      if (!row) throw new Error('group_invites: the write returned no row');
      return row;
    });
  }
}
