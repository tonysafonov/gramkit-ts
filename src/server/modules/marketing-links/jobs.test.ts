/** The hourly alerts job: it collects the due alerts, sends them, and marks them sent so they go out once. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UserRole } from '../../db/schema';
import { createTestApp, createUser, type TestApp } from '../../testing';
import { servicesFor, uniq } from '../analytics/test-support';
import { marketingLinksAlertsJob } from './jobs';

describe('marketingLinksAlertsJob', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  it('sends each alert once', async () => {
    const actor = await createUser(t.db, { role: UserRole.ADMIN });
    const services = servicesFor(t);
    const code = uniq('t');
    const link = await services.marketingLinks.create(actor, { code });
    await createUser(t.db, { referralCode: code });

    const ctx = { bot: t.fakes.bot.bot, withTransaction: <T>(fn: (s: typeof services) => Promise<T>) => fn(services) };
    const first = await marketingLinksAlertsJob(ctx as never);
    expect(first.sent).toBeGreaterThanOrEqual(1);

    const stored = await services.marketingLinks.pendingAlerts();
    expect(stored.filter((alert) => alert.linkId === link.id)).toEqual([]);
  });
});
