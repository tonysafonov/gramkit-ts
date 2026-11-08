/** The hourly slot jobs: run a slot in one transaction and report `{ sent }`. */
import { describe, expect, it } from 'vitest';
import type { Services } from '../../services';
import { eveningNotificationJob, morningNotificationJob, type NotificationJobContext } from './jobs';

const contextFor = (notifications: object): NotificationJobContext => ({
  withTransaction: (fn) => fn({ notifications } as unknown as Services),
});

describe('slot jobs', () => {
  it('the morning job runs the morning slot', async () => {
    const ctx = contextFor({
      sendMorningNotification: async () => ({ MorningPromotionalBroadcast: 3 }),
    });
    expect(await morningNotificationJob(ctx)).toEqual({ sent: 0 }); // keyed by template name, as Python's job reads it
  });

  it('the evening job runs the evening slot', async () => {
    const ctx = contextFor({ sendEveningNotification: async () => ({ sent: 2 }) });
    expect(await eveningNotificationJob(ctx)).toEqual({ sent: 2 });
  });

  it('a failing slot rethrows', async () => {
    const ctx = contextFor({
      sendMorningNotification: async () => {
        throw new Error('boom');
      },
    });
    await expect(morningNotificationJob(ctx)).rejects.toThrow('boom');
  });
});
