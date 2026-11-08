/**
 * The email routes end to end: signup, login, linking, password reset, resend. The Python app has no tests for these;
 * the expectations come from `core/infrastructure/fastapi/routers/auth_email.py` and `core/services/auth.py`.
 */
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { settings } from '../../config';
import { users } from '../../db/schema';
import { asUser, createTestApp, createUser, type TestApp } from '../../testing';
import { passwordService } from './password';
import { EMAIL_MAX_CODE_ATTEMPTS, EMAIL_MAX_CODE_FAILURES, EMAIL_RATE_LIMIT_MAX } from './service';

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read field by field
const json = async (res: Response): Promise<any> => res.json();

const PASSWORD = 'Password123';
const COOKIE = settings.session.cookieName;

interface SentEmail {
  from: string;
  to: string[];
  code: string;
  html: string;
}

let t: TestApp;
let emails: SentEmail[];
/** What the next Resend calls answer with; empty means success. */
let resendFailures: { status: number; message: string }[];

const originalApiKey = settings.email.apiKey;

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.close());

beforeEach(() => {
  emails = [];
  resendFailures = [];
  settings.email.apiKey = 're_test';
  t.fakes.redis.clear();
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    const failure = resendFailures.shift();
    if (failure) return new Response(JSON.stringify({ message: failure.message }), { status: failure.status });
    const body = JSON.parse(String(init.body)) as Omit<SentEmail, 'code'>;
    const code = /\n\s+(\d{6})\n/.exec(body.html)?.[1] ?? '';
    emails.push({ ...body, code });
    return new Response(JSON.stringify({ id: 'email-1' }), { status: 200 });
  });
});

afterEach(() => {
  settings.email.apiKey = originalApiKey;
  vi.unstubAllGlobals();
});

let sequence = 0;
const nextEmail = () => `person${++sequence}@example.com`;
const nextUsername = () => `person_${++sequence}`;

const lastCode = (): string => {
  const email = emails.at(-1);
  if (!email) throw new Error('no email was sent');
  return email.code;
};

/** A code that isn't the one sent. */
const wrongCode = (): string => (lastCode() === '000000' ? '000001' : '000000');

const sessionFrom = (response: Response): string | undefined =>
  response.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith(`${COOKIE}=`))
    ?.split(';')[0]
    ?.slice(COOKIE.length + 1);

async function startSignup(email = nextEmail()): Promise<{ email: string; token: string }> {
  const response = await t.client.post('/auth/signup/email/start', { email });
  expect(response.status).toBe(200);
  return { email, token: (await json(response)).signup_token };
}

const completeSignup = (token: string, code: string, overrides: object = {}) =>
  t.client.post('/auth/signup/email/complete', {
    signup_token: token,
    code,
    password: PASSWORD,
    username: nextUsername(),
    ...overrides,
  });

async function signedUp(): Promise<{ email: string; username: string; id: string }> {
  const { email, token } = await startSignup();
  const username = nextUsername();
  const response = await completeSignup(token, lastCode(), { username });
  expect(response.status).toBe(200);
  return { email, username, id: (await json(response)).user_id };
}

const login = (emailOrUsername: string, password = PASSWORD) =>
  t.client.post('/auth/login/email', { email_or_username: emailOrUsername, password });

describe('POST /auth/email/check', () => {
  it('is true only for a verified email', async () => {
    const { email } = await signedUp();
    await createUser(t.db, { email: 'unverified@example.com', emailVerified: false });

    const check = async (address: string) =>
      (await json(await t.client.post('/auth/email/check', { email: address }))).exists;

    expect(await check(email.toUpperCase())).toBe(true);
    expect(await check('unverified@example.com')).toBe(false);
    expect(await check('nobody@example.com')).toBe(false);
  });

  it('rejects something that is not an email with a 422', async () => {
    const response = await t.client.post('/auth/email/check', { email: 'not-an-email' });
    expect(response.status).toBe(422);
    expect((await json(response)).detail[0].loc).toEqual(['body', 'email']);
  });
});

describe('signup', () => {
  it('start answers with a token and emails a code', async () => {
    const email = nextEmail();
    const response = await t.client.post('/auth/signup/email/start', { email: `  ${email}`.trim().toUpperCase() });

    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body).toEqual({ message: 'Verification code sent', signup_token: expect.any(String), expires_in: 600 });
    expect(emails).toHaveLength(1);
    expect(emails[0]?.to).toEqual([email]);
    expect(emails[0]?.code).toMatch(/^\d{6}$/);
    expect(emails[0]?.from).toBe(`${settings.email.fromName} <${settings.email.fromAddress}>`);
  });

  it('complete creates the user with a session cookie', async () => {
    const { email, token } = await startSignup();
    const username = nextUsername();

    const response = await completeSignup(token, lastCode(), { username, language_code: 'ru' });

    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body).toEqual({
      user_id: expect.any(String),
      username,
      email,
      message: 'Account created successfully',
    });

    const [row] = await t.db.select().from(users).where(eq(users.id, body.user_id));
    expect(row).toMatchObject({
      username,
      displayName: username,
      email,
      emailVerified: true,
      languageCode: 'ru',
      tgFirstName: null,
      telegramId: null,
    });
    expect(row?.emailVerifiedAt).toBeInstanceOf(Date);
    expect(row?.lastLoginAt).toBeInstanceOf(Date);
    expect(await passwordService.verifyPassword(PASSWORD, row?.passwordHash ?? '')).toBe(true);

    const session = sessionFrom(response);
    expect(session).toBeDefined();
    const me = await t.client.get('/users/me', { headers: { cookie: `${COOKIE}=${session}` } });
    expect((await json(me)).id).toBe(body.user_id);
  });

  it('language defaults to en', async () => {
    const { token } = await startSignup();
    const response = await completeSignup(token, lastCode());
    const [row] = await t.db
      .select()
      .from(users)
      .where(eq(users.id, (await json(response)).user_id));
    expect(row?.languageCode).toBe('en');
  });

  it('an email in use is a 409 with the error body', async () => {
    const { email } = await signedUp();
    const response = await t.client.post('/auth/signup/email/start', { email });

    expect(response.status).toBe(409);
    expect(await json(response)).toEqual({
      detail: { error: 'email_already_in_use', message: 'Email already in use by another account.' },
    });
  });

  it('an unknown token is a 400', async () => {
    const response = await completeSignup('nope', '123456');
    expect(response.status).toBe(400);
    expect((await json(response)).detail.error).toBe('signup_token_invalid');
  });

  it('a weak password is a 400 and keeps the flow alive', async () => {
    const { token } = await startSignup();
    const code = lastCode();

    const weak = await completeSignup(token, code, { password: 'alllowercase' });
    expect(weak.status).toBe(400);
    expect((await json(weak)).detail.error).toBe('password_too_weak');

    expect((await completeSignup(token, code)).status).toBe(200);
  });

  it('the email taken during the flow is a 409 and ends the flow', async () => {
    const { email, token } = await startSignup();
    const code = lastCode();
    await createUser(t.db, { email, emailVerified: true });

    expect((await completeSignup(token, code)).status).toBe(409);
    expect((await completeSignup(token, code)).status).toBe(400);
  });

  it('wrong codes end the flow and start the cooldown', async () => {
    const { email, token } = await startSignup();
    const wrong = wrongCode();

    for (let attempt = 0; attempt < EMAIL_MAX_CODE_ATTEMPTS; attempt++) {
      const response = await completeSignup(token, wrong);
      expect(response.status).toBe(400);
      expect((await json(response)).detail.error).toBe('code_invalid');
    }

    // The token is gone, whatever the code
    const after = await completeSignup(token, lastCode());
    expect((await json(after)).detail.error).toBe('signup_token_invalid');

    const restart = await t.client.post('/auth/signup/email/start', { email });
    expect(restart.status).toBe(429);
    expect((await json(restart)).detail.error).toBe('rate_limited');
  });

  it('too many starts for one email are a 429', async () => {
    const email = nextEmail();
    for (let attempt = 0; attempt < EMAIL_RATE_LIMIT_MAX; attempt++) await startSignup(email);

    const response = await t.client.post('/auth/signup/email/start', { email });
    expect(response.status).toBe(429);
  });

  it('a failed send is a 503, and nothing is left behind', async () => {
    resendFailures.push({ status: 500, message: 'boom' });
    const email = nextEmail();

    const response = await t.client.post('/auth/signup/email/start', { email });

    expect(response.status).toBe(503);
    expect((await json(response)).detail.error).toBe('email_send_failed');
    expect(await t.fakes.redis.get(`email:rate:${email}`)).toBeNull();
  });

  it('no email configured is a 503', async () => {
    settings.email.apiKey = '';
    const response = await t.client.post('/auth/signup/email/start', { email: nextEmail() });
    expect(response.status).toBe(503);
  });

  it("an unverified domain falls back to Resend's onboarding sender", async () => {
    resendFailures.push({ status: 403, message: 'The example.com domain is not verified.' });

    const response = await t.client.post('/auth/signup/email/start', { email: nextEmail() });

    expect(response.status).toBe(200);
    expect(emails[0]?.from).toBe(`${settings.email.fromName} <onboarding@resend.dev>`);
  });

  it.each([
    ['a short code', { code: '123' }, 'code'],
    ['a code with letters', { code: '12345a' }, 'code'],
    ['a short password', { password: 'Ab1' }, 'password'],
    ['a short username', { username: 'ab' }, 'username'],
    ['a bad username', { username: 'has space' }, 'username'],
  ])('%s is a 422', async (_name, overrides, field) => {
    const response = await completeSignup('token', '123456', overrides);
    expect(response.status).toBe(422);
    expect((await json(response)).detail[0].loc).toEqual(['body', field]);
  });
});

describe('login', () => {
  it('by email and by username, updating last_login_at', async () => {
    const { email, username, id } = await signedUp();
    await t.db
      .update(users)
      .set({ lastLoginAt: new Date('2020-01-01T00:00:00Z') })
      .where(eq(users.id, id));

    const byEmail = await login(email.toUpperCase());
    expect(byEmail.status).toBe(200);
    expect(await json(byEmail)).toEqual({ user_id: id, username, email, message: 'Login successful' });
    expect(sessionFrom(byEmail)).toBeDefined();

    const [row] = await t.db.select().from(users).where(eq(users.id, id));
    expect(row?.lastLoginAt?.getFullYear()).toBeGreaterThan(2020);

    const byUsername = await login(` ${username.toUpperCase()} `);
    expect(byUsername.status).toBe(200);
  });

  it('a session cookie has the configured attributes', async () => {
    const { email } = await signedUp();
    const [cookie] = (await login(email)).headers.getSetCookie();

    expect(cookie).toContain(`Max-Age=${settings.session.expireDays * 86400}`);
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).not.toContain('Secure'); // SESSION__COOKIE_SECURE=false in .env.test
  });

  it('wrong password, unknown user: the same 401', async () => {
    const { email } = await signedUp();

    for (const response of [await login(email, 'Wrong1234'), await login('nobody@example.com')]) {
      expect(response.status).toBe(401);
      expect(await json(response)).toEqual({
        detail: { error: 'invalid_credentials', message: 'Invalid credentials.' },
      });
      expect(sessionFrom(response)).toBeUndefined();
    }
  });

  it('a user with no password can not login', async () => {
    const email = nextEmail();
    await createUser(t.db, { email, emailVerified: true, passwordHash: null });
    expect((await login(email)).status).toBe(401);
  });

  it('login by username needs a verified email', async () => {
    const username = nextUsername();
    await createUser(t.db, { username, passwordHash: await passwordService.hashPassword(PASSWORD) });
    expect((await login(username)).status).toBe(401);
  });

  it('locks the account after too many failures, a success resets the count', async () => {
    const { email } = await signedUp();
    expect((await login(email)).status).toBe(200); // the signup itself counts for the email

    for (let attempt = 0; attempt < EMAIL_RATE_LIMIT_MAX - 1; attempt++) {
      expect((await login(email, 'Wrong1234')).status).toBe(401);
    }
    expect((await login(email)).status).toBe(200);

    for (let attempt = 0; attempt < EMAIL_RATE_LIMIT_MAX; attempt++) {
      expect((await login(email, 'Wrong1234')).status).toBe(401);
    }

    const locked = await login(email);
    expect(locked.status).toBe(423);
    expect((await json(locked)).detail.error).toBe('account_locked');
  });

  it('a username is locked apart from the email', async () => {
    const { email, username } = await signedUp();
    for (let attempt = 0; attempt < EMAIL_RATE_LIMIT_MAX; attempt++) await login(username, 'Wrong1234');

    expect((await login(username)).status).toBe(423);
    expect((await login(email)).status).toBe(200);
  });
});

describe('linking an email', () => {
  const start = (user: { id: string }, email: string) =>
    t.client.post('/auth/link/email/start', { email }, { headers: asUser(user) });
  const complete = (user: { id: string }, code: string, password = PASSWORD) =>
    t.client.post('/auth/link/email/complete', { code, password }, { headers: asUser(user) });

  it('sets the email and the password of a Telegram user', async () => {
    const user = await createUser(t.db, { displayName: 'Ann' });
    const email = nextEmail();

    const started = await start(user, email);
    expect(started.status).toBe(200);
    expect(await json(started)).toEqual({ message: 'Verification code sent', expires_in: 600 });
    expect(emails[0]?.html).toContain('Hi Ann,');

    const completed = await complete(user, lastCode());
    expect(completed.status).toBe(200);
    expect(await json(completed)).toEqual({ message: 'Email linked successfully', success: true });

    const [row] = await t.db.select().from(users).where(eq(users.id, user.id));
    expect(row).toMatchObject({ email, emailVerified: true });
    expect(row?.emailVerifiedAt).toBeInstanceOf(Date);
    expect((await login(email)).status).toBe(200);
  });

  it('a user with a verified email gets a 409', async () => {
    const user = await createUser(t.db, { email: nextEmail(), emailVerified: true });
    const response = await start(user, nextEmail());
    expect(response.status).toBe(409);
    expect((await json(response)).detail.error).toBe('email_already_verified');
  });

  it("another user's email is a 409", async () => {
    const { email } = await signedUp();
    const response = await start(await createUser(t.db), email);
    expect(response.status).toBe(409);
    expect((await json(response)).detail.error).toBe('email_already_in_use');
  });

  it('complete without a started flow is a 410', async () => {
    const response = await complete(await createUser(t.db), '123456');
    expect(response.status).toBe(410);
    expect((await json(response)).detail.error).toBe('code_expired');
  });

  it('wrong codes end the flow', async () => {
    const user = await createUser(t.db);
    await start(user, nextEmail());
    const wrong = wrongCode();

    for (let attempt = 0; attempt < EMAIL_MAX_CODE_ATTEMPTS; attempt++) {
      expect((await complete(user, wrong)).status).toBe(400);
    }
    expect((await complete(user, lastCode())).status).toBe(410);
  });

  it('a new link flow starts the wrong-code count over', async () => {
    const user = await createUser(t.db);
    await start(user, nextEmail());
    const wrong = wrongCode();
    for (let attempt = 1; attempt < EMAIL_MAX_CODE_ATTEMPTS; attempt++) {
      expect((await complete(user, wrong)).status).toBe(400);
    }

    await start(user, nextEmail());
    expect((await complete(user, wrongCode())).status).toBe(400);
    expect((await complete(user, lastCode())).status).toBe(200);
  });

  it('a logged-out visitor (the shared guest row) gets a 401', async () => {
    const started = await t.client.post('/auth/link/email/start', { email: nextEmail() });
    expect(started.status).toBe(401);
    expect((await json(started)).detail.error).toBe('not_authenticated');
    expect(emails).toHaveLength(0);

    const completed = await t.client.post('/auth/link/email/complete', { code: '123456', password: PASSWORD });
    expect(completed.status).toBe(401);
  });

  it('a body with a bad code is a 422, after auth', async () => {
    const response = await complete(await createUser(t.db), 'nope');
    expect(response.status).toBe(422);
  });
});

describe('password reset', () => {
  const start = (email: string) => t.client.post('/auth/password/reset/start', { email });
  const complete = (token: string, code: string, newPassword = 'NewPassword456') =>
    t.client.post('/auth/password/reset/complete', { reset_token: token, code, new_password: newPassword });

  it('sets a new password', async () => {
    const { email } = await signedUp();

    const started = await start(email);
    expect(started.status).toBe(200);
    const { reset_token: token, expires_in: expiresIn } = await json(started);
    expect(expiresIn).toBe(600);

    const completed = await complete(token, lastCode());
    expect(completed.status).toBe(200);
    expect(await json(completed)).toEqual({ success: true });

    expect((await login(email, PASSWORD)).status).toBe(401);
    expect((await login(email, 'NewPassword456')).status).toBe(200);
  });

  it('ends the sessions from before it; a login after it works', async () => {
    const { email, id } = await signedUp();
    const stolen = sessionFrom(await login(email));
    const me = (session?: string) => t.client.get('/users/me', { headers: { cookie: `${COOKIE}=${session}` } });
    expect((await json(await me(stolen))).id).toBe(id);

    const { reset_token: token } = await json(await start(email));
    expect((await complete(token, lastCode())).status).toBe(200);

    expect((await json(await me(stolen))).id).not.toBe(id); // the shared guest now
    const fresh = sessionFrom(await login(email, 'NewPassword456'));
    expect((await json(await me(fresh))).id).toBe(id);
  });

  it('an unknown email gets the same answer, and no email', async () => {
    const sentBefore = emails.length;
    const response = await start('nobody@example.com');

    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({ reset_token: expect.any(String), expires_in: 600 });
    expect(emails).toHaveLength(sentBefore);
  });

  it('the dummy token of an unknown email leads nowhere', async () => {
    const { reset_token: token } = await json(await start('nobody@example.com'));
    const response = await complete(token, '123456');
    expect(response.status).toBe(400);
    expect((await json(response)).detail.error).toBe('reset_token_invalid');
  });

  it('clears the lockout', async () => {
    const { email } = await signedUp();
    for (let attempt = 0; attempt < EMAIL_RATE_LIMIT_MAX; attempt++) await login(email, 'Wrong1234');
    expect((await login(email)).status).toBe(423);

    const { reset_token: token } = await json(await start(email));
    await complete(token, lastCode());

    expect((await login(email, 'NewPassword456')).status).toBe(200);
  });

  it('wrong codes end the flow; a code of another length is just wrong', async () => {
    const { email } = await signedUp();
    const { reset_token: token } = await json(await start(email));

    expect((await complete(token, '1')).status).toBe(400);
    for (let attempt = 1; attempt < EMAIL_MAX_CODE_ATTEMPTS; attempt++) {
      expect((await complete(token, wrongCode())).status).toBe(400);
    }

    const response = await complete(token, lastCode());
    expect((await json(response)).detail.error).toBe('reset_token_invalid');
  });

  it('concurrent wrong codes each count: no more than the cap get tried', async () => {
    const { email } = await signedUp();
    const { reset_token: token } = await json(await start(email));
    const wrong = wrongCode();

    // Every request reads the flow before any of them answers: Python's read-check-write lets each one read
    // attempts=0 and try its code
    const redis = t.fakes.redis;
    const read = redis.get.bind(redis);
    const slowRead = vi.spyOn(redis, 'get').mockImplementation(async (key) => {
      const value = await read(key);
      await new Promise((resolve) => setTimeout(resolve, 50));
      return value;
    });
    const responses = await Promise.all(
      Array.from({ length: EMAIL_MAX_CODE_ATTEMPTS * 3 }, () => complete(token, wrong)),
    ).finally(() => slowRead.mockRestore());
    for (const response of responses) expect(response.status).toBe(400);

    const response = await complete(token, lastCode());
    expect((await json(response)).detail.error).toBe('reset_token_invalid');
    expect((await login(email, 'NewPassword456')).status).toBe(401);
  });

  it('a right code does not use up an attempt', async () => {
    const { email } = await signedUp();
    const { reset_token: token } = await json(await start(email));
    const wrong = wrongCode();
    for (let attempt = 1; attempt < EMAIL_MAX_CODE_ATTEMPTS; attempt++) {
      expect((await complete(token, wrong)).status).toBe(400);
    }

    expect((await complete(token, lastCode(), 'weak')).status).toBe(400); // right code, weak password
    expect((await complete(token, lastCode())).status).toBe(200);
  });

  it('wrong codes count per email across tokens: 4 per fresh token stop at the cap, the right code too', async () => {
    // Under the per-token cap on every token, with a new reset each time, used to be guesses without end
    const { email } = await signedUp();
    let tried = 0;
    let token = '';
    while (tried < EMAIL_MAX_CODE_FAILURES) {
      token = (await json(await start(email))).reset_token;
      for (let attempt = 1; attempt < EMAIL_MAX_CODE_ATTEMPTS && tried < EMAIL_MAX_CODE_FAILURES; attempt++) {
        expect((await complete(token, wrongCode())).status).toBe(400);
        tried += 1;
      }
    }

    const right = await complete(token, lastCode());
    expect(right.status).toBe(429);
    expect((await json(right)).detail.error).toBe('rate_limited');
    const restart = await start(email);
    expect(restart.status).toBe(429);
    expect((await json(restart)).detail.error).toBe('rate_limited');
    expect((await login(email, 'NewPassword456')).status).toBe(401);
  });

  it('right codes do not count toward the per-email cap', async () => {
    const { email } = await signedUp();
    for (let reset = 0; reset < EMAIL_MAX_CODE_FAILURES + 1; reset++) {
      const { reset_token: token } = await json(await start(email));
      expect((await complete(token, lastCode(), 'weak')).status).toBe(400); // right code, weak password
    }
    const { reset_token: token } = await json(await start(email));
    expect((await complete(token, lastCode())).status).toBe(200);
  });

  it('a weak new password is a 400', async () => {
    const { email } = await signedUp();
    const { reset_token: token } = await json(await start(email));

    const response = await complete(token, lastCode(), 'weak');
    expect(response.status).toBe(400);
    expect((await json(response)).detail.error).toBe('password_too_weak');
  });
});

describe('resend', () => {
  const resend = (body?: object, headers: Record<string, string> = {}) =>
    t.client.post('/auth/signup/email/resend', body, { headers });

  it('a new signup code replaces the old one and resets the attempts', async () => {
    const { token } = await startSignup();
    const oldCode = lastCode();
    const wrong = wrongCode();
    for (let attempt = 0; attempt < EMAIL_MAX_CODE_ATTEMPTS - 1; attempt++) await completeSignup(token, wrong);

    const response = await resend({ signup_token: token });

    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({ message: 'Verification code sent', expires_in: 600 });
    const newCode = lastCode();
    expect(emails).toHaveLength(2);

    if (oldCode !== newCode) expect((await completeSignup(token, oldCode)).status).toBe(400);
    expect((await completeSignup(token, newCode)).status).toBe(200);
  });

  it('without a token, the code of the user’s link flow', async () => {
    const user = await createUser(t.db, { displayName: 'Ann' });
    await t.client.post('/auth/link/email/start', { email: nextEmail() }, { headers: asUser(user) });

    const response = await resend({}, asUser(user));

    expect(response.status).toBe(200);
    expect(emails).toHaveLength(2);
    expect(emails[1]?.html).toContain('Hi Ann,');
  });

  it('an unknown signup token is a 400', async () => {
    const response = await resend({ signup_token: 'nope' });
    expect(response.status).toBe(400);
    expect((await json(response)).detail.error).toBe('signup_token_invalid');
  });

  it('no link flow is a 410', async () => {
    const response = await resend({}, asUser(await createUser(t.db)));
    expect(response.status).toBe(410);
    expect((await json(response)).detail.error).toBe('code_expired');
  });

  it('no body at all is a 422', async () => {
    const response = await resend();
    expect(response.status).toBe(422);
    expect((await json(response)).detail[0]).toMatchObject({ type: 'missing', loc: ['body'] });
  });

  it('a rate limited email is a 429', async () => {
    const { email, token } = await startSignup();
    await t.fakes.redis.set(`email:rate:${email}`, String(EMAIL_RATE_LIMIT_MAX));
    expect((await resend({ signup_token: token })).status).toBe(429);
  });
});
