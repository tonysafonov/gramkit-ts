/**
 * Notification engine: delivery log, blocked flag, one message per slot, templates with their own kind of message.
 * Port of `test_notifications_engine.py` and the scheduled promo template tests of `test_broadcast_send_path.py`.
 *
 * Real Postgres (this file's own database) and a fake bot. Tests of the users module's own queries
 * (`getNotifiableUsers`, timezone validation, `/start` clearing the flag) live with the users module.
 */
import { eq } from 'drizzle-orm';
import { InlineKeyboard } from 'grammy';
import type { InlineKeyboardMarkup } from 'grammy/types';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { notificationDeliveries, promotionalBroadcasts, users } from '../../db/schema';
import { Repos } from '../../repos';
import { Services } from '../../services';
import { createTestApp, createUser, type TestApp } from '../../testing';
import { registerBroadcastKeyboard, setBroadcastAppUrl } from '../broadcasts/formatting';
import { SendFailure, sendErrorCode, userLanguage } from '../messages/send-failure';
import type { MessagesService } from '../messages/service';
import type { UserSchema } from '../users/schemas';
import {
  EveningPromotionalBroadcast,
  ImmediateBroadcastNotification,
  MorningPromotionalBroadcast,
  PromotionalBroadcastNotification,
} from './broadcasts';
import { engineConfig } from './service';
import { NotificationTemplate } from './types';

interface Failure {
  error_code: number;
  description: string;
  parameters?: { retry_after: number };
}
const FORBIDDEN: Failure = { error_code: 403, description: 'Forbidden: bot was blocked by the user' };
const BAD_REQUEST: Failure = { error_code: 400, description: 'Bad Request: chat not found' };
const RATE_LIMITED: Failure = {
  error_code: 429,
  description: 'Too Many Requests',
  parameters: { retry_after: 0 },
};

const SENDS = new Set(['sendMessage', 'sendPoll', 'sendPhoto']);

let t: TestApp<Services>;
let services: Services;
/** Chats whose sends fail like a user who blocked the bot (or worse), whatever the method. */
const failing = new Map<number, Failure | 'crash'>();
/** Failures handed out in order, whatever the chat. */
const queued: Failure[] = [];

beforeAll(async () => {
  engineConfig.sendIntervalMs = 0;
  setBroadcastAppUrl(() => 'https://t.me/test_bot/app');
  t = (await createTestApp()) as unknown as TestApp<Services>;
  services = new Services(new Repos(t.db), t.fakes.producer, t.fakes.bot.bot, t.fakes.redis, t.fakes.queue);
  t.fakes.bot.bot.api.config.use((prev, method, payload, signal) => {
    const chatId = (payload as { chat_id: number }).chat_id;
    const failure = SENDS.has(method) ? (queued.shift() ?? failing.get(chatId)) : undefined;
    if (failure === 'crash') throw new Error('network blew up');
    if (failure) return Promise.resolve({ ok: false, ...failure }) as never;
    return prev(method, payload, signal);
  });
});

afterAll(() => t.close());

beforeEach(async () => {
  failing.clear();
  queued.length = 0;
  t.fakes.bot.clear();
  t.fakes.posthog.events.length = 0;
  await t.db.delete(notificationDeliveries);
  await t.db.delete(promotionalBroadcasts);
});

const notifications = () => services.notifications;
const sentChats = () => t.fakes.bot.sent('sendMessage').map((call) => call.payload.chat_id);
const deliveries = (userId: string) =>
  t.db.select().from(notificationDeliveries).where(eq(notificationDeliveries.userId, userId));
const userRow = async (id: string) => (await t.db.select().from(users).where(eq(users.id, id)))[0];

class KeyPerUser extends NotificationTemplate {
  constructor() {
    super();
    this.priority = 10;
  }
  async getMessageKey() {
    return 'core.test.default';
  }
  override async getMessageKeyForUser(user: UserSchema) {
    return `core.test.${user.username}`;
  }
}

class HighPriorityEveryone extends NotificationTemplate {
  constructor() {
    super();
    this.priority = 100;
  }
  async getMessageKey() {
    return 'core.test.high';
  }
}

class LowPriorityEveryone extends NotificationTemplate {
  constructor() {
    super();
    this.priority = 1;
  }
  async getMessageKey() {
    return 'core.test.low';
  }
}

/** `preSendActions` narrows the audience (e.g. to users a gift was actually credited to). */
class SendsOnlyToSome extends NotificationTemplate {
  constructor(private readonly keep: Set<string>) {
    super();
  }
  async getMessageKey() {
    return 'core.test.some';
  }
  override async preSendActions(list: UserSchema[]) {
    return list.filter((user) => this.keep.has(user.id));
  }
}

describe('the delivery log', () => {
  it('logs every attempt with its outcome and per-user key', async () => {
    const [ok, blocked, broken] = [await createUser(t.db), await createUser(t.db), await createUser(t.db)] as [
      UserSchema,
      UserSchema,
      UserSchema,
    ];
    failing.set(blocked.telegramId as number, FORBIDDEN);
    failing.set(broken.telegramId as number, BAD_REQUEST);

    const [sent, eligible] = await notifications().sendNotification(
      new KeyPerUser().initialize(services),
      [ok, blocked, broken],
      'evening',
    );

    expect(sent).toBe(1);
    expect(eligible).toHaveLength(3);
    expect(sentChats()).toEqual([ok.telegramId]);
    const expected: [UserSchema, boolean, string | null][] = [
      [ok, true, null],
      [blocked, false, 'forbidden'],
      [broken, false, 'bad_request'],
    ];
    for (const [user, delivered, errorCode] of expected) {
      const [row, ...rest] = await deliveries(user.id);
      expect(rest).toEqual([]);
      expect([row?.delivered, row?.errorCode]).toEqual([delivered, errorCode]);
      expect(row?.template).toBe('KeyPerUser');
      expect(row?.messageKey).toBe(`core.test.${user.username}`);
      expect(row?.slot).toBe('evening');
    }
  });

  it('cap helpers: last sent, sent times since, delivered only or not', async () => {
    const user = await createUser(t.db);
    const other = await createUser(t.db);
    const log = services.repos.notificationDeliveries;
    const t0 = new Date('2026-09-01T19:00:00Z');
    const day = (days: number) => new Date(t0.getTime() + days * 86_400_000);
    for (const [days, delivered] of [
      [0, true],
      [5, true],
      [9, false],
    ] as const) {
      await log.record({
        userId: user.id,
        template: 'Invite',
        messageKey: 'k',
        slot: 'evening',
        delivered,
        errorCode: delivered ? null : 'other',
        sentAt: day(days),
      });
    }

    expect(await log.lastSentByUser('Invite', [user.id, other.id])).toEqual(new Map([[user.id, day(5)]]));
    expect(await log.lastSentByUser('Invite', [user.id], { deliveredOnly: false })).toEqual(
      new Map([[user.id, day(9)]]),
    );
    expect(await log.sentTimesByUser('Invite', [user.id, other.id], { since: day(1) })).toEqual(
      new Map([[user.id, [day(5)]]]),
    );
    expect(await log.deliveredUserIds('Invite', 'k', [user.id, other.id])).toEqual(new Set([user.id]));
    expect(await log.countForKey('Invite', 'k')).toBe(3);
  });

  it('deleting a user deletes their log', async () => {
    const user = await createUser(t.db);
    await services.repos.notificationDeliveries.record({
      userId: user.id,
      template: 'T',
      messageKey: 'k',
      slot: 'other',
      delivered: true,
    });

    await t.db.delete(users).where(eq(users.id, user.id));

    expect(await deliveries(user.id)).toEqual([]);
    expect(await userRow(user.id)).toBeUndefined();
  });
});

describe('a blocked bot', () => {
  it('flags the user as blocked', async () => {
    const user = await createUser(t.db);
    failing.set(user.telegramId as number, FORBIDDEN);

    const result = await services.messages.sendMessage(user.telegramId as number, 'hi');

    expect(result).toBeInstanceOf(SendFailure);
    expect(sendErrorCode(result)).toBe(SendFailure.FORBIDDEN);
    expect((await userRow(user.id))?.botBlockedAt).toBeInstanceOf(Date);
  });

  it('a forbidden on the flood retry still flags the user', async () => {
    // Regression (PR #131 review): the retry ran outside the error handling, so Forbidden escaped.
    const user = await createUser(t.db);
    queued.push(RATE_LIMITED, FORBIDDEN);

    const result = await services.messages.sendMessage(user.telegramId as number, 'hi');

    expect(sendErrorCode(result)).toBe(SendFailure.FORBIDDEN);
    expect(queued).toEqual([]);
    expect((await userRow(user.id))?.botBlockedAt).toBeInstanceOf(Date);
  });

  it('keeps the first blocked timestamp', async () => {
    const first = new Date('2026-01-01T00:00:00Z');
    const user = await createUser(t.db, { botBlockedAt: first });
    failing.set(user.telegramId as number, FORBIDDEN);

    await services.messages.sendMessage(user.telegramId as number, 'hi');

    expect((await userRow(user.id))?.botBlockedAt).toEqual(first);
  });
});

describe('a slot', () => {
  it('sends one message per user, by priority', async () => {
    const list = [await createUser(t.db), await createUser(t.db), await createUser(t.db)];
    vi.spyOn(services.users, 'getUsersByLocalTime').mockResolvedValue(list);

    const results = await notifications().sendNotificationsByTime(
      [LowPriorityEveryone, HighPriorityEveryone],
      10,
      'morning',
    );

    expect(results).toEqual({ HighPriorityEveryone: 3, LowPriorityEveryone: 0 });
    expect(sentChats().sort()).toEqual(list.map((u) => u.telegramId).sort());
    for (const user of list) {
      const [row, ...rest] = await deliveries(user.id);
      expect(rest).toEqual([]);
      expect([row?.template, row?.slot]).toEqual(['HighPriorityEveryone', 'morning']);
    }
  });

  it('a send that fails is logged and the slot goes on', async () => {
    // A crash or a repeated flood limit for one user must not stop the others (or lose their log rows).
    const crashes = await createUser(t.db);
    const rateLimited = await createUser(t.db);
    const fine = await createUser(t.db);
    failing.set(crashes.telegramId as number, 'crash');
    failing.set(rateLimited.telegramId as number, RATE_LIMITED);

    const [sent] = await notifications().sendNotification(new HighPriorityEveryone().initialize(services), [
      crashes,
      rateLimited,
      fine,
    ]);

    expect(sent).toBe(1);
    expect(sentChats()).toEqual([fine.telegramId]);
    for (const [user, delivered] of [
      [crashes, false],
      [rateLimited, false],
      [fine, true],
    ] as const) {
      const [row] = await deliveries(user.id);
      expect(row?.delivered).toBe(delivered);
    }
  });

  it('a template error for one user does not end the slot', async () => {
    class BrokenKeyForOne extends NotificationTemplate {
      constructor(private readonly broken: string) {
        super();
      }
      async getMessageKey() {
        return 'core.test.ok';
      }
      override async getMessageKeyForUser(user: UserSchema) {
        if (user.username === this.broken) throw new Error('no copy for this user');
        return 'core.test.ok';
      }
    }
    const broken = await createUser(t.db);
    const fine = await createUser(t.db);

    const [sent] = await notifications().sendNotification(
      new BrokenKeyForOne(broken.username as string).initialize(services),
      [broken, fine],
    );

    expect(sent).toBe(1);
    expect(sentChats()).toEqual([fine.telegramId]);
    const [row] = await deliveries(broken.id);
    expect([row?.delivered, row?.errorCode]).toEqual([false, 'other']);
  });

  it('preSendActions can narrow who gets the message', async () => {
    // Users it leaves out get no message and no delivery row; an empty list sends none.
    const kept = await createUser(t.db);
    const dropped = await createUser(t.db);

    const [sent] = await notifications().sendNotification(
      new SendsOnlyToSome(new Set([kept.id])).initialize(services),
      [kept, dropped],
    );
    expect(sent).toBe(1);
    expect(sentChats()).toEqual([kept.telegramId]);
    expect(await deliveries(dropped.id)).toEqual([]);

    const [none] = await notifications().sendNotification(new SendsOnlyToSome(new Set()).initialize(services), [kept]);
    expect(none).toBe(0);
    expect(sentChats()).toHaveLength(1);
  });

  it('captures the batch event, named after the template', async () => {
    const user = await createUser(t.db);

    await notifications().sendNotification(new HighPriorityEveryone().initialize(services), [user]);

    expect(t.fakes.posthog.events).toEqual([
      {
        distinctId: 'system',
        event: 'high_priority_everyone_notification_sent',
        properties: expect.objectContaining({ success_count: 1, total_count: 1 }),
      },
    ]);
  });

  it('plans without sending, one template per user', async () => {
    const [a, b] = [await createUser(t.db), await createUser(t.db)];
    const built = notifications().buildNotifications([LowPriorityEveryone, HighPriorityEveryone]);
    expect(built.map((n) => n.constructor.name)).toEqual(['HighPriorityEveryone', 'LowPriorityEveryone']);

    const planned = await notifications().planSlot(built, [a, b]);

    expect(planned.map(([n, list]) => [n.constructor.name, list.length])).toEqual([
      ['HighPriorityEveryone', 2],
      ['LowPriorityEveryone', 0],
    ]);
    expect(t.fakes.bot.calls).toEqual([]);
  });
});

describe('a template with its own kind of message', () => {
  class SendsAPoll extends NotificationTemplate {
    async getMessageKey() {
      return 'core.test.poll';
    }
    override sendToUser(messages: MessagesService, user: UserSchema) {
      return messages.sendPoll(user.telegramId as number, 'Q?', ['A', 'B'], {
        pollType: 'quiz',
        correctOptionId: 1,
        explanation: 'Because.',
      });
    }
  }

  class SendsAPhoto extends NotificationTemplate {
    async getMessageKey() {
      return 'core.test.photo';
    }
    override sendToUser(messages: MessagesService, user: UserSchema) {
      return messages.sendPhotoBytes(user.telegramId as number, new Uint8Array([0xff, 0xd8, 0x6a]), {
        filename: 'image.jpg',
        caption: 'A <caption>',
      });
    }
  }

  it('can send a poll', async () => {
    const user = await createUser(t.db);

    const sent = await notifications().deliver(new SendsAPoll().initialize(services), [user], 'other');

    expect(sent).toBe(1);
    expect(t.fakes.bot.sent('sendMessage')).toEqual([]);
    const [poll, ...rest] = t.fakes.bot.sent('sendPoll');
    expect(rest).toEqual([]);
    expect(poll?.payload.chat_id).toBe(user.telegramId);
    expect([poll?.payload.question, poll?.payload.type]).toEqual(['Q?', 'quiz']);
    // grammY sends the options as `InputPollOption` objects, which Telegram takes the same way
    expect(poll?.payload.options).toEqual([{ text: 'A' }, { text: 'B' }]);
    expect(poll?.payload.correct_option_ids).toEqual([1]);
    expect(poll?.payload.explanation).toBe('Because.');
    expect(poll?.payload.question_parse_mode).toBeUndefined();
    expect(poll?.payload.explanation_parse_mode).toBeUndefined();
    const [row] = await deliveries(user.id);
    expect([row?.delivered, row?.template, row?.messageKey, row?.slot]).toEqual([
      true,
      'SendsAPoll',
      'core.test.poll',
      'other',
    ]);
  });

  it('a forbidden poll flags the user', async () => {
    const user = await createUser(t.db);
    failing.set(user.telegramId as number, FORBIDDEN);

    const sent = await notifications().deliver(new SendsAPoll().initialize(services), [user], 'other');

    expect(sent).toBe(0);
    const [row] = await deliveries(user.id);
    expect([row?.delivered, row?.errorCode]).toEqual([false, 'forbidden']);
    expect((await userRow(user.id))?.botBlockedAt).toBeInstanceOf(Date);
  });

  it('can send a photo from bytes', async () => {
    const user = await createUser(t.db);

    const sent = await notifications().deliver(new SendsAPhoto().initialize(services), [user], 'other');

    expect(sent).toBe(1);
    const [photo] = t.fakes.bot.sent('sendPhoto');
    expect(photo?.payload.chat_id).toBe(user.telegramId);
    const file = photo?.payload.photo as { filename?: string; toRaw(): Uint8Array };
    expect(file.filename).toBe('image.jpg');
    expect([...(await file.toRaw())]).toEqual([0xff, 0xd8, 0x6a]);
    expect(photo?.payload.caption).toBe('A <caption>');
    expect(photo?.payload.parse_mode).toBeUndefined(); // plain text, not the bot's default
    const [row] = await deliveries(user.id);
    expect([row?.delivered, row?.messageKey]).toEqual([true, 'core.test.photo']);
  });

  it('a forbidden photo flags the user', async () => {
    const user = await createUser(t.db);
    failing.set(user.telegramId as number, FORBIDDEN);

    const sent = await notifications().deliver(new SendsAPhoto().initialize(services), [user], 'other');

    expect(sent).toBe(0);
    const [row] = await deliveries(user.id);
    expect([row?.delivered, row?.errorCode]).toEqual([false, 'forbidden']);
    expect((await userRow(user.id))?.botBlockedAt).toBeInstanceOf(Date);
  });
});

describe('userLanguage', () => {
  // An unknown locale made `t()` return the bare key: users on uk/es/de got "myapp.notifications...".
  it.each([
    ['ru', null, 'ru'],
    [null, 'ru-RU', 'ru'],
    [null, 'en', 'en'],
    [null, 'uk', 'en'],
    ['de', 'ru', 'en'], // the explicit app language wins, and we have no German
    [null, null, 'en'],
  ])('(%s, %s) is %s', (languageCode, tgLanguageCode, expected) => {
    expect(userLanguage({ languageCode, tgLanguageCode })).toBe(expected);
  });
});

describe('scheduled promo templates', () => {
  const REQUESTER = 4242;
  const broadcast = (fields: Partial<typeof promotionalBroadcasts.$inferInsert> = {}) =>
    t.db
      .insert(promotionalBroadcasts)
      .values({
        messageType: 'text',
        messageText: 'Saved',
        messageHtml: 'Saved',
        hasTextFormatting: false,
        timeSlot: 'MORNING',
        deadline: new Date(Date.now() + 86_400_000),
        priority: 80,
        createdByUserId: REQUESTER,
        keyboardType: 'none',
        ...fields,
      })
      .returning()
      .then((rows) => rows[0] as typeof promotionalBroadcasts.$inferSelect);
  const reload = async (id: number) =>
    (await t.db.select().from(promotionalBroadcasts).where(eq(promotionalBroadcasts.id, id)))[0];
  const send = async (template: PromotionalBroadcastNotification, list: UserSchema[]) => {
    const [sent] = await notifications().sendNotification(template.initialize(services), list, 'morning');
    return sent;
  };

  it('sends the slot top row and counts the cycle', async () => {
    const list = [await createUser(t.db), await createUser(t.db)];
    await broadcast({ messageText: 'low', messageHtml: 'low', priority: 10 });
    const top = await broadcast({ messageText: 'top', messageHtml: 'top', priority: 500 });
    await broadcast({ messageText: 'evening', messageHtml: 'evening', priority: 999, timeSlot: 'EVENING' });

    const sent = await send(new MorningPromotionalBroadcast(), list);

    expect(sent).toBe(2);
    expect(new Set(t.fakes.bot.sent('sendMessage').map((c) => c.payload.text))).toEqual(new Set(['top']));
    const row = await reload(top.id);
    expect([row?.successCount, row?.cyclesRun]).toEqual([2, 1]);
    const rows = await t.db.select().from(notificationDeliveries);
    expect(new Set(rows.map((r) => `${r.template}|${r.messageKey}`))).toEqual(
      new Set([`PromotionalBroadcastNotification|promotional_broadcast.${top.id}`]),
    );
    expect(t.fakes.posthog.events[0]?.event).toBe('promotional_broadcast_sent');
    expect(t.fakes.posthog.events[0]?.properties).toMatchObject({ broadcast_id: top.id, message_type: 'text' });
  });

  it('filterAudience is the app override point', async () => {
    const [keep, drop] = [await createUser(t.db), await createUser(t.db)] as [UserSchema, UserSchema];
    await broadcast({ timeSlot: 'EVENING' });

    class OnlyKeep extends EveningPromotionalBroadcast {
      override async filterAudience(list: UserSchema[]) {
        return list.filter((u) => u.id === keep.id);
      }
    }
    await send(new OnlyKeep(), [keep, drop]);

    expect(sentChats()).toEqual([keep.telegramId]);
  });

  it('the keyboard comes from the registry', async () => {
    registerBroadcastKeyboard('daily', (_text, locale) => ({
      inline_keyboard: new InlineKeyboard().url(`daily-${locale}`, 'https://t.me/test_bot/app').inline_keyboard,
    }));
    const list = [await createUser(t.db, { languageCode: 'ru' })];
    await broadcast({ keyboardType: 'daily' });

    await send(new MorningPromotionalBroadcast(), list);

    const [message] = t.fakes.bot.sent('sendMessage');
    const markup = message?.payload.reply_markup as InlineKeyboardMarkup;
    expect(markup.inline_keyboard[0]?.[0]?.text).toBe('daily-ru');
  });

  it('an inactive row sends nothing', async () => {
    const list = [await createUser(t.db)];
    await broadcast({ isActive: false });

    expect(await send(new MorningPromotionalBroadcast(), list)).toBe(0);
    expect(t.fakes.bot.sent('sendMessage')).toEqual([]);
  });

  it('the immediate template is not a promo template', () => {
    // Its counters are recorded by the job per chunk; the promo template would record them again.
    const immediate = new ImmediateBroadcastNotification({ type: 'text', text: 'x', parse_mode: null }, null, 'k');
    expect(immediate).not.toBeInstanceOf(PromotionalBroadcastNotification);
    expect(immediate.getPosthogEvent()).toBeNull();
  });

  it('the immediate template skips whoever the run already reached', async () => {
    const [done, fresh] = [await createUser(t.db), await createUser(t.db)] as [UserSchema, UserSchema];
    const immediate = new ImmediateBroadcastNotification({ type: 'text', text: 'x', parse_mode: null }, null, 'run-1');
    await services.repos.notificationDeliveries.record({
      userId: done.id,
      template: immediate.templateName,
      messageKey: 'run-1',
      slot: 'other',
      delivered: true,
    });

    const [sent, eligible] = await notifications().sendNotification(immediate.initialize(services), [done, fresh]);

    expect(sent).toBe(1);
    expect(eligible.map((u) => u.id)).toEqual([fresh.id]);
    expect(sentChats()).toEqual([fresh.telegramId]);
  });
});
