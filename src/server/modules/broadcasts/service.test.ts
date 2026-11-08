/** `BroadcastsService` on the real aggregator: each test runs on one transaction that is rolled back. */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { adminAuditLogs, NotificationTimeSlot, type User, UserRole } from '../../db/schema';
import { BroadcastNotFoundException, InvalidBroadcastException } from '../../lib/errors';
import { createTestApp, createUser, type TestApp } from '../../testing';
import type { TestServices } from '../../testing/auth';
import { setBroadcastAppUrl } from './formatting';
import type { BroadcastCreateRequest, BroadcastSendNowRequest, BroadcastUpdateRequest } from './schemas';
import { UPLOAD_LIMITS } from './service';
import { mintFileIds, withServices } from './test-helpers';

let t: TestApp<TestServices>;
let owner: User;

beforeAll(async () => {
  setBroadcastAppUrl(() => 'https://t.me/test_bot/app');
  t = await createTestApp();
  mintFileIds(t.fakes.bot);
  owner = await createUser(t.db, { role: UserRole.OWNER });
});
afterAll(() => t.close());
beforeEach(() => {
  t.fakes.bot.clear();
  t.fakes.queue.jobs.length = 0;
});

const createBody = (
  timeSlot: BroadcastCreateRequest['timeSlot'] = 'morning',
  overrides: Partial<BroadcastCreateRequest> = {},
) =>
  ({
    messageType: 'text',
    timeSlot,
    deadline: new Date(Date.now() + 3 * 86400_000),
    priority: 80,
    messageText: 'Hello',
    hasTextFormatting: false,
    hasCaptionFormatting: false,
    keyboardType: 'none',
    ...overrides,
  }) satisfies BroadcastCreateRequest;

const sendNowBody = (overrides: Partial<BroadcastSendNowRequest> = {}): BroadcastSendNowRequest => ({
  hasTextFormatting: false,
  hasCaptionFormatting: false,
  keyboardType: 'none',
  ...overrides,
});

const update = (fields: BroadcastUpdateRequest) => fields;

/** Audit rows are in the same (uncommitted) transaction as the service call, so read them through its repo. */
const auditRows = (services: { repos: { db: { select: () => unknown } } }, action: string) =>
  (services.repos.db as typeof t.db)
    .select()
    .from(adminAuditLogs)
    .where(and(eq(adminAuditLogs.action, action), eq(adminAuditLogs.targetType, 'broadcast')));

describe('create', () => {
  it('both creates two independent rows and one audit row', async () => {
    await withServices(t, async (services) => {
      const { ids } = await services.broadcasts.create(owner, createBody('both'));

      expect(ids).toHaveLength(2);
      const rows = await services.repos.promotionalBroadcasts.getByIds(ids);
      expect(rows.map((r) => String(r.timeSlot)).sort()).toEqual(
        [NotificationTimeSlot.EVENING, NotificationTimeSlot.MORNING].sort(),
      );
      expect(rows.every((r) => r.createdByUserId === owner.telegramId)).toBe(true);
      const [audit, ...rest] = await auditRows(services, 'broadcast_create');
      expect(rest).toEqual([]);
      expect(audit?.targetId).toBe(ids.join(','));
      expect(audit?.detail).toMatchObject({ rows_created: 2, ids });
    });
  });

  it('an actor without a telegram id is invalid, not a 500', async () => {
    // createdByUserId is NOT NULL: a web-only admin used to hit an IntegrityError.
    await withServices(t, async (services) => {
      const actor = { ...owner, telegramId: null };
      await expect(services.broadcasts.create(actor, createBody())).rejects.toThrow(
        new InvalidBroadcastException('Acting admin has no Telegram id'),
      );
    });
  });

  it('an actor with a telegram id beyond int4 is stored', async () => {
    // Newer Telegram ids exceed 2**31; createdByUserId is BIGINT.
    await withServices(t, async (services) => {
      const actor = { ...owner, telegramId: 7_934_526_008 };
      const { ids } = await services.broadcasts.create(actor, createBody());
      const rows = await services.repos.promotionalBroadcasts.getByCreator(7_934_526_008);
      expect(rows.map((r) => r.id).sort()).toEqual([...ids].sort());
    });
  });

  it('text without text is invalid', async () => {
    await withServices(t, async (services) => {
      await expect(services.broadcasts.create(owner, createBody('morning', { messageText: '' }))).rejects.toThrow(
        'Text broadcast requires message_text',
      );
    });
  });
});

describe('cancel and edit', () => {
  it('cancel sets inactive and audits', async () => {
    await withServices(t, async (services) => {
      const {
        ids: [id],
      } = await services.broadcasts.create(owner, createBody());

      const detail = await services.broadcasts.cancel(owner, id as number);

      expect(detail.isActive).toBe(false);
      expect(detail.completedAt).not.toBeNull();
      const audits = await auditRows(services, 'broadcast_cancel');
      expect(audits.map((a) => a.targetId)).toEqual([String(id)]);
    });
  });

  it('cancel of an inactive row is a no-op', async () => {
    await withServices(t, async (services) => {
      const id = (await services.broadcasts.create(owner, createBody())).ids[0] as number;
      const first = await services.broadcasts.cancel(owner, id);

      const again = await services.broadcasts.cancel(owner, id);

      expect(again.completedAt).toEqual(first.completedAt);
      expect(await auditRows(services, 'broadcast_cancel')).toHaveLength(1);
    });
  });

  it('cancel of an expired row is a no-op', async () => {
    await withServices(t, async (services) => {
      const body = createBody('morning', { deadline: new Date(Date.now() - 60_000) });
      const id = (await services.broadcasts.create(owner, body)).ids[0] as number;

      const detail = await services.broadcasts.cancel(owner, id);

      expect([detail.isActive, detail.completedAt]).toEqual([false, null]);
      expect(await auditRows(services, 'broadcast_cancel')).toEqual([]);
    });
  });

  it.each(['messageType', 'deadline', 'priority'] as const)('edit rejects null for NOT NULL %s', async (field) => {
    await withServices(t, async (services) => {
      const id = (await services.broadcasts.create(owner, createBody())).ids[0] as number;
      const snake = field === 'messageType' ? 'message_type' : field;

      await expect(services.broadcasts.edit(owner, id, update({ [field]: null }))).rejects.toThrow(snake);
    });
  });

  it('edit text without the flag keeps the formatting', async () => {
    await withServices(t, async (services) => {
      const body = createBody('morning', { messageText: '<b>Hi</b>', hasTextFormatting: true });
      const id = (await services.broadcasts.create(owner, body)).ids[0] as number;

      const detail = await services.broadcasts.edit(owner, id, update({ messageText: '<i>Hey</i>' }));

      expect([detail.messageHtml, detail.hasTextFormatting]).toEqual(['<i>Hey</i>', true]);
    });
  });

  it('edit caption without the flag keeps the formatting', async () => {
    await withServices(t, async (services) => {
      const body = createBody('morning', {
        messageType: 'photo',
        messageText: null,
        mediaFileId: 'f1',
        caption: '<b>c</b>',
        hasCaptionFormatting: true,
      });
      const id = (await services.broadcasts.create(owner, body)).ids[0] as number;

      const detail = await services.broadcasts.edit(owner, id, update({ caption: '<i>d</i>' }));

      expect([detail.captionHtml, detail.hasCaptionFormatting]).toEqual(['<i>d</i>', true]);
    });
  });

  it('edit only the flag', async () => {
    await withServices(t, async (services) => {
      const body = createBody('morning', { messageText: '<b>Hi</b>', hasTextFormatting: true });
      const id = (await services.broadcasts.create(owner, body)).ids[0] as number;

      const detail = await services.broadcasts.edit(owner, id, update({ hasTextFormatting: false }));

      expect([detail.messageText, detail.hasTextFormatting]).toEqual(['<b>Hi</b>', false]);
    });
  });

  it('edit updates and audits', async () => {
    await withServices(t, async (services) => {
      const id = (await services.broadcasts.create(owner, createBody())).ids[0] as number;

      const detail = await services.broadcasts.edit(owner, id, update({ priority: 300, messageText: 'Updated' }));

      expect([detail.priority, detail.messageText]).toEqual([300, 'Updated']);
      const [audit] = await auditRows(services, 'broadcast_edit');
      expect(audit?.detail).toEqual({
        changed_fields: ['has_text_formatting', 'message_html', 'message_text', 'priority'],
      });
    });
  });

  it('edit validates the merged row', async () => {
    await withServices(t, async (services) => {
      const id = (await services.broadcasts.create(owner, createBody())).ids[0] as number;

      await expect(services.broadcasts.edit(owner, id, update({ messageType: 'photo' }))).rejects.toThrow(
        'photo broadcast requires media_file_id',
      );
      await expect(services.broadcasts.edit(owner, id, update({ messageText: '' }))).rejects.toThrow(
        'Text broadcast requires message_text',
      );

      const detail = await services.broadcasts.edit(owner, id, update({ messageType: 'photo', mediaFileId: 'file-1' }));
      expect([detail.messageType, detail.mediaFileId]).toEqual(['photo', 'file-1']);
    });
  });

  it('an expired row is inactive in the list and the detail', async () => {
    await withServices(t, async (services) => {
      const body = createBody('morning', { deadline: new Date(Date.now() - 60_000) });
      const id = (await services.broadcasts.create(owner, body)).ids[0] as number;

      const listing = await services.broadcasts.listBroadcasts();
      const detail = await services.broadcasts.getBroadcast(id);

      expect(listing.completed.map((b) => b.id)).toContain(id);
      expect(listing.completed.filter((b) => b.id === id).map((b) => b.isActive)).toEqual([false]);
      expect(detail?.isActive).toBe(false);
    });
  });

  it.each(['cancel', 'edit', 'getStats'] as const)('a missing row throws not found: %s', async (method) => {
    await withServices(t, async (services) => {
      const calls = {
        cancel: () => services.broadcasts.cancel(owner, 99999999),
        edit: () => services.broadcasts.edit(owner, 99999999, update({ priority: 1 })),
        getStats: () => services.broadcasts.getStats(99999999),
      };
      await expect(calls[method]()).rejects.toThrow(BroadcastNotFoundException);
      await expect(calls[method]()).rejects.toThrow('Broadcast not found');
    });
  });

  it('getBroadcast of a missing row is null', async () => {
    await withServices(t, async (services) => {
      expect(await services.broadcasts.getBroadcast(99999999)).toBeNull();
    });
  });
});

describe('sendNow', () => {
  it('enqueues the job and audits', async () => {
    await withServices(t, async (services) => {
      const id = (await services.broadcasts.create(owner, createBody())).ids[0] as number;

      expect(await services.broadcasts.sendNow(owner, sendNowBody({ broadcastId: id }))).toBe(true);

      expect(t.fakes.queue.jobs).toHaveLength(1);
      const job = t.fakes.queue.jobs[0];
      expect(job?.jobName).toBe('user_broadcast_job');
      const payload = job?.payload as {
        broadcastData: Record<string, unknown>;
        requesterTelegramId: number;
        broadcastId: number;
      };
      expect(payload.requesterTelegramId).toBe(owner.telegramId);
      expect(payload.broadcastId).toBe(id);
      const data = payload.broadcastData;
      expect([data.message_type, data.message_text, data.has_text_formatting]).toEqual(['text', 'Hello', false]);
      expect(String(data.run_id)).toHaveLength(32); // one id per run: the job skips users the run already reached
      const [audit] = await auditRows(services, 'broadcast_send_now');
      expect(audit?.targetId).toBe(String(id));
      expect(audit?.detail).toMatchObject({ from_broadcast_id: id, run_id: data.run_id });
    });
  });

  it('the audit row is written before the job is queued', async () => {
    // Once queued the blast can't be taken back: nothing that can fail may come after the enqueue.
    await withServices(t, async (services) => {
      const seen: number[] = [];
      const original = t.fakes.queue.enqueueJob.bind(t.fakes.queue);
      t.fakes.queue.enqueueJob = async (...args) => {
        seen.push((await auditRows(services, 'broadcast_send_now')).length);
        return original(...args);
      };
      try {
        await services.broadcasts.sendNow(owner, sendNowBody({ messageType: 'text', messageText: 'x' }));
      } finally {
        t.fakes.queue.enqueueJob = original;
      }
      expect(seen).toEqual([1]);
    });
  });

  it('inline media keeps its type', async () => {
    // Regression: every media type went out as `photo_file_id` and the job dropped all but photos.
    await withServices(t, async (services) => {
      const body = sendNowBody({ messageType: 'video', mediaFileId: 'vid-1', caption: 'c', keyboardType: 'main' });

      await services.broadcasts.sendNow(owner, body);

      const payload = t.fakes.queue.jobs[0]?.payload as {
        broadcastData: Record<string, unknown>;
        broadcastId: number | null;
      };
      expect(payload.broadcastId).toBeNull();
      const data = payload.broadcastData;
      expect([data.message_type, data.media_file_id, data.keyboard_type]).toEqual(['video', 'vid-1', 'main']);
    });
  });

  it('each send is a new run', async () => {
    await withServices(t, async (services) => {
      const body = sendNowBody({ messageType: 'text', messageText: 'x' });

      await services.broadcasts.sendNow(owner, body);
      await services.broadcasts.sendNow(owner, body);

      const runIds = t.fakes.queue.jobs.map(
        (j) => (j.payload as { broadcastData: { run_id: string } }).broadcastData.run_id,
      );
      expect(new Set(runIds).size).toBe(2);
    });
  });

  it.each<[Partial<BroadcastSendNowRequest>, string]>([
    [{ messageType: 'text' }, 'Text send-now requires message_text'],
    [{ messageType: 'photo' }, 'Media send-now requires media_file_id'],
  ])('inline content %j is validated before queueing', async (overrides, message) => {
    await withServices(t, async (services) => {
      await expect(services.broadcasts.sendNow(owner, sendNowBody(overrides))).rejects.toThrow(message);
      expect(t.fakes.queue.jobs).toEqual([]);
    });
  });

  it('an unknown row throws not found and queues nothing', async () => {
    await withServices(t, async (services) => {
      await expect(services.broadcasts.sendNow(owner, sendNowBody({ broadcastId: 99999999 }))).rejects.toThrow(
        BroadcastNotFoundException,
      );
      expect(t.fakes.queue.jobs).toEqual([]);
    });
  });

  it('without content is invalid', async () => {
    await withServices(t, async (services) => {
      await expect(services.broadcasts.sendNow(owner, sendNowBody())).rejects.toThrow(
        'send-now requires broadcast_id or message_type',
      );
      expect(t.fakes.queue.jobs).toEqual([]);
    });
  });
});

describe('preview', () => {
  const previewBody = (overrides: Record<string, unknown> = {}) => ({
    messageType: 'text' as const,
    hasTextFormatting: false,
    hasCaptionFormatting: false,
    keyboardType: 'none' as const,
    ...overrides,
  });

  it('a failed send is false, not an error', async () => {
    // A failed send is a `SendFailure`; the preview must turn it into `sent: false`.
    await withServices(t, async (services) => {
      t.fakes.bot.failNext('sendMessage', { error_code: 400, description: "Bad Request: can't parse entities" });

      const sent = await services.broadcasts.preview(
        owner,
        previewBody({ messageText: '<b>broken', keyboardType: 'none' }),
      );

      expect(sent).toBe(false);
    });
  });

  it('an actor without a telegram chat is invalid', async () => {
    await withServices(t, async (services) => {
      await expect(
        services.broadcasts.preview({ ...owner, telegramId: null }, previewBody({ messageText: 'x' })),
      ).rejects.toThrow('no Telegram chat');
    });
  });

  it('media preview goes through sendContent with the keyboard', async () => {
    await withServices(t, async (services) => {
      const body = previewBody({
        messageType: 'animation',
        mediaFileId: 'gif-1',
        caption: 'c',
        keyboardType: 'main',
        keyboardButtonText: 'Go',
      });

      expect(await services.broadcasts.preview(owner, body)).toBe(true);

      const [call] = t.fakes.bot.sent('sendAnimation');
      expect(t.fakes.bot.sent('sendAnimation')).toHaveLength(1);
      expect(call?.payload).toMatchObject({ animation: 'gif-1', caption: 'c' });
      const markup = call?.payload.reply_markup as { inline_keyboard: { text: string }[][] };
      expect(markup.inline_keyboard[0]?.[0]?.text).toBe('Go');
    });
  });
});

describe('uploadMedia', () => {
  it('mints a file id and deletes the upload message', async () => {
    await withServices(t, async (services) => {
      const result = await services.broadcasts.uploadMedia(owner, {
        messageType: 'video',
        filename: 'clip.mp4',
        content: new Uint8Array([0, 1]),
      });

      expect(result.fileId).toBe('file_video_123');
      expect(t.fakes.bot.sent('deleteMessage')).toHaveLength(1);
    });
  });

  it('a file over the Telegram limit is invalid and not sent', async () => {
    await withServices(t, async (services) => {
      const original = UPLOAD_LIMITS.video as number;
      UPLOAD_LIMITS.video = 3;
      try {
        await expect(
          services.broadcasts.uploadMedia(owner, {
            messageType: 'video',
            filename: 'v.mp4',
            content: new Uint8Array(4),
          }),
        ).rejects.toThrow('File too large');
      } finally {
        UPLOAD_LIMITS.video = original;
      }
      expect(t.fakes.bot.sent('sendVideo')).toHaveLength(0);
    });
  });

  it('upload limits follow the Bot API', () => {
    expect(UPLOAD_LIMITS.photo).toBe(10 * 1024 * 1024);
    expect(new Set(['video', 'animation', 'document'].map((kind) => UPLOAD_LIMITS[kind]))).toEqual(
      new Set([50 * 1024 * 1024]),
    );
  });

  it('a Telegram failure is invalid', async () => {
    await withServices(t, async (services) => {
      t.fakes.bot.failNext('sendPhoto', { error_code: 500, description: 'telegram down' });
      await expect(
        services.broadcasts.uploadMedia(owner, {
          messageType: 'photo',
          filename: 'p.jpg',
          content: new Uint8Array([1]),
        }),
      ).rejects.toThrow('Failed to upload media via Telegram');
    });
  });
});
