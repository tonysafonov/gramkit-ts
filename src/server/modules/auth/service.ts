/**
 * Authentication: 6-digit codes over Telegram, deep links through the bot, and email (signup, login, linking, password
 * reset).
 *
 * - Code: `sendVerificationCode` makes the code, the route sends it over Telegram, `verifyCode` checks it.
 * - Deep link: `createLinkToken`, the bot calls `verifyLinkToken`, the web polls `getLinkStatus`, then
 *   `consumeLinkToken`.
 * - Email: `emailStartSignup` → `emailCompleteSignup`, `emailLogin`, `emailStartLink` → `emailCompleteLink`,
 *   `emailStartReset` → `emailCompleteReset`.
 *
 * The state of a flow lives in Redis as JSON. The email flows throw `EmailAuthException`, routes translate it.
 */
import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { Bot } from 'grammy';
import type { Context } from 'hono';
import type { RabbitProducer } from '../../clients/rabbit';
import type { RedisClient } from '../../clients/redis';
import type { User } from '../../db/schema';
import type { UserEnv } from '../../env';
import { BaseService } from '../../lib/base-service';
import { getLogger } from '../../lib/logging';
import { normalizeEmail } from '../../lib/utils';
import type { Repos } from '../../repos';
import type { Services } from '../../services';
import { toUserSchema, type UserSchema } from '../users/schemas';
import { sendVerificationEmail } from './email';
import { DeepLinkTokens, type LinkTokenData } from './link-tokens';
import { PasswordService } from './password';
import { resolveUser } from './resolve-user';
import { EmailAuthException } from './schemas';

const logger = getLogger('auth');

// Code-based auth
const AUTH_CODE_LENGTH = 6;
const AUTH_CODE_EXPIRY_MINUTES = 5;
const AUTH_CODE_PREFIX = 'auth_code:';
const RATE_LIMIT_PREFIX = 'auth_rate:';
const RATE_LIMIT_WINDOW = 3600;
const MAX_CODE_REQUESTS_PER_HOUR = 5;
const MAX_VERIFICATION_ATTEMPTS_PER_HOUR = 10;

// Email auth
const emailKeys = {
  // Flow data
  signup: (token: string) => `email:signup:${token}`,
  link: (userId: string) => `email:link:${userId}`,
  reset: (token: string) => `email:reset:${token}`,
  /** Wrong codes against a flow key, counted with INCR (the flow JSON's `attempts` is the count Python wrote). */
  attempts: (flowKey: string) => `${flowKey}:attempts`,
  // Rate limiting
  rate: (email: string) => `email:rate:${email}`,
  lockoutLogin: (email: string) => `email:lockout:login:${email}`,
  lockoutVerify: (email: string) => `email:lockout:verify:${email}`,
  /** Codes tried against an email, across all its flows and tokens (a right code gives its count back). */
  codeFailures: (email: string) => `email:codefail:${email}`,
};

export const EMAIL_SIGNUP_TTL = 600;
export const EMAIL_LINK_TTL = 600;
export const EMAIL_RESET_TTL = 600;
const EMAIL_RATE_LIMIT_WINDOW = 900;
/** Failed attempts per email: stops brute force, allows typos. */
export const EMAIL_RATE_LIMIT_MAX = 15;
const EMAIL_LOGIN_LOCKOUT_TTL = 900;
/** After a token is invalidated by too many wrong codes. */
const EMAIL_VERIFY_COOLDOWN_TTL = 300;
export const EMAIL_MAX_CODE_ATTEMPTS = 5;
/**
 * Wrong codes per email per window, whatever flow or token they were tried on. The per-token cap alone let an attacker
 * try 4 codes on each of the 15 resets an email may start per window, and start again: thousands of guesses a day at
 * a reset code that sets the password.
 */
export const EMAIL_MAX_CODE_FAILURES = 10;
const EMAIL_CODE_FAILURE_WINDOW = 3600;

/**
 * Verified when the user doesn't exist, so a login takes the same time either way and usernames can't be enumerated.
 * Same cost as real hashes: `BCRYPT_ROUNDS` in `password.ts`.
 */
const DUMMY_PASSWORD_HASH = '$2b$10$oIImmZDaAFCDXO7f9WUjyeZHw9TueUceG.4qKt9PvnnnAaGKadvW6';

type CodeFailure = { success: false; error: string; errorCode: string };

type SendCodeResult =
  | { success: true; message: string; expiresIn: number; code: string; telegramId: number | null }
  | CodeFailure;

type VerifyCodeResult = { success: true; message: string; user: UserSchema; sessionId: string } | CodeFailure;

interface EmailFlowData {
  email: string;
  code: string;
  created_at: string;
  attempts: number;
}

interface ResetFlowData extends EmailFlowData {
  user_id: string;
}

const generateToken = (): string => randomBytes(32).toString('base64url');

/** Python's `secrets.compare_digest`. */
function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export class AuthService extends BaseService {
  private readonly redis: RedisClient;
  private readonly passwordService = new PasswordService();
  private readonly linkTokens: DeepLinkTokens;

  constructor(repos: Repos, producer: RabbitProducer, services: Services, bot: Bot | null) {
    super(repos, producer, services, bot);
    this.redis = services.redis;
    this.linkTokens = new DeepLinkTokens(this.redis);
  }

  /** Who is calling. `getUser` calls it once per request. */
  resolveUser(c: Context<UserEnv>): Promise<UserSchema> {
    return resolveUser(c, this.services);
  }

  // Code-based auth -------------------------------------------------------------------------------------------------

  private generateAuthCode(): string {
    return Array.from({ length: AUTH_CODE_LENGTH }, () => randomInt(10)).join('');
  }

  /**
   * Count one attempt. `false` when the limit is used up; when Redis fails the attempt goes through.
   *
   * Counted with `INCR` before the check, so concurrent requests each see their own count. Python's get-check-set let
   * a burst of requests all read the same count and all go through: thousands of guesses at a 6-digit code at once.
   * The window starts with the first attempt (Python restarted it on every attempt).
   */
  private async checkRateLimit(key: string, maxAttempts: number): Promise<boolean> {
    try {
      const count = await this.redis.incr(key);
      if (count === 1) await this.redis.expire(key, RATE_LIMIT_WINDOW);
      return count <= maxAttempts;
    } catch (err) {
      logger.error({ err }, `Rate limit check failed for ${key}`);
      return true;
    }
  }

  /** Generate and store a code for a Telegram username (with or without @). The caller sends it to the user. */
  async sendVerificationCode(username: string): Promise<SendCodeResult> {
    try {
      const cleanUsername = username.replace(/^@+/, '').toLowerCase();

      const rateLimitKey = `${RATE_LIMIT_PREFIX}send:${cleanUsername}`;
      if (!(await this.checkRateLimit(rateLimitKey, MAX_CODE_REQUESTS_PER_HOUR))) {
        return {
          success: false,
          error: 'Too many code requests. Please wait before requesting another code.',
          errorCode: 'RATE_LIMIT_EXCEEDED',
        };
      }

      const user = await this.repos.users.getByTgUsername(cleanUsername);
      if (!user) {
        return {
          success: false,
          error: "Username not found. Please make sure you've used our Telegram bot before.",
          errorCode: 'USER_NOT_FOUND',
        };
      }

      const code = this.generateAuthCode();
      const now = Date.now();
      const codeData = {
        code,
        user_id: user.id,
        created_at: new Date(now).toISOString(),
        expires_at: new Date(now + AUTH_CODE_EXPIRY_MINUTES * 60_000).toISOString(),
      };
      await this.redis.set(
        `${AUTH_CODE_PREFIX}${cleanUsername}`,
        JSON.stringify(codeData),
        AUTH_CODE_EXPIRY_MINUTES * 60,
      );

      logger.info(`Verification code generated for username ${cleanUsername}`);

      return {
        success: true,
        message: 'Verification code sent to your Telegram',
        expiresIn: AUTH_CODE_EXPIRY_MINUTES * 60,
        code,
        telegramId: user.telegramId,
      };
    } catch (err) {
      logger.error({ err }, `Error sending verification code for ${username}`);
      return {
        success: false,
        error: 'Failed to send verification code. Please try again.',
        errorCode: 'INTERNAL_ERROR',
      };
    }
  }

  /** Check a code for a username (with or without @). On success the user has a new session. */
  async verifyCode(username: string, code: string): Promise<VerifyCodeResult> {
    try {
      const cleanUsername = username.replace(/^@+/, '').toLowerCase();

      const rateLimitKey = `${RATE_LIMIT_PREFIX}verify:${cleanUsername}`;
      if (!(await this.checkRateLimit(rateLimitKey, MAX_VERIFICATION_ATTEMPTS_PER_HOUR))) {
        return {
          success: false,
          error: 'Too many verification attempts. Please wait before trying again.',
          errorCode: 'RATE_LIMIT_EXCEEDED',
        };
      }

      if (code.length !== AUTH_CODE_LENGTH || !/^\d+$/.test(code)) {
        return {
          success: false,
          error: 'Invalid code format. Please enter a 6-digit code.',
          errorCode: 'INVALID_CODE_FORMAT',
        };
      }

      const codeKey = `${AUTH_CODE_PREFIX}${cleanUsername}`;
      const stored = await this.redis.get(codeKey);
      if (!stored) {
        return {
          success: false,
          error: 'Verification code expired or not found. Please request a new code.',
          errorCode: 'CODE_EXPIRED',
        };
      }

      let storedData: { code?: string; user_id: string; expires_at: string };
      try {
        storedData = JSON.parse(stored);
      } catch {
        return {
          success: false,
          error: 'Invalid verification data. Please request a new code.',
          errorCode: 'INVALID_DATA',
        };
      }

      if (storedData.code !== code) {
        return {
          success: false,
          error: 'Invalid verification code. Please check and try again.',
          errorCode: 'CODE_MISMATCH',
        };
      }

      if (Date.now() > new Date(storedData.expires_at).getTime()) {
        await this.redis.delete(codeKey);
        return {
          success: false,
          error: 'Verification code expired. Please request a new code.',
          errorCode: 'CODE_EXPIRED',
        };
      }

      const userId = storedData.user_id;
      const user = await this.repos.users.getUserById(userId);
      if (!user) {
        return {
          success: false,
          error: 'User account not found. Please contact support.',
          errorCode: 'USER_NOT_FOUND',
        };
      }

      await this.redis.delete(codeKey);

      logger.info(`Verification successful for username ${cleanUsername}, user_id ${userId}`);

      const sessionId = await this.services.sessions.createSession(user.id, user.userType, {
        auth_method: 'telegram_code',
      });

      return { success: true, message: 'Verification successful', user: toUserSchema(user), sessionId };
    } catch (err) {
      logger.error({ err }, `Error verifying code for ${username}`);
      return { success: false, error: 'Verification failed. Please try again.', errorCode: 'INTERNAL_ERROR' };
    }
  }

  // Deep link auth --------------------------------------------------------------------------------------------------

  createLinkToken(ip?: string | null): Promise<string> {
    return this.linkTokens.createLinkToken(ip);
  }

  getLinkStatus(token: string): Promise<LinkTokenData | null> {
    return this.linkTokens.getLinkStatus(token);
  }

  bindLinkSender(token: string, telegramId: number): Promise<void> {
    return this.linkTokens.bindSender(token, telegramId);
  }

  isLinkSender(token: string, telegramId: number): Promise<boolean> {
    return this.linkTokens.isSender(token, telegramId);
  }

  verifyLinkToken(token: string, userId: string, sessionId: string): Promise<boolean> {
    return this.linkTokens.verifyLinkToken(token, userId, sessionId);
  }

  consumeLinkToken(token: string): Promise<LinkTokenData | null> {
    return this.linkTokens.consumeLinkToken(token);
  }

  // Email auth: rate limits -----------------------------------------------------------------------------------------

  private async checkEmailRateLimit(email: string): Promise<boolean> {
    const count = await this.redis.get(emailKeys.rate(email));
    return !count || Number(count) < EMAIL_RATE_LIMIT_MAX;
  }

  private async incrementEmailRateLimit(email: string): Promise<number> {
    const key = emailKeys.rate(email);
    const count = await this.redis.incr(key);
    if (count === 1) await this.redis.expire(key, EMAIL_RATE_LIMIT_WINDOW);
    return count;
  }

  private async isInCooldown(email: string): Promise<boolean> {
    return (await this.redis.exists(emailKeys.lockoutVerify(email))) > 0;
  }

  private async setCooldown(email: string): Promise<void> {
    await this.redis.set(emailKeys.lockoutVerify(email), '1', EMAIL_VERIFY_COOLDOWN_TTL);
  }

  private async tooManyCodeFailures(email: string): Promise<boolean> {
    return Number((await this.redis.get(emailKeys.codeFailures(email))) ?? 0) >= EMAIL_MAX_CODE_FAILURES;
  }

  private async requireNoEmailLimit(email: string): Promise<void> {
    if (!(await this.checkEmailRateLimit(email))) throw new EmailAuthException('rate_limited');
    if (await this.isInCooldown(email)) throw new EmailAuthException('rate_limited');
    if (await this.tooManyCodeFailures(email)) throw new EmailAuthException('rate_limited');
  }

  private async handleLoginFailure(identifier: string): Promise<void> {
    const count = await this.incrementEmailRateLimit(identifier);
    if (count >= EMAIL_RATE_LIMIT_MAX) {
      await this.redis.set(emailKeys.lockoutLogin(identifier), '1', EMAIL_LOGIN_LOCKOUT_TTL);
      await this.redis.delete(emailKeys.rate(identifier));
      logger.warn(`Account locked due to failed attempts: ${identifier.slice(0, 3)}***`);
    }
  }

  /** Drop a flow and its wrong-code counter. */
  private async deleteFlow(redisKey: string): Promise<void> {
    await this.redis.delete(redisKey);
    await this.redis.delete(emailKeys.attempts(redisKey));
  }

  /**
   * Check a code against a flow's data: too many wrong codes end the flow and start the email's cooldown. Throws
   * `code_invalid` for a wrong code.
   *
   * The attempt is counted (INCR) before the comparison, so concurrent requests can't all read the same count and try
   * more than `EMAIL_MAX_CODE_ATTEMPTS` codes; a right code gives its count back. Python reads the count from the flow
   * JSON and writes it back after the comparison, a race. The JSON's `attempts` still counts, for a flow Python started.
   *
   * The email's own count (`EMAIL_MAX_CODE_FAILURES` per hour, the same INCR first) caps the codes tried across tokens:
   * past it, every flow of the email is `rate_limited` until the window ends, the right code included.
   */
  private async checkFlowCode(redisKey: string, flow: EmailFlowData, code: string, ttl: number): Promise<void> {
    const counterKey = emailKeys.attempts(redisKey);
    const counted = await this.redis.incr(counterKey);
    if (counted === 1) await this.redis.expire(counterKey, ttl);
    const attempts = (flow.attempts ?? 0) + counted; // this one included

    if (attempts > EMAIL_MAX_CODE_ATTEMPTS) {
      await this.deleteFlow(redisKey);
      await this.setCooldown(flow.email);
      throw new EmailAuthException('code_invalid'); // token invalidated
    }

    const failuresKey = emailKeys.codeFailures(flow.email);
    const failures = await this.redis.incr(failuresKey);
    if (failures === 1) await this.redis.expire(failuresKey, EMAIL_CODE_FAILURE_WINDOW);
    if (failures > EMAIL_MAX_CODE_FAILURES) {
      logger.warn(`Too many wrong codes for ${flow.email.slice(0, 3)}***: flows refused for the window`);
      throw new EmailAuthException('rate_limited');
    }

    if (safeEqual(flow.code, code)) {
      await this.redis.decr(counterKey);
      await this.redis.decr(failuresKey);
      return;
    }

    // A wrong code refreshes the flow's TTL, as Python's write-back does
    await this.redis.expire(redisKey, ttl);
    await this.redis.expire(counterKey, ttl);
    if (attempts >= EMAIL_MAX_CODE_ATTEMPTS) {
      await this.deleteFlow(redisKey);
      await this.setCooldown(flow.email);
    }
    throw new EmailAuthException('code_invalid');
  }

  private requireStrongPassword(password: string): void {
    const [isValid] = this.passwordService.validateStrength(password);
    if (!isValid) throw new EmailAuthException('password_too_weak');
  }

  // Email auth: existence -------------------------------------------------------------------------------------------

  /** Is this email already registered? */
  emailCheckExists(email: string): Promise<boolean> {
    return this.repos.users.isEmailVerifiedByAnyUser(normalizeEmail(email));
  }

  // Email auth: signup ----------------------------------------------------------------------------------------------

  /** Store a pending signup in Redis and email its code. */
  async emailStartSignup(email: string): Promise<{ signupToken: string; expiresIn: number }> {
    const normalized = normalizeEmail(email);

    await this.requireNoEmailLimit(normalized);
    if (await this.repos.users.isEmailVerifiedByAnyUser(normalized)) {
      throw new EmailAuthException('email_already_in_use');
    }

    const signupToken = generateToken();
    const code = this.passwordService.generateVerificationCode();
    const signupData: EmailFlowData = { email: normalized, code, created_at: new Date().toISOString(), attempts: 0 };

    const redisKey = emailKeys.signup(signupToken);
    await this.redis.set(redisKey, JSON.stringify(signupData), EMAIL_SIGNUP_TTL);

    if (!(await sendVerificationEmail(normalized, code))) {
      await this.deleteFlow(redisKey);
      throw new EmailAuthException('email_send_failed');
    }

    await this.incrementEmailRateLimit(normalized);

    logger.info(`Email signup started for ${normalized.slice(0, 3)}***`);

    return { signupToken, expiresIn: EMAIL_SIGNUP_TTL };
  }

  /** Check the code, create the user and start their session. */
  async emailCompleteSignup(
    signupToken: string,
    code: string,
    password: string,
    username: string,
    languageCode?: string | null,
  ): Promise<{ user: UserSchema; sessionId: string }> {
    const redisKey = emailKeys.signup(signupToken);
    const raw = await this.redis.get(redisKey);
    if (!raw) throw new EmailAuthException('signup_token_invalid');

    const signupData = JSON.parse(raw) as EmailFlowData;
    const { email } = signupData;

    await this.checkFlowCode(redisKey, signupData, code, EMAIL_SIGNUP_TTL);
    this.requireStrongPassword(password);

    // The email may have been taken since the signup started
    if (await this.repos.users.isEmailVerifiedByAnyUser(email)) {
      await this.deleteFlow(redisKey);
      throw new EmailAuthException('email_already_in_use');
    }

    const passwordHash = await this.passwordService.hashPassword(password);
    const now = new Date();

    const user = await this.repos.users.create({
      username,
      displayName: username, // initial display name from the username
      tgFirstName: null, // no Telegram data for email users
      email,
      emailVerified: true,
      emailVerifiedAt: now,
      passwordHash,
      lastLoginAt: now,
      languageCode: languageCode || 'en',
    });

    await this.deleteFlow(redisKey);

    const sessionId = await this.services.sessions.createSession(user.id, user.userType);

    logger.info(`Email signup completed for user_id=${user.id}`);

    return { user: toUserSchema(user), sessionId };
  }

  // Email auth: login -----------------------------------------------------------------------------------------------

  /** Login with an email or a username and a password. */
  async emailLogin(emailOrUsername: string, password: string): Promise<{ user: UserSchema; sessionId: string }> {
    const isEmail = emailOrUsername.includes('@');
    const normalized = isEmail ? normalizeEmail(emailOrUsername) : emailOrUsername.toLowerCase().trim();
    const lockoutIdentifier = isEmail ? normalized : `username:${normalized}`;

    if (await this.redis.exists(emailKeys.lockoutLogin(lockoutIdentifier))) {
      throw new EmailAuthException('account_locked');
    }

    let user: User | null;
    if (isEmail) {
      user = await this.repos.users.getByVerifiedEmail(normalized);
    } else {
      user = await this.repos.users.getByUsername(normalized);
      // Must have a verified email to login with a username
      if (user && !user.emailVerifiedAt) user = null;
    }

    // Always verify, against a dummy hash if there is no user, so the timing doesn't reveal which usernames exist.
    const passwordValid = await this.passwordService.verifyPassword(
      password,
      user?.passwordHash || DUMMY_PASSWORD_HASH,
    );

    if (!user?.passwordHash || !passwordValid) {
      await this.handleLoginFailure(lockoutIdentifier);
      throw new EmailAuthException('invalid_credentials');
    }

    await this.redis.delete(emailKeys.rate(lockoutIdentifier));

    const updated = await this.repos.users.updateUser(user.id, { lastLoginAt: new Date() });

    const sessionId = await this.services.sessions.createSession(updated.id, updated.userType);

    logger.info(`Email login successful for user_id=${updated.id}`);

    return { user: toUserSchema(updated), sessionId };
  }

  // Email auth: link (for Telegram users) ---------------------------------------------------------------------------

  /** Email a code to link this address to an existing user. */
  async emailStartLink(userId: string, email: string): Promise<{ expiresIn: number }> {
    const normalized = normalizeEmail(email);

    await this.requireNoEmailLimit(normalized);

    const user = await this.repos.users.getById(userId);
    if (!user) throw new EmailAuthException('user_not_found');
    if (user.emailVerified) throw new EmailAuthException('email_already_verified');
    if (await this.repos.users.isEmailVerifiedByAnyUser(normalized)) {
      throw new EmailAuthException('email_already_in_use');
    }

    const code = this.passwordService.generateVerificationCode();
    const linkData: EmailFlowData = { email: normalized, code, created_at: new Date().toISOString(), attempts: 0 };

    const redisKey = emailKeys.link(userId);
    await this.redis.set(redisKey, JSON.stringify(linkData), EMAIL_LINK_TTL);
    await this.redis.delete(emailKeys.attempts(redisKey)); // a new flow for this user starts its count over

    if (!(await sendVerificationEmail(normalized, code, user.displayName))) {
      await this.deleteFlow(redisKey);
      throw new EmailAuthException('email_send_failed');
    }

    await this.incrementEmailRateLimit(normalized);

    logger.info(`Email link started for user_id=${userId}`);

    return { expiresIn: EMAIL_LINK_TTL };
  }

  /** Check the code and set the email and the password for email login. */
  async emailCompleteLink(userId: string, code: string, password: string): Promise<{ success: true }> {
    const redisKey = emailKeys.link(userId);
    const raw = await this.redis.get(redisKey);
    if (!raw) throw new EmailAuthException('code_expired');

    const linkData = JSON.parse(raw) as EmailFlowData;
    const { email } = linkData;

    await this.checkFlowCode(redisKey, linkData, code, EMAIL_LINK_TTL);
    this.requireStrongPassword(password);

    if (await this.repos.users.isEmailVerifiedByAnyUser(email)) {
      await this.deleteFlow(redisKey);
      throw new EmailAuthException('email_already_in_use');
    }

    const user = await this.repos.users.getById(userId);
    if (!user) throw new EmailAuthException('user_not_found');

    await this.repos.users.updateUser(userId, {
      email,
      emailVerified: true,
      emailVerifiedAt: new Date(),
      passwordHash: await this.passwordService.hashPassword(password),
    });

    await this.deleteFlow(redisKey);

    logger.info(`Email linked for user_id=${userId}`);

    return { success: true };
  }

  // Email auth: password reset --------------------------------------------------------------------------------------

  /** Email a reset code. An unknown email gets the same answer with a token that leads nowhere. */
  async emailStartReset(email: string): Promise<{ resetToken: string; expiresIn: number }> {
    const normalized = normalizeEmail(email);

    await this.requireNoEmailLimit(normalized);

    const user = await this.repos.users.getByVerifiedEmail(normalized);
    if (!user) {
      await this.incrementEmailRateLimit(normalized);
      logger.info(`Password reset attempted for non-existent email ${normalized.slice(0, 3)}***`);
      return { resetToken: generateToken(), expiresIn: EMAIL_RESET_TTL };
    }

    const resetToken = generateToken();
    const code = this.passwordService.generateVerificationCode();
    const resetData: ResetFlowData = {
      email: normalized,
      code,
      user_id: user.id,
      created_at: new Date().toISOString(),
      attempts: 0,
    };

    const redisKey = emailKeys.reset(resetToken);
    await this.redis.set(redisKey, JSON.stringify(resetData), EMAIL_RESET_TTL);

    if (!(await sendVerificationEmail(normalized, code, user.displayName))) {
      await this.deleteFlow(redisKey);
      throw new EmailAuthException('email_send_failed');
    }

    await this.incrementEmailRateLimit(normalized);

    logger.info(`Password reset started for ${normalized.slice(0, 3)}***`);

    return { resetToken, expiresIn: EMAIL_RESET_TTL };
  }

  /**
   * Check the code, set the new password, end the user's sessions and clear what would stop the user logging in right
   * away.
   */
  async emailCompleteReset(resetToken: string, code: string, newPassword: string): Promise<{ success: true }> {
    const redisKey = emailKeys.reset(resetToken);
    const raw = await this.redis.get(redisKey);
    if (!raw) throw new EmailAuthException('reset_token_invalid');

    const resetData = JSON.parse(raw) as ResetFlowData;
    const { email, user_id: userId } = resetData;

    await this.checkFlowCode(redisKey, resetData, code, EMAIL_RESET_TTL);
    this.requireStrongPassword(newPassword);

    const user = await this.repos.users.getById(userId);
    if (!user) throw new EmailAuthException('user_not_found');

    await this.repos.users.updateUser(userId, {
      passwordHash: await this.passwordService.hashPassword(newPassword),
    });

    await this.deleteFlow(redisKey);
    await this.redis.delete(emailKeys.lockoutLogin(email));
    await this.redis.delete(emailKeys.rate(email));
    // A reset is how a user gets rid of a session someone took: it must not survive (Python's does)
    await this.services.sessions.revokeUserSessions(userId);

    logger.info(`Password reset completed for user_id=${userId}`);

    return { success: true };
  }

  // Email auth: resend ----------------------------------------------------------------------------------------------

  /** Resend a code: for the signup flow with its token, otherwise for the user's link flow. */
  emailResendCode(signupToken?: string | null, userId?: string | null): Promise<{ expiresIn: number }> {
    if (signupToken) return this.resendSignupCode(signupToken);
    if (userId) return this.resendLinkCode(userId);
    throw new EmailAuthException('signup_token_invalid');
  }

  private async resendSignupCode(signupToken: string): Promise<{ expiresIn: number }> {
    const redisKey = emailKeys.signup(signupToken);
    const raw = await this.redis.get(redisKey);
    if (!raw) throw new EmailAuthException('signup_token_invalid');

    const signupData = JSON.parse(raw) as EmailFlowData;
    const { email } = signupData;

    if (!(await this.checkEmailRateLimit(email))) throw new EmailAuthException('rate_limited');

    const code = this.passwordService.generateVerificationCode();
    await this.redis.set(redisKey, JSON.stringify({ ...signupData, code, attempts: 0 }), EMAIL_SIGNUP_TTL);
    await this.redis.delete(emailKeys.attempts(redisKey));

    if (!(await sendVerificationEmail(email, code))) throw new EmailAuthException('email_send_failed');

    await this.incrementEmailRateLimit(email);

    return { expiresIn: EMAIL_SIGNUP_TTL };
  }

  private async resendLinkCode(userId: string): Promise<{ expiresIn: number }> {
    const redisKey = emailKeys.link(userId);
    const raw = await this.redis.get(redisKey);
    if (!raw) throw new EmailAuthException('code_expired');

    const linkData = JSON.parse(raw) as EmailFlowData;
    const { email } = linkData;

    if (!(await this.checkEmailRateLimit(email))) throw new EmailAuthException('rate_limited');

    const user = await this.repos.users.getById(userId);

    const code = this.passwordService.generateVerificationCode();
    await this.redis.set(redisKey, JSON.stringify({ ...linkData, code, attempts: 0 }), EMAIL_LINK_TTL);
    await this.redis.delete(emailKeys.attempts(redisKey));

    if (!(await sendVerificationEmail(email, code, user?.displayName))) {
      throw new EmailAuthException('email_send_failed');
    }

    await this.incrementEmailRateLimit(email);

    return { expiresIn: EMAIL_LINK_TTL };
  }
}
