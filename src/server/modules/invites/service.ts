import { BaseService } from '../../lib/base-service';
import { AlreadyMemberError } from '../groups/service';
import { type GroupSchema, toGroupSchema, toUserSchema } from '../users/schemas';

const MAX_RETRIES = 3;
const INVITE_LIFETIME_MS = 365 * 24 * 3_600_000; // TODO: 1 year, change later

/** Python raises `ValueError` for these; `StartService` catches it: the app still opens. */
export class InviteError extends Error {}

/** A Postgres integrity-constraint violation (SQLSTATE class 23), unwrapping Drizzle's `cause`. */
export function isIntegrityError(err: unknown): boolean {
  for (let error = err; error instanceof Error; error = error.cause) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code.startsWith('23')) return true;
  }
  return false;
}

export class InvitesService extends BaseService {
  /** Create a group for the user and an invite to it; returns the invite code. */
  async createInvite(userId: string): Promise<string> {
    let lastError: unknown;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const group = await this.services.groups.create(userId);
        const invite = await this.repos.invites.create({
          creatorId: userId,
          groupId: group.id,
          expiresAt: new Date(Date.now() + INVITE_LIFETIME_MS),
        });
        return invite.code;
      } catch (err) {
        if (!isIntegrityError(err)) throw err;
        lastError = err;
      }
    }

    throw new Error(`Failed to create invite after ${MAX_RETRIES} attempts`, { cause: lastError });
  }

  /**
   * Add the invitee to the invite's group and make them friends with every member. Throws `InviteError` for an
   * unknown or expired invite (an expired one is deleted).
   */
  async processInvite(inviteCode: string, inviteeId: string): Promise<GroupSchema> {
    const invite = await this.repos.invites.getByCode(inviteCode);

    // TODO: change this logic later; for now a 1 year expiration
    if (!invite) throw new InviteError('Invite not found');

    if (invite.expiresAt === null || invite.expiresAt < new Date()) {
      await this.repos.invites.delete(invite.code);
      throw new InviteError('Invite expired');
    }

    const group = await this.services.groups.getById(invite.groupId);
    if (!group) throw new InviteError('Invite not found');

    try {
      await this.services.groups.addMember(invite.groupId, inviteeId);
      await this.repos.invites.update(invite.code, { usedCount: invite.usedCount + 1 });
    } catch (err) {
      if (err instanceof AlreadyMemberError) return toGroupSchema(group);
      throw err;
    }

    const members = await this.services.groups.getMembers(invite.groupId);

    // The invitee becomes a friend of every member, and the other way round
    for (const member of members) {
      if (member.id === inviteeId) continue;
      try {
        await this.services.users.addFriend(member.id, inviteeId);
      } catch (err) {
        if (!isIntegrityError(err)) throw err;
        // The friendship already exists: next member
      }
    }

    return toGroupSchema(group, members.map(toUserSchema));
  }
}
