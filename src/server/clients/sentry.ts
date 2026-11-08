import * as Sentry from '@sentry/node';
import { settings } from '../config';
import { setUserContext } from '../lib/request-context';

let enabled = false;

/** Initialize Sentry once per process, when a DSN is configured. */
export function initSentry(release: string): void {
  const { observability } = settings;
  if (enabled || !observability.sentryEnabled) return;
  Sentry.init({
    dsn: observability.sentryDsn,
    environment: observability.environment,
    release,
    // User info, as Python's send_default_pii. Never request bodies: they carry users' own free text, which must not
    // leave our server.
    dataCollection: { userInfo: true, httpBodies: [] },
    tracesSampleRate: observability.sentryTracesSampleRate,
    profileSessionSampleRate: observability.sentryProfilesSampleRate,
  });
  enabled = true;
}

export const captureException = (error: unknown): void => {
  if (enabled) Sentry.captureException(error);
};

/** Keep what `setSentryUser` sets on this request, off the process-wide scope. */
export const withSentryScope = <T>(fn: () => T): T => (enabled ? Sentry.withIsolationScope(() => fn()) : fn());

interface SentryUser {
  userId: string;
  username?: string | null;
  email?: string | null;
  tgUsername?: string | null;
}

/** Set the user for both Sentry and request logging. */
export function setSentryUser({ userId, username, email, tgUsername }: SentryUser): void {
  setUserContext(userId);
  if (enabled) {
    Sentry.setUser({
      id: userId,
      username: username ?? undefined,
      email: email ?? undefined,
      tg_username: tgUsername ?? undefined,
    });
  }
}

export async function closeSentry(): Promise<void> {
  if (enabled) await Sentry.close(2000);
}
