/** The session cookie, configured by `settings.session`. */
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { settings } from '../../config';

const attributes = () => ({
  httpOnly: settings.session.cookieHttponly,
  secure: settings.session.cookieSecure,
  sameSite: settings.session.cookieSamesite,
  path: '/',
  domain: settings.session.cookieDomain,
});

export function setSessionCookie(c: Context, sessionId: string): void {
  setCookie(c, settings.session.cookieName, sessionId, {
    ...attributes(),
    maxAge: settings.session.expireDays * 24 * 60 * 60,
  });
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, settings.session.cookieName, attributes());
}

export const getSessionFromRequest = (c: Context): string | undefined => getCookie(c, settings.session.cookieName);
