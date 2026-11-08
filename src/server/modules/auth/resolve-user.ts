/**
 * Who is calling: the request's user, the body of `getUser`.
 *
 * Order: the `Mock-Platform` header (debug only), then Telegram `initData`, then the session cookie. With none of them
 * the request gets the shared guest: never a 401 for "not logged in", so gate endpoints with `auth/rbac`.
 *
 * A present but invalid `initData` is a 401. The DB, Redis or the network failing while the user is looked up is a 503
 * with `Retry-After`, on all three paths: never a 401 (a traffic spike must not log people out) and never the guest (a
 * logged-in web user must not silently become the shared guest). Anything else unexpected is a 500.
 */
import type { Context } from 'hono';
import { validate as isUuid } from 'uuid';
import { serviceUnavailable } from '../../auth/context';
import { InvalidInitDataError, NoInitDataError, parseQs } from '../../auth/telegram';
import { setSentryUser } from '../../clients/sentry';
import { settings } from '../../config';
import { type NewUser, UserRole, UserType } from '../../db/schema';
import type { UserEnv } from '../../env';
import { AppError, UnauthorizedError } from '../../lib/errors';
import { i18n, supportedLocale } from '../../lib/i18n';
import { isInfrastructureError } from '../../lib/infra-errors';
import { getLogger } from '../../lib/logging';
import type { Services } from '../../services';
import { getSessionFromRequest } from '../sessions/cookies';
import type { UserSchema } from '../users/schemas';

const logger = getLogger('auth');

/** The one shared guest row. */
export const MOCK_GUEST_USER_ID = '00000000-0000-0000-0000-000000000001';

/** What the guest's row is created (and refreshed) with. */
const GUEST_ROW = {
  id: MOCK_GUEST_USER_ID,
  displayName: 'Guest',
  username: null,
  avatarUrl: null,
  userType: UserType.GUEST,
  telegramId: null,
  languageCode: 'en',
  tgFirstName: 'Guest',
  tgLastName: null,
  tgUsername: null,
  tgLanguageCode: 'en',
  tgIsPremium: null,
  tgIsBot: null,
  tgAddedToAttachmentMenu: null,
  tgAllowsWriteToPm: null,
  tgPhotoUrl: null,
  male: null,
  birthDate: null,
  isOnboarded: false,
  isTermsAccepted: false,
  timezone: 'UTC',
  currentStreak: 0,
  bestStreak: 0,
  lastActivityDate: null,
  totalActiveDays: 0,
} satisfies NewUser;

export const getMockGuestUser = (): UserSchema => ({
  ...GUEST_ROW,
  role: UserRole.USER,
  email: null,
  emailVerified: false,
  emailVerifiedAt: null,
  lastLoginAt: null,
  referralCode: null,
  botBlockedAt: null,
  seenFeatures: {},
  createdAt: new Date('2024-01-01T00:00:00Z'), // a fixed old date, to stay out of "is new" logic
  updatedAt: new Date(),
});

function setSentry(user: UserSchema): void {
  setSentryUser({ userId: user.id, username: user.username, email: user.email, tgUsername: user.tgUsername });
}

/** `urllib.parse.unquote` for what is usually plain JSON already: a stray `%` stays as it is. */
function unquote(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

interface MockInitDataUser {
  user_id?: number;
  first_name?: string;
  last_name?: string | null;
  username?: string | null;
  photo_url?: string | null;
}

/** Debug "login as": the user carried in the frontend's mock initData (not signed), got or created. */
async function mockUserFromInitData(initData: string, services: Services): Promise<UserSchema | null> {
  try {
    const fields = parseQs(initData);
    if (fields.mock_init_data !== 'true' || !fields.user) return null;
    const userData = JSON.parse(unquote(fields.user)) as MockInitDataUser;

    const firstName = userData.first_name ?? 'Mock User';
    const lastName = userData.last_name ?? null;
    const dbUser = await services.users.getOrCreateUser({
      telegramId: userData.user_id ?? null,
      displayName: `${firstName} ${lastName ?? ''}`.trim(),
      username: userData.username ?? null,
      avatarUrl: userData.photo_url ?? null,
      languageCode: 'en',
      userType: UserType.REGISTERED, // mock users are treated as registered
      tgFirstName: firstName,
      tgLastName: lastName,
      tgUsername: userData.username ?? null,
      tgIsBot: false,
      tgLanguageCode: 'en',
      tgIsPremium: false,
      tgAddedToAttachmentMenu: false,
      tgAllowsWriteToPm: true,
      tgPhotoUrl: userData.photo_url ?? null,
    });
    logger.info(`Mock user ${dbUser.id} authenticated from frontend selector`);
    i18n.setUserLocale(dbUser);
    setSentry(dbUser);
    return dbUser;
  } catch (err) {
    logger.warn({ err }, 'Failed to process mock user data');
    return null;
  }
}

/** The Telegram user signed into `initData`, registered or refreshed in the DB. 401 for an invalid one. */
async function authenticateTelegram(c: Context<UserEnv>, services: Services, initData: string): Promise<UserSchema> {
  const { telegramAuth } = c.get('state');
  if (!telegramAuth) throw new Error('telegramAuth is not configured');

  let user: ReturnType<typeof telegramAuth.verifyToken>;
  try {
    user = telegramAuth.verifyToken(initData);
  } catch (err) {
    if (!(err instanceof InvalidInitDataError || err instanceof NoInitDataError || err instanceof TypeError)) throw err;
    // A present but invalid initData is a 401, never a silent fall-through to the cookie or the guest.
    logger.warn(`Telegram authentication failed: ${err.name}: ${err.message}`);
    throw new UnauthorizedError('Authentication failed');
  }

  const dbUser = await services.users.getOrCreateUser({
    telegramId: user.id,
    // App profile fields (populated from TG data on first login)
    displayName: `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.username || 'User',
    username: user.username ?? null,
    avatarUrl: user.photoUrl ?? null,
    languageCode: user.languageCode ?? null,
    // Telegram data (read-only from the TG API)
    tgFirstName: user.firstName,
    tgLastName: user.lastName ?? null,
    tgUsername: user.username ?? null,
    tgLanguageCode: user.languageCode ?? null,
    tgIsBot: user.isBot ?? null,
    tgIsPremium: user.isPremium ?? null,
    tgAddedToAttachmentMenu: user.addedToAttachmentMenu ?? null,
    tgAllowsWriteToPm: user.allowsWriteToPm ?? null,
    tgPhotoUrl: user.photoUrl ?? null,
    userType: UserType.REGISTERED,
  });
  logger.debug(`Telegram user ${dbUser.id} authenticated`); // the access-log line carries the user
  i18n.setUserLocale(dbUser);
  setSentry(dbUser);
  return dbUser;
}

/**
 * The user of the session cookie (web logins), `null` for no, an invalid or an expired session. Redis and DB errors
 * propagate: `resolveUser` turns them into a 503 instead of the guest.
 */
async function authenticateSession(c: Context<UserEnv>, services: Services): Promise<UserSchema | null> {
  const sessionId = getSessionFromRequest(c);
  if (!sessionId) return null;
  const sessionData = await services.sessions.validateSession(sessionId);
  if (!sessionData) return null;
  const userId = sessionData.user_id;
  if (!userId) return null;
  if (!isUuid(userId)) {
    logger.warn(`Invalid UUID in session ${sessionId}: ${userId}`);
    return null;
  }

  const user = await services.users.getUserById(userId);
  if (!user) {
    logger.warn(`Session ${sessionId} points to a missing user ${userId}`); // a stale session, not an error
    return null;
  }

  logger.debug(`Session user ${user.id} authenticated`);
  i18n.setUserLocale(user);
  setSentry(user);
  return user;
}

/** The shared guest row (created on first use, so update operations work on it). */
async function mockGuestUser(c: Context<UserEnv>, services: Services): Promise<UserSchema> {
  const user = await services.users.getOrCreateUser(GUEST_ROW);

  // One row for every logged-out web visitor, so its language must not come from the row: the frontend sends its UI
  // locale in X-App-Locale. Without it, the app's `guestLocale` (`null`: the row's).
  const appLocale = c.req.header('x-app-locale');
  const fallback = c.get('state').guestLocale;
  if (appLocale) i18n.updateLocale(supportedLocale(appLocale));
  else if (fallback) i18n.updateLocale(fallback);
  else i18n.setUserLocale(user);

  logger.info(`Mock guest user ${MOCK_GUEST_USER_ID} provided (from database)`);
  setSentryUser({ userId: user.id, username: user.username, email: null, tgUsername: null });
  return user;
}

export async function resolveUser(c: Context<UserEnv>, services: Services): Promise<UserSchema> {
  const initData = c.req.header('initData');

  // Debug "login as" (frontend mock initData)
  if (c.req.header('Mock-Platform') === 'true' && settings.debug) {
    const mockUser = initData ? await mockUserFromInitData(initData, services) : null;
    if (mockUser) return mockUser;
    logger.info('No mock user data in initData, falling through to normal auth');
  }

  try {
    if (initData) return await authenticateTelegram(c, services, initData);
    return (await authenticateSession(c, services)) ?? (await mockGuestUser(c, services));
  } catch (err) {
    if (!(err instanceof AppError) && isInfrastructureError(err)) throw serviceUnavailable(err);
    throw err; // a bug, not "not logged in": the global handler's 500
  }
}
