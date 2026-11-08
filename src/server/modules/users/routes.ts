import { Hono } from 'hono';
import { setCookie } from 'hono/cookie';
import { z } from 'zod';
import { getUser } from '../../auth/context';
import type { Env } from '../../env';
import { ForbiddenError, NotFoundError, UserNotFoundException } from '../../lib/errors';
import { getLogger } from '../../lib/logging';
import { validate } from '../../lib/validate';
import { HARD_LIMIT, rateLimit, SOFT_LIMIT } from '../../middleware/rate-limit';
import { requireUserId } from '../auth/routes';
import { isGuest, SeenFeaturesPatch, toUpdateUserRequest, toUserResponse, UpdateUserBody } from './schemas';

const logger = getLogger('users');

const ONE_YEAR_SECONDS = 31_536_000;

/** `/users/*`: the current user's profile. */
export const usersRoutes = new Hono<Env>()
  .get('/me', getUser, rateLimit(SOFT_LIMIT), (c) => c.json(toUserResponse(c.get('user'))))
  .patch('/me', getUser, rateLimit(HARD_LIMIT), validate('json', UpdateUserBody), async (c) => {
    const user = c.get('user');
    // Every logged-out visitor is the same GUEST row, and the guest's refresh leaves its null fields (username,
    // avatar_url, birth_date, male) as they are: one visitor's edit would show to all of them.
    if (isGuest(user)) throw new ForbiddenError('Sign in to edit your profile');
    const body = c.req.valid('json');
    const updated = await c.get('services').users.updateUser(user.id, toUpdateUserRequest(body));
    if (body.is_onboarded === true) {
      setCookie(c, 'user_onboarded', 'true', {
        path: '/',
        maxAge: ONE_YEAR_SECONDS,
        httpOnly: false,
        sameSite: 'Lax',
      });
    }
    return c.json(toUserResponse(updated));
  })
  // Merge feature-seen flags into the current user's `seen_features`; returns the user so clients refresh /users/me.
  .patch('/me/seen-features', getUser, rateLimit(HARD_LIMIT), validate('json', SeenFeaturesPatch), async (c) => {
    const user = c.get('user');
    // Every logged-out web visitor is the same GUEST row, so one visitor's dismissal would hide the UI moment for all
    // of them. Gating state is per signed-in user only.
    if (isGuest(user)) throw new ForbiddenError('Sign in to save seen features');
    const updated = await c.get('services').users.mergeSeenFeatures(user.id, c.req.valid('json'));
    return c.json(toUserResponse(updated));
  });

const FriendQuery = z.object({ friend_id: z.uuid() });

/**
 * Python's `routers.base` part about friends: `/friends`, `/add_friend`. Mounted with no prefix. Signed-in users only:
 * the guest is every logged-out visitor, who would all read its friends' profiles (email, Telegram id, birth date).
 */
export const friendsRoutes = new Hono<Env>()
  .get('/friends', getUser, rateLimit(SOFT_LIMIT), async (c) => {
    const friends = await c.get('services').users.getFriends(requireUserId(c));
    return c.json(friends.map(toUserResponse));
  })
  .post('/add_friend', getUser, rateLimit(HARD_LIMIT), validate('query', FriendQuery), async (c) => {
    const { friend_id: friendId } = c.req.valid('query');
    const userId = requireUserId(c);
    try {
      await c.get('services').users.addFriend(userId, friendId);
    } catch (err) {
      if (err instanceof UserNotFoundException) throw new NotFoundError('Friend not found');
      throw err;
    }
    logger.info(`User ${userId} added friend ${friendId}`);
    return c.json({ status: 'success' });
  });
