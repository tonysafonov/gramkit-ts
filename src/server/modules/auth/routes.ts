/**
 * `/auth`: email signup, login, linking and password reset; Telegram code and deep link login; logout.
 *
 * Python's `auth_email.py` and `auth_telegram.py` share this prefix. Body validation comes before `getServices`, where
 * no `getUser` is chained: FastAPI opens no connection for a bad body, so neither does this. Logout and the deep link
 * routes only touch Redis and take no transaction.
 */
import { type Context, Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { getCurrentUserId, getServices, getUser } from '../../auth/context';
import { settings } from '../../config';
import type { Env, UserEnv } from '../../env';
import { AppError, RequestValidationError, UnauthorizedError } from '../../lib/errors';
import { getLogger } from '../../lib/logging';
import { validate } from '../../lib/validate';
import { clearSessionCookie, getSessionFromRequest, setSessionCookie } from '../sessions/cookies';
import { SessionsService } from '../sessions/service';
import { isGuest, toUserResponse } from '../users/schemas';
import { DeepLinkTokens } from './link-tokens';
import {
  DeeplinkPollQuery,
  type EmailAuthErrorCode,
  EmailAuthException,
  EmailCheckRequest,
  EmailLinkCompleteRequest,
  EmailLinkRequest,
  EmailLoginRequest,
  EmailResendRequest,
  EmailSignupCompleteRequest,
  EmailSignupRequest,
  PasswordResetCompleteRequest,
  PasswordResetStartRequest,
  SendCodeRequest,
  toEmailLoginResponse,
  toEmailSignupCompleteResponse,
  VerifyCodeRequest,
} from './schemas';

const logger = getLogger('auth');

const ERRORS: Record<EmailAuthErrorCode, [ContentfulStatusCode, string]> = {
  rate_limited: [429, 'Too many requests. Please try again later.'],
  email_already_in_use: [409, 'Email already in use by another account.'],
  email_already_verified: [409, 'Email already linked to this account.'],
  signup_token_invalid: [400, 'Invalid or expired signup token.'],
  signup_token_expired: [410, 'Signup session expired. Please start again.'],
  code_invalid: [400, 'Invalid verification code.'],
  code_expired: [410, 'Verification code expired. Please request a new one.'],
  password_too_weak: [400, 'Password does not meet complexity requirements.'],
  invalid_credentials: [401, 'Invalid credentials.'],
  account_locked: [423, 'Account temporarily locked. Please try again in 15 minutes.'],
  email_send_failed: [503, 'Unable to send verification email. Please try again.'],
  user_not_found: [404, 'User not found.'],
  reset_token_invalid: [400, 'Invalid or expired reset token.'],
};

/** Run an email flow, its `EmailAuthException` becoming the HTTP error. */
async function emailFlow<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (!(err instanceof EmailAuthException)) throw err;
    const [status, message] = ERRORS[err.errorCode];
    throw new AppError(status, { error: err.errorCode, message });
  }
}

/**
 * The user's id, a 401 without one or for the shared guest. Python lets the guest through (it has an id), so a
 * logged-out visitor could link a Telegram account or an email to the one row every logged-out visitor is: they would
 * all become that user, owner rights included when its Telegram id is in `RBAC__OWNER_IDS`.
 */
export function requireUserId(c: Context<UserEnv>): string {
  const user = c.get('user');
  if (!user || isGuest(user)) throw new UnauthorizedError({ error: 'not_authenticated', message: 'Login required' });
  return user.id;
}

/** FastAPI wants a body even when every field of the model is optional. */
const requireJsonBody = createMiddleware(async (c, next) => {
  if (!c.req.header('content-type')?.toLowerCase().includes('json')) {
    throw new RequestValidationError([{ type: 'missing', loc: ['body'], msg: 'Field required', input: null }]);
  }
  await next();
});

const CODE_SEND_ERRORS: Record<string, ContentfulStatusCode> = { RATE_LIMIT_EXCEEDED: 429, USER_NOT_FOUND: 404 };
const CODE_VERIFY_ERRORS: Record<string, ContentfulStatusCode> = {
  ...CODE_SEND_ERRORS,
  CODE_EXPIRED: 400,
  CODE_MISMATCH: 400,
  INVALID_CODE_FORMAT: 400,
};

/** Bot username from a URL like `https://t.me/BotName`. */
function extractBotUsername(botUrl: string): string {
  if (!botUrl.includes('t.me/')) return botUrl;
  return botUrl.split('t.me/').at(-1)?.split('?')[0]?.split('/')[0] ?? '';
}

/**
 * The client's address as the proxy in front saw it, for the bot's login confirmation. nginx sets `X-Real-IP` to its
 * `$remote_addr`, replacing whatever the client sent, and appends that same address to `X-Forwarded-For`: so the real
 * IP, else the last hop. Never the first hop: the client writes it, and a phishing backend would put its victim's own
 * IP there to make its link look like the victim's login.
 */
const clientIp = (c: Context): string | null =>
  c.req.header('x-real-ip')?.trim() || c.req.header('x-forwarded-for')?.split(',').at(-1)?.trim() || null;

const redisOf = (c: Context<Env>) => c.get('state').clients.redis;

export const authRoutes = new Hono<Env>()
  // Email check
  .post('/email/check', validate('json', EmailCheckRequest), getServices, async (c) => {
    const exists = await c.var.services.auth.emailCheckExists(c.req.valid('json').email);
    return c.json({ exists });
  })

  // Signup
  .post('/signup/email/start', validate('json', EmailSignupRequest), getServices, async (c) => {
    const { email } = c.req.valid('json');
    const result = await emailFlow(() => c.var.services.auth.emailStartSignup(email));
    return c.json({
      message: 'Verification code sent',
      signup_token: result.signupToken,
      expires_in: result.expiresIn,
    });
  })
  .post('/signup/email/complete', validate('json', EmailSignupCompleteRequest), getServices, async (c) => {
    const body = c.req.valid('json');
    const { user, sessionId } = await emailFlow(() =>
      c.var.services.auth.emailCompleteSignup(
        body.signup_token,
        body.code,
        body.password,
        body.username,
        body.language_code,
      ),
    );
    setSessionCookie(c, sessionId);
    return c.json(toEmailSignupCompleteResponse(user));
  })

  // Login
  .post('/login/email', validate('json', EmailLoginRequest), getServices, async (c) => {
    const body = c.req.valid('json');
    const { user, sessionId } = await emailFlow(() =>
      c.var.services.auth.emailLogin(body.email_or_username, body.password),
    );
    setSessionCookie(c, sessionId);
    return c.json(toEmailLoginResponse(user));
  })

  // Link (requires authentication)
  .post('/link/email/start', getUser, validate('json', EmailLinkRequest), async (c) => {
    const userId = requireUserId(c);
    const { email } = c.req.valid('json');
    const result = await emailFlow(() => c.var.services.auth.emailStartLink(userId, email));
    return c.json({ message: 'Verification code sent', expires_in: result.expiresIn });
  })
  .post('/link/email/complete', getUser, validate('json', EmailLinkCompleteRequest), async (c) => {
    const userId = requireUserId(c);
    const { code, password } = c.req.valid('json');
    await emailFlow(() => c.var.services.auth.emailCompleteLink(userId, code, password));
    return c.json({ message: 'Email linked successfully', success: true });
  })

  // Password reset
  .post('/password/reset/start', validate('json', PasswordResetStartRequest), getServices, async (c) => {
    const { email } = c.req.valid('json');
    const result = await emailFlow(() => c.var.services.auth.emailStartReset(email));
    return c.json({ reset_token: result.resetToken, expires_in: result.expiresIn });
  })
  .post('/password/reset/complete', validate('json', PasswordResetCompleteRequest), getServices, async (c) => {
    const body = c.req.valid('json');
    await emailFlow(() => c.var.services.auth.emailCompleteReset(body.reset_token, body.code, body.new_password));
    return c.json({ success: true });
  })

  // Resend
  .post('/signup/email/resend', getUser, requireJsonBody, validate('json', EmailResendRequest), async (c) => {
    const signupToken = c.req.valid('json').signup_token;
    const result = await emailFlow(() =>
      signupToken
        ? c.var.services.auth.emailResendCode(signupToken)
        : c.var.services.auth.emailResendCode(null, getCurrentUserId(c)),
    );
    return c.json({ message: 'Verification code sent', expires_in: result.expiresIn });
  })

  // Logout
  .post('/logout', async (c) => {
    const sessionId = getSessionFromRequest(c);
    if (sessionId) {
      const destroyed = await new SessionsService(redisOf(c)).destroySession(sessionId);
      if (destroyed) logger.info(`Session ${sessionId} destroyed during logout`);
      else logger.warn(`Session ${sessionId} not found during logout`);
    }
    clearSessionCookie(c);
    return c.json({ message: 'Successfully logged out' });
  })

  // Code-based Telegram auth
  .post('/login/telegram/code/send', validate('json', SendCodeRequest), getServices, async (c) => {
    const { services } = c.var;
    const result = await services.auth.sendVerificationCode(c.req.valid('json').username);
    if (!result.success) throw new AppError(CODE_SEND_ERRORS[result.errorCode] ?? 500, result.error);

    const { code, telegramId } = result;
    const verificationMessage =
      '🔐 <b>Verification Code</b>\n\n' +
      `Your login code: <code>${code}</code>\n\n` +
      'Enter this code on the website to complete your login.\n' +
      'Code expires in 5 minutes.';

    try {
      if (telegramId === null) throw new Error('The user has no telegram_id');
      const sent = await services.messages.sendMessage(telegramId, verificationMessage, false, null, 'HTML');
      if (sent !== true) logger.warn(`Failed to send verification code to telegram_id ${telegramId}`);
    } catch (err) {
      logger.error({ err }, 'Send code error');
      throw new AppError(500, 'Failed to send verification code');
    }

    return c.json({ message: result.message, expires_in: result.expiresIn });
  })
  .post('/login/telegram/code/verify', validate('json', VerifyCodeRequest), getServices, async (c) => {
    const { username, code } = c.req.valid('json');
    const result = await c.var.services.auth.verifyCode(username, code);
    if (!result.success) throw new AppError(CODE_VERIFY_ERRORS[result.errorCode] ?? 500, result.error);

    setSessionCookie(c, result.sessionId);
    logger.info(`User ${result.user.id} logged in via Telegram verification`);
    return c.json({ user: toUserResponse(result.user), message: 'Successfully logged in' });
  })

  // Deep link Telegram auth
  .post('/login/telegram/deeplink/start', async (c) => {
    const token = await new DeepLinkTokens(redisOf(c)).createLinkToken(clientIp(c));
    const botUrl = `https://t.me/${extractBotUsername(settings.bot.url)}?start=auth_${token}`;

    logger.info(`Deeplink login started: token=${token.slice(0, 8)}...`);

    return c.json({ token, bot_url: botUrl, expires_in: 300 });
  })
  .get('/login/telegram/deeplink/poll', validate('query', DeeplinkPollQuery), async (c) => {
    const { token } = c.req.valid('query');
    const tokens = new DeepLinkTokens(redisOf(c));
    const tokenData = await tokens.getLinkStatus(token);

    if (!tokenData) throw new AppError(410, 'Token expired or invalid');

    const status = tokenData.status ?? 'pending';
    if (status === 'pending') return c.json({ status: 'pending', user_id: null });

    if (status === 'verified') {
      const { session_id: sessionId, user_id: userId } = tokenData;
      if (!sessionId || !userId) {
        logger.error(`Token verified but missing session/user: ${token.slice(0, 8)}...`);
        throw new AppError(500, 'Auth state corrupted');
      }

      await tokens.consumeLinkToken(token);
      setSessionCookie(c, sessionId);

      logger.info(`Deeplink login completed: user_id=${userId}, token=${token.slice(0, 8)}...`);

      return c.json({ status: 'verified', user_id: userId });
    }

    throw new AppError(500, `Unknown token status: ${status}`);
  });
