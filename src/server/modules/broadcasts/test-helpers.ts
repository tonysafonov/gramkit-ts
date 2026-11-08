/** Helpers shared by this module's tests. */
import type { Database } from '../../db/client';
import {
  type NewPromotionalBroadcast,
  NotificationTimeSlot,
  type PromotionalBroadcast,
  promotionalBroadcasts,
} from '../../db/schema';
import { Repos } from '../../repos';
import { Services } from '../../services';
import type { FakeBot, TestApp } from '../../testing';
import type { TestServices } from '../../testing/auth';

/** Thrown to roll a test's transaction back (Python's per-test `db_session` rollback). */
const ROLLBACK = new Error('rollback');

/**
 * Run `fn` with a `Services` on one transaction that is rolled back afterwards, so the test leaves nothing behind.
 */
export async function withServices<T>(t: TestApp<TestServices>, fn: (services: Services) => Promise<T>): Promise<T> {
  let result: T | undefined;
  try {
    await t.db.transaction(async (tx) => {
      const { bot, queue, redis, producer } = t.fakes;
      result = await fn(new Services(new Repos(tx), producer, bot.bot, redis, queue));
      throw ROLLBACK;
    });
  } catch (err) {
    if (err !== ROLLBACK) throw err;
  }
  return result as T;
}

let sequence = 0;

/** A broadcast row, active, one day to its deadline, from a creator that no other row has. */
export function broadcastRow(overrides: Partial<NewPromotionalBroadcast> = {}): NewPromotionalBroadcast {
  sequence += 1;
  return {
    messageType: 'text',
    messageText: 'x',
    messageHtml: 'x',
    hasTextFormatting: false,
    timeSlot: NotificationTimeSlot.MORNING,
    deadline: new Date(Date.now() + 24 * 3600 * 1000),
    priority: 80,
    createdByUserId: 10_000_000 + sequence,
    ...overrides,
  };
}

export const insertBroadcast = async (
  db: Database,
  overrides: Partial<NewPromotionalBroadcast> = {},
): Promise<PromotionalBroadcast> => {
  const [row] = await db.insert(promotionalBroadcasts).values(broadcastRow(overrides)).returning();
  if (!row) throw new Error('no row');
  return row;
};

/**
 * Make the fake bot answer media sends like Telegram does: a message carrying a `file_id`, which is what the media
 * upload mints from. Photos come in sizes, as Telegram sends them.
 */
export function mintFileIds(fake: FakeBot): void {
  const media: Record<string, Record<string, unknown>> = {
    sendPhoto: { photo: [{ file_id: 'file_photo_small' }, { file_id: 'file_photo_123' }] },
    sendVideo: { video: { file_id: 'file_video_123' } },
    sendAnimation: { animation: { file_id: 'file_animation_123' } },
    sendDocument: { document: { file_id: 'file_document_123' } },
  };
  fake.bot.api.config.use(async (prev, method, payload, signal) => {
    const response = await prev(method, payload, signal);
    const fields = media[method];
    if (!fields || !response.ok) return response;
    return { ...response, result: { ...(response.result as object), ...fields } } as typeof response;
  });
}
