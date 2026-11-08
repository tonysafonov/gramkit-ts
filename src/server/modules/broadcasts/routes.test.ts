/**
 * Contract tests of the core admin broadcasts API (`/admin/broadcasts*`):
 *
 *   GET   /admin/broadcasts                     (A)
 *   POST  /admin/broadcasts                     (A)  ('both' -> 2 rows)
 *   POST  /admin/broadcasts/media               (A, multipart)
 *   POST  /admin/broadcasts/format              (A)
 *   POST  /admin/broadcasts/preview             (A)
 *   POST  /admin/broadcasts/send-now            (O)
 *   GET   /admin/broadcasts/{id}/stats          (A)
 *   GET   /admin/broadcasts/{id}                (A, after static; 404 if missing)
 *   PATCH /admin/broadcasts/{id}                (A)
 *   POST  /admin/broadcasts/{id}/cancel         (A)
 *
 * plus a route-shadowing guard (the static sub-paths reach their own handlers, not the dynamic
 * `/broadcasts/{id}`) and the audit rows of the mutating endpoints. The owner-gated endpoint (send-now) has an admin
 * -> 403 test, and every endpoint has a regular-user -> 403 test.
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { adminAuditLogs, type User, UserRole } from '../../db/schema';
import { asUser, createTestApp, createUser, type TestApp } from '../../testing';
import type { TestServices } from '../../testing/auth';
import { UPLOAD_LIMITS } from './service';
import { mintFileIds } from './test-helpers';

let t: TestApp<TestServices>;
let admin: Record<string, string>;
let owner: Record<string, string>;
let regular: Record<string, string>;
let adminUser: User;

beforeAll(async () => {
  t = await createTestApp();
  mintFileIds(t.fakes.bot);
  adminUser = await createUser(t.db, { role: UserRole.ADMIN });
  admin = asUser(adminUser);
  owner = asUser(await createUser(t.db, { role: UserRole.OWNER }));
  regular = asUser(await createUser(t.db));
});
afterAll(() => t.close());
beforeEach(() => {
  t.fakes.bot.clear();
  t.fakes.queue.jobs.length = 0;
});

const futureDeadline = () => new Date(Date.now() + 3 * 86400_000).toISOString();

const textCreateBody = (timeSlot = 'morning') => ({
  message_type: 'text',
  time_slot: timeSlot,
  deadline: futureDeadline(),
  priority: 80,
  message_text: 'Hello world',
  has_text_formatting: false,
  keyboard_type: 'none',
});

async function json(res: Response) {
  // biome-ignore lint/suspicious/noExplicitAny: the tests read arbitrary fields of the response
  return (await res.json()) as Record<string, any>;
}

async function createTextBroadcast(headers = admin, timeSlot = 'morning'): Promise<number> {
  const res = await t.client.post('/admin/broadcasts', textCreateBody(timeSlot), { headers });
  expect(res.status).toBe(200);
  return (await json(res)).ids[0];
}

/** Audit rows of `action` for one target (`null`: rows without a target). */
const auditRows = (action: string, targetId: string | null) =>
  t.db
    .select()
    .from(adminAuditLogs)
    .where(and(eq(adminAuditLogs.action, action)))
    .then((rows) => rows.filter((row) => row.targetId === targetId));

const upload = (messageType: string, content: Uint8Array, headers = admin, filename = 'pic.jpg') => {
  const form = new FormData();
  form.set('message_type', messageType);
  form.set('file', new File([Uint8Array.from(content)], filename, { type: 'image/jpeg' }));
  return t.client.request('/admin/broadcasts/media', { method: 'POST', body: form, headers });
};

describe('list', () => {
  it('shape', async () => {
    const res = await t.client.get('/admin/broadcasts', { headers: admin });
    expect(res.status).toBe(200);
    const data = await json(res);
    expect(Array.isArray(data.active)).toBe(true);
    expect(Array.isArray(data.completed)).toBe(true);
    expect(typeof data.active_by_time_slot).toBe('object');
  });

  it('lists a new row as active', async () => {
    const id = await createTextBroadcast();
    const data = await json(await t.client.get('/admin/broadcasts', { headers: admin }));
    expect(data.active.map((row: { id: number }) => row.id)).toContain(id);
    expect(data.completed.map((row: { id: number }) => row.id)).not.toContain(id);
  });

  it('puts an expired row under completed', async () => {
    const body = { ...textCreateBody(), deadline: new Date(Date.now() - 60_000).toISOString() };
    const id = (await json(await t.client.post('/admin/broadcasts', body, { headers: admin }))).ids[0];

    const data = await json(await t.client.get('/admin/broadcasts', { headers: admin }));
    const detail = await json(await t.client.get(`/admin/broadcasts/${id}`, { headers: admin }));

    expect(data.completed.map((row: { id: number }) => row.id)).toContain(id);
    expect(data.active.map((row: { id: number }) => row.id)).not.toContain(id);
    expect(detail.is_active).toBe(false);
  });

  it('non-admin forbidden', async () => {
    expect((await t.client.get('/admin/broadcasts', { headers: regular })).status).toBe(403);
  });
});

describe('create', () => {
  it('single row', async () => {
    const res = await t.client.post('/admin/broadcasts', textCreateBody('morning'), { headers: admin });
    expect(res.status).toBe(200);
    const data = await json(res);
    expect(data.ids).toHaveLength(1);
    expect(Number.isInteger(data.ids[0])).toBe(true);
  });

  it('both makes two rows', async () => {
    const res = await t.client.post('/admin/broadcasts', textCreateBody('both'), { headers: admin });
    expect(res.status).toBe(200);
    const { ids } = await json(res);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('text without text rejected', async () => {
    const res = await t.client.post('/admin/broadcasts', { ...textCreateBody(), message_text: '' }, { headers: admin });
    expect(res.status).toBe(400);
    expect((await json(res)).detail).toBe('Text broadcast requires message_text');
  });

  it('media without a file id rejected', async () => {
    const body = { ...textCreateBody(), message_type: 'photo', message_text: null };
    const res = await t.client.post('/admin/broadcasts', body, { headers: admin });
    expect(res.status).toBe(400);
    expect((await json(res)).detail).toBe('photo broadcast requires media_file_id');
  });

  it('a bad body is a 422 in FastAPI shape', async () => {
    const res = await t.client.post('/admin/broadcasts', { ...textCreateBody(), priority: 5000 }, { headers: admin });
    expect(res.status).toBe(422);
    expect((await json(res)).detail[0].loc).toEqual(['body', 'priority']);
  });

  it('a deadline without an offset is taken as UTC', async () => {
    const res = await t.client.post(
      '/admin/broadcasts',
      { ...textCreateBody(), deadline: '2999-01-01T00:00:00' },
      { headers: admin },
    );
    const id = (await json(res)).ids[0];
    expect((await json(await t.client.get(`/admin/broadcasts/${id}`, { headers: admin }))).deadline).toBe(
      '2999-01-01T00:00:00.000Z',
    );
  });

  it('writes an audit row', async () => {
    const res = await t.client.post('/admin/broadcasts', textCreateBody('both'), { headers: admin });
    const { ids } = await json(res);

    const rows = await auditRows('broadcast_create', ids.join(','));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.targetType).toBe('broadcast');
    expect(rows[0]?.actorRole).toBe('admin');
    expect(rows[0]?.detail).toMatchObject({ ids, rows_created: 2 });
  });

  it('non-admin forbidden', async () => {
    expect((await t.client.post('/admin/broadcasts', textCreateBody(), { headers: regular })).status).toBe(403);
  });
});

describe('format', () => {
  it('entities to html', async () => {
    const res = await t.client.post(
      '/admin/broadcasts/format',
      { text: 'bold text', entities: [{ type: 'bold', offset: 0, length: 4 }] },
      { headers: admin },
    );
    expect(res.status).toBe(200);
    expect((await json(res)).html).toBe('<b>bold</b> text');
  });

  it('without entities passes through', async () => {
    const res = await t.client.post('/admin/broadcasts/format', { text: 'plain' }, { headers: admin });
    expect(res.status).toBe(200);
    expect((await json(res)).html).toBe('plain');
  });

  it('non-admin forbidden', async () => {
    expect((await t.client.post('/admin/broadcasts/format', { text: 'x' }, { headers: regular })).status).toBe(403);
  });
});

describe('media upload (multipart)', () => {
  it('mints a file id', async () => {
    const res = await upload('photo', new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2]));
    expect(res.status).toBe(200);
    const data = await json(res);
    expect(data.file_id).toBeTruthy();
    expect(data.message_type).toBe('photo');
  });

  it('a bad type is rejected', async () => {
    const res = await upload('sticker', new Uint8Array([1, 2]), admin, 'x.bin');
    expect(res.status).toBe(400);
    expect((await json(res)).detail).toBe('Unsupported media type: sticker');
  });

  it('an empty file is rejected', async () => {
    const res = await upload('photo', new Uint8Array());
    expect(res.status).toBe(400);
    expect((await json(res)).detail).toBe('Empty file');
  });

  it('over the Telegram limit is rejected', async () => {
    const original = UPLOAD_LIMITS.photo as number;
    UPLOAD_LIMITS.photo = 4;
    try {
      const res = await upload('photo', new TextEncoder().encode('12345'));
      expect(res.status).toBe(400);
      expect((await json(res)).detail).toMatch(/^File too large/);
    } finally {
      UPLOAD_LIMITS.photo = original;
    }
  });

  it('non-admin forbidden', async () => {
    expect((await upload('photo', new Uint8Array([1]), regular)).status).toBe(403);
  });
});

describe('preview', () => {
  it('text', async () => {
    const res = await t.client.post(
      '/admin/broadcasts/preview',
      { message_type: 'text', message_text: 'preview me', keyboard_type: 'main' },
      { headers: admin },
    );
    expect(res.status).toBe(200);
    expect((await json(res)).sent).toBe(true);
    expect(t.fakes.bot.sent('sendMessage')).toHaveLength(1);
  });

  it('text without text rejected', async () => {
    const res = await t.client.post('/admin/broadcasts/preview', { message_type: 'text' }, { headers: admin });
    expect(res.status).toBe(400);
    expect((await json(res)).detail).toBe('Text message requires message_text');
  });

  it('media without a file id rejected', async () => {
    const res = await t.client.post('/admin/broadcasts/preview', { message_type: 'video' }, { headers: admin });
    expect(res.status).toBe(400);
    expect((await json(res)).detail).toBe('Media message requires media_file_id');
  });

  it('non-admin forbidden', async () => {
    const res = await t.client.post(
      '/admin/broadcasts/preview',
      { message_type: 'text', message_text: 'x' },
      { headers: regular },
    );
    expect(res.status).toBe(403);
  });
});

describe('send now (owner)', () => {
  it('owner queues', async () => {
    const res = await t.client.post(
      '/admin/broadcasts/send-now',
      { message_type: 'text', message_text: 'blast', keyboard_type: 'none' },
      { headers: owner },
    );
    expect(res.status).toBe(200);
    expect((await json(res)).queued).toBe(true);
    expect(t.fakes.queue.jobs.map((job) => job.jobName)).toEqual(['user_broadcast_job']);
  });

  it('a saved row writes an audit row', async () => {
    const id = await createTextBroadcast(owner);

    const res = await t.client.post('/admin/broadcasts/send-now', { broadcast_id: id }, { headers: owner });
    expect(res.status).toBe(200);

    const rows = await auditRows('broadcast_send_now', String(id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actorRole).toBe('owner');
    expect(rows[0]?.targetType).toBe('broadcast');
    expect(rows[0]?.detail).toMatchObject({ from_broadcast_id: id });
  });

  it('an unknown broadcast is a 404', async () => {
    const res = await t.client.post('/admin/broadcasts/send-now', { broadcast_id: 99999999 }, { headers: owner });
    expect(res.status).toBe(404);
    expect((await json(res)).detail).toBe('Broadcast not found');
  });

  it('without content is rejected', async () => {
    const res = await t.client.post('/admin/broadcasts/send-now', {}, { headers: owner });
    expect(res.status).toBe(400);
    expect((await json(res)).detail).toBe('send-now requires broadcast_id or message_type');
  });

  it('an admin is forbidden', async () => {
    // send-now is owner-gated: a plain admin gets 403.
    const res = await t.client.post(
      '/admin/broadcasts/send-now',
      { message_type: 'text', message_text: 'blast' },
      { headers: admin },
    );
    expect(res.status).toBe(403);
  });

  it('non-admin forbidden', async () => {
    const res = await t.client.post(
      '/admin/broadcasts/send-now',
      { message_type: 'text', message_text: 'x' },
      { headers: regular },
    );
    expect(res.status).toBe(403);
  });
});

describe('detail, stats, edit, cancel', () => {
  it('detail shape', async () => {
    const id = await createTextBroadcast();
    const res = await t.client.get(`/admin/broadcasts/${id}`, { headers: admin });
    expect(res.status).toBe(200);
    const data = await json(res);
    expect(data.id).toBe(id);
    expect(data.message_type).toBe('text');
    expect(data.is_active).toBe(true);
    expect(data.stats.sent_count).toBe(0);
    expect(data.stats.cycles_run).toBe(0);
  });

  it('detail of a missing row is a 404', async () => {
    const res = await t.client.get('/admin/broadcasts/99999999', { headers: admin });
    expect(res.status).toBe(404);
    expect((await json(res)).detail).toBe('Broadcast not found');
  });

  it('a non-integer id is a 422 on the path', async () => {
    const res = await t.client.get('/admin/broadcasts/abc', { headers: admin });
    expect(res.status).toBe(422);
    expect((await json(res)).detail[0].loc).toEqual(['path', 'broadcast_id']);
  });

  it('detail non-admin forbidden', async () => {
    const id = await createTextBroadcast();
    expect((await t.client.get(`/admin/broadcasts/${id}`, { headers: regular })).status).toBe(403);
  });

  it('stats shape', async () => {
    const id = await createTextBroadcast();
    const res = await t.client.get(`/admin/broadcasts/${id}/stats`, { headers: admin });
    expect(res.status).toBe(200);
    const data = await json(res);
    expect(data.sent_count).toBe(0);
    expect(data.success_count).toBe(0);
    expect(data.last_sent_at).toBeNull();
  });

  it('stats of a missing row is a 404', async () => {
    expect((await t.client.get('/admin/broadcasts/99999999/stats', { headers: admin })).status).toBe(404);
  });

  it('stats non-admin forbidden', async () => {
    expect((await t.client.get('/admin/broadcasts/1/stats', { headers: regular })).status).toBe(403);
  });

  it('edit updates the priority and audits', async () => {
    const id = await createTextBroadcast();

    const res = await t.client.patch(`/admin/broadcasts/${id}`, { priority: 200 }, { headers: admin });

    expect(res.status).toBe(200);
    expect((await json(res)).priority).toBe(200);
    const rows = await auditRows('broadcast_edit', String(id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.detail).toEqual({ changed_fields: ['priority'] });
  });

  it('edit to media without a file id is rejected and changes nothing', async () => {
    const id = await createTextBroadcast();

    const res = await t.client.patch(`/admin/broadcasts/${id}`, { message_type: 'photo' }, { headers: admin });

    expect(res.status).toBe(400);
    expect((await json(res)).detail).toBe('photo broadcast requires media_file_id');
    expect((await json(await t.client.get(`/admin/broadcasts/${id}`, { headers: admin }))).message_type).toBe('text');
  });

  it.each(['message_type', 'deadline', 'priority'])('edit with null for the required %s is rejected', async (field) => {
    // An explicit null for a NOT NULL column is a 400, not a failed UPDATE (500).
    const id = await createTextBroadcast();

    const res = await t.client.patch(`/admin/broadcasts/${id}`, { [field]: null }, { headers: admin });

    expect(res.status).toBe(400);
    expect((await json(res)).detail).toContain(field);
    expect((await json(await t.client.get(`/admin/broadcasts/${id}`, { headers: admin })))[field]).not.toBeNull();
  });

  it('edit text without the flag keeps the formatting', async () => {
    const created = await t.client.post(
      '/admin/broadcasts',
      { ...textCreateBody(), message_text: '<b>Hi</b>', has_text_formatting: true },
      { headers: admin },
    );
    const [id] = (await json(created)).ids;

    const res = await t.client.patch(`/admin/broadcasts/${id}`, { message_text: '<i>Hey</i>' }, { headers: admin });

    expect(res.status).toBe(200);
    const data = await json(res);
    expect([data.message_text, data.message_html, data.has_text_formatting]).toEqual([
      '<i>Hey</i>',
      '<i>Hey</i>',
      true,
    ]);
  });

  it('edit can turn the formatting off', async () => {
    const created = await t.client.post(
      '/admin/broadcasts',
      { ...textCreateBody(), message_text: '<b>Hi</b>', has_text_formatting: true },
      { headers: admin },
    );
    const [id] = (await json(created)).ids;

    const res = await t.client.patch(`/admin/broadcasts/${id}`, { has_text_formatting: false }, { headers: admin });

    expect(res.status).toBe(200);
    expect((await json(res)).has_text_formatting).toBe(false);
  });

  it('edit of a missing row is a 404', async () => {
    expect((await t.client.patch('/admin/broadcasts/99999999', { priority: 1 }, { headers: admin })).status).toBe(404);
  });

  it('edit non-admin forbidden', async () => {
    expect((await t.client.patch('/admin/broadcasts/1', { priority: 1 }, { headers: regular })).status).toBe(403);
  });

  it('cancel sets inactive and audits', async () => {
    const id = await createTextBroadcast();

    const res = await t.client.post(`/admin/broadcasts/${id}/cancel`, undefined, { headers: admin });

    expect(res.status).toBe(200);
    const data = await json(res);
    expect(data.is_active).toBe(false);
    expect(data.completed_at).not.toBeNull();
    const rows = await auditRows('broadcast_cancel', String(id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.targetType).toBe('broadcast');
  });

  it('cancelling again changes nothing', async () => {
    // Cancelling an inactive row returns it as it is: same completed_at, no second audit row.
    const id = await createTextBroadcast();
    const first = await json(await t.client.post(`/admin/broadcasts/${id}/cancel`, undefined, { headers: admin }));

    const res = await t.client.post(`/admin/broadcasts/${id}/cancel`, undefined, { headers: admin });

    expect(res.status).toBe(200);
    const data = await json(res);
    expect(data.is_active).toBe(false);
    expect(data.completed_at).toBe(first.completed_at);
    expect(await auditRows('broadcast_cancel', String(id))).toHaveLength(1);
  });

  it('cancel of an expired row changes nothing', async () => {
    const body = { ...textCreateBody(), deadline: new Date(Date.now() - 60_000).toISOString() };
    const id = (await json(await t.client.post('/admin/broadcasts', body, { headers: admin }))).ids[0];

    const res = await t.client.post(`/admin/broadcasts/${id}/cancel`, undefined, { headers: admin });

    expect(res.status).toBe(200);
    const data = await json(res);
    expect([data.is_active, data.completed_at]).toEqual([false, null]);
    expect(await auditRows('broadcast_cancel', String(id))).toEqual([]);
  });

  it('cancel of a missing row is a 404', async () => {
    expect((await t.client.post('/admin/broadcasts/99999999/cancel', undefined, { headers: admin })).status).toBe(404);
  });

  it('cancel non-admin forbidden', async () => {
    expect((await t.client.post('/admin/broadcasts/1/cancel', undefined, { headers: regular })).status).toBe(403);
  });
});

// The static /broadcasts/<word> paths must NOT be swallowed by /broadcasts/{id}: "format" / "media" / "preview" /
// "send-now" would parse as a broadcast id and 422.
describe('route shadowing guard', () => {
  it('format is not shadowed', async () => {
    const res = await t.client.post('/admin/broadcasts/format', { text: 'x' }, { headers: admin });
    expect(res.status).toBe(200); // reached the format handler, not {id}
  });

  it('send-now is not shadowed for an admin', async () => {
    // Reaches the OWNER-gated handler (403), NOT a 422 from the int parse of "send-now".
    const res = await t.client.post(
      '/admin/broadcasts/send-now',
      { message_type: 'text', message_text: 'x' },
      { headers: admin },
    );
    expect(res.status).toBe(403);
  });

  it('media requires multipart, not an int parse', async () => {
    // /media with no body is a 422 for the missing multipart fields (the media handler).
    const res = await t.client.post('/admin/broadcasts/media', undefined, { headers: admin });
    expect(res.status).toBe(422);
    const missing = (await json(res)).detail.map((err: { loc: string[] }) => err.loc.join('.'));
    expect(missing).toContain('body.file');
  });
});
