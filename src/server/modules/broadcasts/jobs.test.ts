/**
 * `userBroadcastJob`: the one broadcast send path. Real Postgres through a worker context whose `withTransaction`
 * commits like production, the real services, and the fake bot that records every Telegram call.
 */
import { eq } from 'drizzle-orm';
import type { Transformer } from 'grammy';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NotificationSlot, notificationDeliveries, promotionalBroadcasts, type User, users } from '../../db/schema';
import { t as translate } from '../../lib/i18n';
import { Repos } from '../../repos';
import { Services } from '../../services';
import { createTestApp, createUser, type TestApp } from '../../testing';
import type { TestServices } from '../../testing/auth';
import { engineConfig } from '../notifications/service';
import { setBroadcastAppUrl } from './formatting';
import { type BroadcastJobContext, broadcastJobSettings, broadcastMessageKey, userBroadcastJob } from './jobs';
import { insertBroadcast } from './test-helpers';

const REQUESTER = 4242;
const APP_URL = 'https://t.me/test_bot/app';

let app: TestApp<TestServices>;
let restoreAppUrl: () => string;
let restoreInterval: number;

beforeEach(async () => {
  restoreAppUrl = setBroadcastAppUrl(() => APP_URL);
  restoreInterval = engineConfig.sendIntervalMs;
  engineConfig.sendIntervalMs = 0;
  app = await createTestApp();
});

afterEach(async () => {
  setBroadcastAppUrl(restoreAppUrl);
  engineConfig.sendIntervalMs = restoreInterval;
  broadcastJobSettings.chunkSize = 100;
  await app.close();
});

/** A worker context: `withTransaction` is one short committed transaction, `withoutTransaction` holds none. */
function workerContext(overrides: Partial<BroadcastJobContext> = {}): BroadcastJobContext {
  const { bot, queue, redis, producer } = app.fakes;
  return {
    withTransaction: (fn) =>
      app.db.transaction((tx) => fn(new Services(new Repos(tx), producer, bot.bot, redis, queue))),
    withoutTransaction: (fn) => fn(new Services(new Repos(app.db), producer, bot.bot, redis, queue)),
    ...overrides,
  };
}

const makeUsers = async (count: number, overrides: Partial<Parameters<typeof createUser>[1]> = {}) => {
  const created: User[] = [];
  for (let i = 0; i < count; i++) created.push(await createUser(app.db, overrides));
  return created;
};

const deliveries = () => app.db.select().from(notificationDeliveries);
const reload = async (id: number) => {
  const [row] = await app.db.select().from(promotionalBroadcasts).where(eq(promotionalBroadcasts.id, id));
  if (!row) throw new Error('missing row');
  return row;
};

type Payload = { chat_id: number; text?: string; parse_mode?: string; reply_markup?: unknown } & Record<
  string,
  unknown
>;
const messages = () => app.fakes.bot.sent('sendMessage').map((call) => call.payload as Payload);
const toUsers = () => messages().filter((m) => m.chat_id !== REQUESTER);
const run = (ctx: BroadcastJobContext, broadcastData: object, requesterTelegramId = REQUESTER, broadcastId?: number) =>
  userBroadcastJob(ctx, { broadcastData, requesterTelegramId, broadcastId });

describe('userBroadcastJob', () => {
  it('text reaches everyone and logs each delivery', async () => {
    const created = await makeUsers(2);

    const result = await run(workerContext(), { message_type: 'text', message_text: 'Hi all', run_id: 'r1' });

    expect(result).toEqual({ sent: 2, total: 2, failed: 0, success_rate: 100.0 });
    expect(
      toUsers()
        .map((m) => m.chat_id)
        .sort(),
    ).toEqual(created.map((u) => u.telegramId).sort());
    expect(toUsers().every((m) => m.text === 'Hi all' && m.parse_mode === undefined)).toBe(true);
    const rows = await deliveries();
    expect(new Set(rows.map((r) => [r.template, r.messageKey, r.slot, r.delivered].join('|')))).toEqual(
      new Set([`ImmediateBroadcastNotification|broadcast_now.r1|${NotificationSlot.OTHER}|true`]),
    );
    expect(rows).toHaveLength(2);
    const done = messages().filter((m) => m.chat_id === REQUESTER);
    expect(done.map((m) => m.text)).toEqual([
      translate('core.admin.broadcasts.done', 'en', { sent: 2, total: 2, rate: '100.0' }),
    ]);
  });

  it('every media type is sent', async () => {
    await makeUsers(1);

    for (const type of ['video', 'animation', 'document']) {
      await run(workerContext(), { message_type: type, media_file_id: `file-${type}`, caption: 'c' });
    }

    const sent = (method: string) => app.fakes.bot.sent(method).map((c) => c.payload);
    expect(sent('sendVideo')).toMatchObject([{ video: 'file-video', caption: 'c' }]);
    expect(sent('sendAnimation')).toMatchObject([{ animation: 'file-animation', caption: 'c' }]);
    expect(sent('sendDocument')).toMatchObject([{ document: 'file-document', caption: 'c' }]);
  });

  it("the bot's legacy photo payload", async () => {
    await makeUsers(1);

    const result = await run(workerContext(), {
      message_type: 'photo',
      photo_file_id: 'AgAC',
      caption: 'Look',
      caption_html: '<b>Look</b>',
      has_caption_formatting: true,
      keyboard_type: 'none',
    });

    expect(result.sent).toBe(1);
    expect(app.fakes.bot.sent('sendPhoto').map((c) => c.payload)).toMatchObject([
      { photo: 'AgAC', caption: '<b>Look</b>', parse_mode: 'HTML' },
    ]);
  });

  it('blocked users are skipped and new blocks flagged', async () => {
    const [reachable, newlyBlocked] = await makeUsers(2);
    await makeUsers(1, { botBlockedAt: new Date() });
    // The fake answers 403 for the chat of the user who blocked the bot.
    app.fakes.bot.bot.api.config.use((prev, method, payload, signal) =>
      method === 'sendMessage' && (payload as Payload).chat_id === newlyBlocked?.telegramId
        ? (Promise.resolve({
            ok: false,
            error_code: 403,
            description: 'Forbidden: bot was blocked by the user',
          }) as never)
        : prev(method, payload, signal),
    );

    const result = await run(workerContext(), { message_type: 'text', message_text: 'x' });

    expect([result.sent, result.total, result.failed]).toEqual([1, 2, 1]);
    expect(toUsers().map((m) => m.chat_id)).toEqual([reachable?.telegramId]);
    const [flagged] = await app.db
      .select()
      .from(users)
      .where(eq(users.id, (newlyBlocked as User).id));
    expect(flagged?.botBlockedAt).not.toBeNull();
    const row = (await deliveries()).find((r) => r.userId === newlyBlocked?.id);
    expect(row?.errorCode).toBe('forbidden');
  });

  it('a saved row counts one cycle', async () => {
    await makeUsers(3);
    const row = await insertBroadcast(app.db, { createdByUserId: REQUESTER });

    await run(workerContext(), { message_type: 'text', message_text: 'Saved', run_id: 'r2' }, REQUESTER, row.id);

    const after = await reload(row.id);
    expect([after.sentCount, after.successCount, after.failCount, after.cyclesRun]).toEqual([3, 3, 0, 1]);
    expect(after.lastSentAt).not.toBeNull();
    expect(new Set((await deliveries()).map((r) => r.messageKey))).toEqual(
      new Set([broadcastMessageKey('r2', row.id)]),
    );
  });

  it('counts land per chunk', async () => {
    broadcastJobSettings.chunkSize = 2;
    await makeUsers(5);
    const row = await insertBroadcast(app.db);

    const result = await run(workerContext(), { message_type: 'text', message_text: 'x' }, REQUESTER, row.id);

    expect(result.sent).toBe(5);
    const after = await reload(row.id);
    expect([after.successCount, after.cyclesRun]).toEqual([5, 1]);
  });

  it('a re-run of the same run sends nothing twice', async () => {
    // The queue re-runs an interrupted job from the start (e.g. a deploy restarts the worker).
    await makeUsers(2);
    const row = await insertBroadcast(app.db);
    const payload = { message_type: 'text', message_text: 'Once', run_id: 'same-run' };
    await run(workerContext(), payload, REQUESTER, row.id);
    const [late] = await makeUsers(1);
    app.fakes.bot.clear();

    const result = await run(workerContext(), payload, REQUESTER, row.id);

    expect(toUsers().map((m) => m.chat_id)).toEqual([late?.telegramId]); // only who the run hadn't reached
    expect([result.sent, result.total]).toEqual([3, 3]);
    const after = await reload(row.id);
    expect([after.successCount, after.cyclesRun]).toEqual([3, 1]);
  });

  it('sends run outside any transaction', async () => {
    // Slow Telegram sends must not hold a DB connection (and an open transaction).
    broadcastJobSettings.chunkSize = 2;
    await makeUsers(3);
    const row = await insertBroadcast(app.db);
    let open = 0;
    const seen: number[] = [];
    const base = workerContext();
    const ctx = workerContext({
      withTransaction: async (fn) => {
        open += 1;
        try {
          return await base.withTransaction(fn);
        } finally {
          open -= 1;
        }
      },
    });
    app.fakes.bot.bot.api.config.use((prev, method, payload, signal) => {
      if (method === 'sendMessage' && (payload as Payload).chat_id !== REQUESTER) seen.push(open);
      return prev(method, payload, signal);
    });

    const result = await run(ctx, { message_type: 'text', message_text: 'x' }, REQUESTER, row.id);

    expect(result.sent).toBe(3);
    expect(seen).toEqual([0, 0, 0]);
    const after = await reload(row.id);
    expect([after.successCount, after.cyclesRun]).toEqual([3, 1]);
    expect(await deliveries()).toHaveLength(3);
  });

  it('stopped inside a chunk: no further sends, what went out is recorded, and a re-run finishes', async () => {
    // Python's CancelledError passes through the per-user `except Exception`; an abort must too.
    broadcastJobSettings.chunkSize = 100;
    const created = await makeUsers(4);
    const row = await insertBroadcast(app.db);
    const controller = new AbortController();
    const { bot } = app.fakes;
    const stopAfterSecondSend = (async (prev, method, payload, signal) => {
      const result = await prev(method, payload, signal);
      if (method === 'sendMessage' && toUsers().length === 2) controller.abort();
      return result;
    }) as Transformer;
    bot.bot.api.config.use(stopAfterSecondSend);
    const ctx = workerContext({ signal: controller.signal });
    const payload = { message_type: 'text', message_text: 'x', run_id: 'stopped-inside' };

    await expect(run(ctx, payload, REQUESTER, row.id)).rejects.toThrow();

    expect(toUsers()).toHaveLength(2);
    expect((await deliveries()).filter((r) => r.delivered)).toHaveLength(2);
    const stopped = await reload(row.id);
    expect([stopped.sentCount, stopped.successCount]).toEqual([2, 2]);
    expect(
      messages()
        .filter((m) => m.chat_id === REQUESTER)
        .map((m) => m.text),
    ).toEqual([translate('core.admin.broadcasts.stopped', 'en', { sent: 2, total: 4 })]);

    await run(workerContext(), payload, REQUESTER, row.id);

    expect(new Set(toUsers().map((m) => m.chat_id))).toEqual(new Set(created.map((u) => u.telegramId)));
    expect(toUsers()).toHaveLength(4);
  });

  it('stopped between chunks: records what went out, tells the requester, and a re-run finishes', async () => {
    // The worker aborts the job on its timeout (no retry) or a shutdown (retried later).
    broadcastJobSettings.chunkSize = 2;
    await makeUsers(4);
    const row = await insertBroadcast(app.db);
    const controller = new AbortController();
    let sendPhases = 0;
    const base = workerContext();
    const ctx = workerContext({
      signal: controller.signal,
      withoutTransaction: async (fn) => {
        sendPhases += 1;
        if (sendPhases === 2) {
          controller.abort();
          throw new DOMException('aborted', 'AbortError');
        }
        return base.withoutTransaction(fn);
      },
    });
    const payload = { message_type: 'text', message_text: 'x', run_id: 'stopped-run' };

    await expect(run(ctx, payload, REQUESTER, row.id)).rejects.toThrow('aborted');

    expect((await deliveries()).filter((r) => r.delivered)).toHaveLength(2);
    const stopped = await reload(row.id);
    expect([stopped.sentCount, stopped.successCount, stopped.cyclesRun]).toEqual([2, 2, 1]);
    expect(
      messages()
        .filter((m) => m.chat_id === REQUESTER)
        .map((m) => m.text),
    ).toEqual([translate('core.admin.broadcasts.stopped', 'en', { sent: 2, total: 4 })]);

    // The worker re-runs the same job: only the two not reached yet get it.
    const sentBefore = new Set(toUsers().map((m) => m.chat_id));
    const result = await run(workerContext(), payload, REQUESTER, row.id);

    expect([result.sent, result.total]).toEqual([4, 4]);
    expect(
      new Set(
        toUsers()
          .map((m) => m.chat_id)
          .filter((id) => !sentBefore.has(id)),
      ).size,
    ).toBe(2);
    const after = await reload(row.id);
    expect([after.successCount, after.cyclesRun]).toEqual([4, 1]);
  });

  it('without a run id the queue job id keys the run', async () => {
    await makeUsers(1);
    const ctx = workerContext({ jobId: 'job-7' });

    await run(ctx, { message_type: 'text', message_text: 'x' });
    await run(ctx, { message_type: 'text', message_text: 'x' });

    expect(toUsers()).toHaveLength(1);
    expect(new Set((await deliveries()).map((r) => r.messageKey))).toEqual(new Set(['broadcast_now.job-7']));
  });

  it('the keyboard is built per user in their language', async () => {
    const [ruUser] = await makeUsers(1, { languageCode: 'ru' });
    const [enUser] = await makeUsers(1, { languageCode: 'en' });

    await run(workerContext(), { message_type: 'text', message_text: 'x', keyboard_type: 'main' });

    const buttons = Object.fromEntries(
      toUsers().map((m) => [
        m.chat_id,
        (m.reply_markup as { inline_keyboard: { text: string; url: string }[][] }).inline_keyboard[0]?.[0],
      ]),
    );
    expect(buttons[ruUser?.telegramId as number]?.text).toBe(translate('core.admin.broadcasts.open_app', 'ru'));
    expect(buttons[enUser?.telegramId as number]?.text).toBe('Open App');
    expect(buttons[ruUser?.telegramId as number]?.url).toBe(APP_URL);
  });

  it('the requester is answered in their language', async () => {
    const [owner] = await makeUsers(1, { languageCode: 'ru' });

    await run(workerContext(), { message_type: 'text', message_text: 'x' }, owner?.telegramId as number);

    const done = messages()
      .filter((m) => m.chat_id === owner?.telegramId)
      .at(-1);
    expect(done?.text).toBe(translate('core.admin.broadcasts.done', 'ru', { sent: 1, total: 1, rate: '100.0' }));
  });

  it('an invalid payload tells the requester and throws', async () => {
    await makeUsers(1);

    await expect(run(workerContext(), { message_type: 'video' })).rejects.toThrow(
      'Media send-now requires media_file_id',
    );

    expect(toUsers()).toEqual([]);
    const failed = messages().filter((m) => m.chat_id === REQUESTER);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.text?.startsWith('❌')).toBe(true);
    expect(failed[0]?.text).toContain('Media send-now requires media_file_id');
  });

  it('a user list with nobody in it sends nothing and still answers', async () => {
    const result = await run(workerContext(), { message_type: 'text', message_text: 'Test' });
    expect([result.sent, result.total]).toEqual([0, 0]);
  });
});

describe('broadcastMessageKey', () => {
  it('keeps a saved row id in the key and caps the length', () => {
    expect(broadcastMessageKey('abc')).toBe('broadcast_now.abc');
    expect(broadcastMessageKey('abc', 7)).toBe('promotional_broadcast.7.abc');
    expect(broadcastMessageKey('x'.repeat(300))).toHaveLength(128);
  });
});
