/**
 * Port of the template app's `tests/contracts/worker/*` (admin broadcast, daily statistics, delayed notification, user
 * broadcast): the jobs against a real database and the fake bot.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { settings } from '../config';
import { notificationDeliveries } from '../db/schema';
import { engineConfig } from '../modules/notifications/service';
import { createTestApp, createUser, type TestApp } from '../testing';
import type { TestServices } from '../testing/auth';
import { WorkerContext } from './context';
import {
  adminBroadcastJob,
  dailyAdminStatisticsJob,
  sendDelayedNotification,
  testErrorJob,
  userBroadcastJobHandler,
} from './jobs';

let app: TestApp<TestServices>;
let ctx: WorkerContext;
const owners = settings.rbac.ownerIds;
let sendInterval: number;

const sentTo = () => app.fakes.bot.sent('sendMessage').map((call) => call.payload.chat_id);

beforeEach(async () => {
  app = await createTestApp();
  const { bot, redis, queue, producer } = app.fakes;
  ctx = new WorkerContext({ db: app.db, bot: bot.bot, redis, queue, producer });
  sendInterval = engineConfig.sendIntervalMs;
  engineConfig.sendIntervalMs = 0;
});

afterEach(async () => {
  settings.rbac.ownerIds = owners;
  engineConfig.sendIntervalMs = sendInterval;
  await app.close();
});

describe('admin_broadcast_job', () => {
  it('sends the message to all admins', async () => {
    settings.rbac.ownerIds = [111, 222, 333];
    const result = await adminBroadcastJob(ctx, { text: 'Test broadcast' });

    expect(result).toEqual({ sent: 3 });
    const calls = app.fakes.bot.sent('sendMessage');
    expect(calls).toHaveLength(3);
    expect(calls.every((call) => call.payload.text === 'Test broadcast')).toBe(true);
    expect(new Set(sentTo())).toEqual(new Set([111, 222, 333]));
  });

  it('handles an empty admin list', async () => {
    settings.rbac.ownerIds = [];
    expect(await adminBroadcastJob(ctx, { text: 'Test' })).toEqual({ sent: 0 });
    expect(app.fakes.bot.calls).toEqual([]);
  });

  it('continues when one admin fails', async () => {
    settings.rbac.ownerIds = [111, 222, 333];
    app.fakes.bot.bot.api.config.use((prev, method, payload, signal) => {
      if (method === 'sendMessage' && (payload as { chat_id: number }).chat_id === 222) {
        return Promise.resolve({ ok: false, error_code: 500, description: 'Send failed' }) as never;
      }
      return prev(method, payload, signal);
    });

    expect(await adminBroadcastJob(ctx, { text: 'Test' })).toEqual({ sent: 2 });
  });

  it('accepts the camelCase payload the TS producers send', async () => {
    settings.rbac.ownerIds = [111];
    await adminBroadcastJob(ctx, { text: 'T', richHtml: '<b>x</b>', silent: true });
    const [rich] = app.fakes.bot.sent('sendRichMessage');
    expect(rich?.payload.disable_notification).toBe(true);
  });

  it('refuses a payload without text, as Python raised TypeError', async () => {
    await expect(adminBroadcastJob(ctx, {})).rejects.toThrow(TypeError);
  });
});

describe('daily_admin_statistics_job', () => {
  it('sends one silent rich digest per owner', async () => {
    settings.rbac.ownerIds = [111, 222];
    const result = await dailyAdminStatisticsJob(ctx, {});

    expect(result).toEqual({ sent: 2 });
    const rich = app.fakes.bot.sent('sendRichMessage');
    expect(rich.map((call) => call.payload.chat_id)).toEqual([111, 222]);
    expect(app.fakes.bot.sent('sendMessage')).toEqual([]); // rich accepted: no fallback
    expect(rich[0]?.payload.disable_notification).toBe(true);
    const html = (rich[0]?.payload.html ?? (rich[0]?.payload.rich_message as { html: string })?.html) as string;
    expect(html).toContain('<table');
    expect(html).toContain('<td>Revenue</td>');
    expect(html).toContain('<footer>#digest');
  });

  it('handles an empty admin list', async () => {
    settings.rbac.ownerIds = [];
    expect(await dailyAdminStatisticsJob(ctx, {})).toEqual({ sent: 0 });
    expect(app.fakes.bot.sent('sendRichMessage')).toEqual([]);
  });
});

describe('send_delayed_notification', () => {
  it('sends the notification to the telegram user', async () => {
    await createUser(app.db, { telegramId: 12345 });
    await sendDelayedNotification(ctx, { telegram_user_id: 12345, delay_seconds: 5 });

    const calls = app.fakes.bot.sent('sendMessage');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.payload.chat_id).toBe(12345);
  });

  it('includes the delay in an HTML message', async () => {
    await createUser(app.db, { telegramId: 23456 });
    await sendDelayedNotification(ctx, { telegram_user_id: 23456, delay_seconds: 10 });

    const [call] = app.fakes.bot.sent('sendMessage');
    expect(call?.payload.parse_mode).toBe('HTML');
    expect(String(call?.payload.text)).toContain('10');
  });

  it('still sends when the user is not in the database', async () => {
    await sendDelayedNotification(ctx, { telegram_user_id: 99999, delay_seconds: 5 });
    expect(app.fakes.bot.sent('sendMessage')).toHaveLength(1);
  });
});

describe('test_error_job', () => {
  it('raises', async () => {
    await expect(testErrorJob(ctx, {})).rejects.toThrow('Test error');
  });
});

describe('user_broadcast_job', () => {
  const createRecipients = async (...telegramIds: number[]) => {
    for (const telegramId of telegramIds) await createUser(app.db, { telegramId });
  };

  it('sends text to all users, then the completion to the requester', async () => {
    await createRecipients(111, 222);
    const result = await userBroadcastJobHandler(ctx, {
      broadcast_data: { message_type: 'text', message_text: 'Hello everyone!', has_formatting: false },
      requester_telegram_id: 999,
    });

    expect(result).toMatchObject({ sent: 2, total: 2, success_rate: 100.0 });
    expect(app.fakes.bot.sent('sendMessage')).toHaveLength(3); // 2 users + 1 completion notification
  });

  it('sends a photo with its caption to all users', async () => {
    await createRecipients(333);
    const result = (await userBroadcastJobHandler(ctx, {
      broadcast_data: {
        message_type: 'photo',
        photo_file_id: 'AgACAgIAAxkBAAI...',
        caption: 'Check this out!',
        has_caption_formatting: false,
      },
      requester_telegram_id: 999,
    })) as { sent: number };

    expect(result.sent).toBe(1);
    const photos = app.fakes.bot.sent('sendPhoto');
    expect(photos).toHaveLength(1);
    expect(photos[0]?.payload.photo).toBe('AgACAgIAAxkBAAI...');
    expect(photos[0]?.payload.caption).toBe('Check this out!');
  });

  it('returns the success rate as a number', async () => {
    await createRecipients(444);
    const result = (await userBroadcastJobHandler(ctx, {
      broadcast_data: { message_type: 'text', message_text: 'Test' },
      requester_telegram_id: 999,
    })) as { success_rate: unknown };
    expect(typeof result.success_rate).toBe('number');
  });

  it('tells the requester when it is done', async () => {
    await createRecipients(555);
    await userBroadcastJobHandler(ctx, {
      broadcast_data: { message_type: 'text', message_text: 'Test' },
      requester_telegram_id: 999,
    });

    const completion = app.fakes.bot.sent('sendMessage').filter((call) => call.payload.chat_id === 999);
    expect(completion).toHaveLength(1);
    expect(String(completion[0]?.payload.text)).toContain('Broadcast complete');
  });

  it('sends HTML formatting as HTML', async () => {
    await createRecipients(666);
    await userBroadcastJobHandler(ctx, {
      broadcast_data: { message_type: 'text', message_html: '<b>Bold</b> message', has_formatting: true },
      requester_telegram_id: 999,
    });

    const message = app.fakes.bot.sent('sendMessage').find((call) => call.payload.chat_id === 666);
    expect(message?.payload.text).toBe('<b>Bold</b> message');
    expect(message?.payload.parse_mode).toBe('HTML');
  });

  it('handles no users', async () => {
    const result = await userBroadcastJobHandler(ctx, {
      broadcast_data: { message_type: 'text', message_text: 'Test' },
      requester_telegram_id: 999,
    });
    expect(result).toMatchObject({ sent: 0, total: 0 });
  });

  it('takes the camelCase payload of BroadcastsService, and keys its deliveries by the job id', async () => {
    await createRecipients(777);
    const withJobId = new WorkerContext(
      {
        db: app.db,
        bot: app.fakes.bot.bot,
        redis: app.fakes.redis,
        queue: app.fakes.queue,
        producer: app.fakes.producer,
      },
      'job-42',
    );
    const result = await userBroadcastJobHandler(withJobId, {
      broadcastData: { message_type: 'text', message_text: 'Hi' },
      requesterTelegramId: 999,
    });
    expect(result).toMatchObject({ sent: 1, total: 1 });
    const rows = await app.db.select().from(notificationDeliveries);
    expect(rows.some((row) => row.messageKey.endsWith('job-42'))).toBe(true);
  });

  it('requires broadcast_data', async () => {
    await expect(userBroadcastJobHandler(ctx, {})).rejects.toThrow(TypeError);
  });
});
