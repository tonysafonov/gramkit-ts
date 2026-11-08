import type { Bot } from 'grammy';
import { posthog } from '../../clients/posthog';
import type { RabbitProducer } from '../../clients/rabbit';
import { BaseService } from '../../lib/base-service';
import { getLogger } from '../../lib/logging';
import type { Repos } from '../../repos';
import type { Services } from '../../services';
import { InviteError } from '../invites/service';
import { esc, tags, userRef, userTag } from '../messages/admin-messages';
import type { GroupSchema } from '../users/schemas';
import { isGuest, isNew, type UserSchema } from '../users/schemas';
import { isValidTimezone } from '../users/service';
import type { StartData, StartParams } from './schemas';

const logger = getLogger('start');

const DAY_MS = 86_400_000;

export class StartService extends BaseService {
  constructor(
    repos: Repos,
    producer: RabbitProducer,
    services: Services,
    bot: Bot | null,
    /** The app's own link codes (notification buttons, broadcasts): what brought a user back, never an acquisition source. */
    readonly internalReferalIds: ReadonlySet<string> = new Set(),
  ) {
    super(repos, producer, services, bot);
  }

  /** The app opened (may happen many times): register a new user, apply an invite, update the streak. */
  async processStart(initialUser: UserSchema, startParams: StartParams): Promise<StartData> {
    let user = initialUser;
    logger.info(`Processing start with params: ${JSON.stringify(startParams)}`);
    logger.info(
      `User ${user.id} opened app, new: ${isNew(user)}, created_at: ${user.createdAt?.toISOString()}, updated_at: ${user.updatedAt?.toISOString()}`,
    );

    const referalId = startParams.referalId || null;
    if (isNew(user) && !isGuest(user)) {
      // A user who pressed a bare /start and first opened the app from a notification has no known source: not the
      // notification.
      const source = referalId && !this.internalReferalIds.has(referalId) ? referalId : null;
      if (source) await this.services.users.processReferal(source, user.id);
      logger.info(`New user ${user.id} registered, source: ${source} (link: ${referalId})`);
      const details = [esc(user.languageCode || user.tgLanguageCode || '?')];
      if (user.tgIsPremium) details.push('⭐ Premium');
      if (source) details.push(`src <code>${esc(source)}</code>`);
      const message = `👤 New user · ${userRef(user)}\n<i>${details.join(' · ')}</i>\n${tags('newuser', userTag(user))}`;
      await this.services.messages.queueAdminBroadcast(message, { silent: true });
      posthog.capture(user.id, 'new_user_registered', {
        $set: { username: user.username },
        $set_once: { referal_id: source, invite_code: startParams.inviteCode ?? null },
      });
    } else {
      if (referalId) logger.info(`User ${user.id} opened app again, from ref ${referalId}`);
      else logger.info(`User ${user.id} opened app again`);

      posthog.capture(user.id, 'user_returned', {
        days_since_last_visit: user.updatedAt ? Math.floor((Date.now() - user.updatedAt.getTime()) / DAY_MS) : null,
        visit_number: user.totalActiveDays || 1,
        current_streak: user.currentStreak,
        best_streak: user.bestStreak,
      });
    }

    let inviter: GroupSchema | null = null;
    // Never for the guest: every logged-out visitor is that one row, so its group and friends would be everyone's,
    // and each of them could read the friends' profiles
    if (startParams.inviteCode && !isGuest(user)) {
      try {
        inviter = await this.services.invites.processInvite(startParams.inviteCode, user.id);
      } catch (err) {
        // Unknown or expired invite: the app still opens
        if (!(err instanceof InviteError)) throw err;
        logger.info(`Invite ${JSON.stringify(startParams.inviteCode)} not applied for ${user.id}: ${err.message}`);
      }
      if (inviter) {
        posthog.capture(user.id, 'invite_accepted', {
          inviter_id: String(inviter.id),
          invite_code: startParams.inviteCode,
        });
      }
    }

    if (!isGuest(user)) {
      if (user.timezone !== startParams.timezone && isValidTimezone(startParams.timezone)) {
        user = await this.services.users.updateUser(user.id, { timezone: startParams.timezone });
      }

      // Streak, for daily engagement tracking
      const updated = await this.services.users.updateUserStreak(user.id);
      if (updated) user = updated;
    }

    // PostHog person properties on every visit (after the streak update)
    if (!isGuest(user)) {
      const hasSubscription = await this.services.subscriptions.hasActiveSubscription(user.id);
      posthog.capture(user.id, '$set', {
        $set: {
          subscription_status: hasSubscription ? 'active' : 'free',
          current_streak: user.currentStreak,
          total_active_days: user.totalActiveDays,
          last_seen_at: new Date().toISOString(),
        },
        $set_once: { signup_date: user.createdAt ? user.createdAt.toISOString() : null },
      });
    }

    logger.info(`Start params: ${JSON.stringify(startParams)}`);
    return { currentUser: user, inviter, mode: startParams.mode ?? null };
  }
}
