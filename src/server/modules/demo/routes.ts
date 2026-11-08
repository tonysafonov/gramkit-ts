/**
 * Demo endpoints for the TanStack Query showcase (Python's `routers/demo.py`): artificial delays, controlled failures,
 * an in-memory counter, a delayed notification job, infinite scroll, polling, SSE streaming, parallel sources and RBAC.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { Hono } from 'hono';
import { getUser } from '../../auth/context';
import { settings } from '../../config';
import type { Env } from '../../env';
import { AppError, BadRequestError, ForbiddenError, NotFoundError, UnauthorizedError } from '../../lib/errors';
import { trackStream } from '../../lib/streaming';
import { validate } from '../../lib/validate';
import {
  counters,
  ERROR_MESSAGES,
  MOCK_ITEMS,
  MOCK_STREAM_TEXT,
  NEWS_HEADLINES,
  NEWS_SOURCES,
  ROLE_PERMISSIONS,
  WEATHER_CONDITIONS,
} from './data';
import {
  CounterQuery,
  DelayQuery,
  IncrementQuery,
  IntParam,
  ItemsQuery,
  isoformat,
  NotifyRequest,
  pyFloat,
  SetRoleRequest,
  SlowQuery,
  StockQuery,
  UnreliableQuery,
  WeatherQuery,
} from './schemas';

const pick = <T>(values: T[]): T => values[Math.floor(Math.random() * values.length)] as T;
const uniform = (a: number, b: number) => a + Math.random() * (b - a);
const randint = (a: number, b: number) => a + Math.floor(Math.random() * (b - a + 1));
const round2 = (value: number) => Math.round(value * 100) / 100;
const delay = (ms: number) => (ms > 0 ? sleep(ms) : Promise.resolve());

const VALID_ROLES = ['user', 'admin', 'owner'];
const permissionsOf = (role: string) => ROLE_PERMISSIONS[role] ?? (ROLE_PERMISSIONS.user as string[]);

const counterResponse = (counterId: string, value: number) => ({
  value,
  counter_id: counterId,
  timestamp: isoformat(),
});

const STREAM_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
  'Transfer-Encoding': 'chunked',
};

export const demoRoutes = new Hono<Env>()
  .get('/slow', validate('query', SlowQuery), async (c) => {
    const { delay_ms } = c.req.valid('query');
    await sleep(delay_ms);
    return c.json({ message: `Loaded after ${delay_ms}ms`, timestamp: isoformat(), delay_ms });
  })

  .get('/unreliable', validate('query', UnreliableQuery), (c) => {
    const { fail_rate } = c.req.valid('query');
    if (Math.random() < fail_rate) throw new AppError(500, `Random failure (fail_rate=${pyFloat(fail_rate)})`);
    return c.json({ message: 'Request succeeded!', timestamp: isoformat(), attempt_succeeded: true });
  })

  .get('/counter', validate('query', CounterQuery), (c) => {
    const { counter_id } = c.req.valid('query');
    return c.json(counterResponse(counter_id, counters.get(counter_id) ?? 0));
  })

  .post('/counter/increment', validate('query', IncrementQuery), async (c) => {
    const { counter_id, amount, should_fail } = c.req.valid('query');
    if (should_fail) {
      // Simulate server processing time before failure
      await sleep(500);
      throw new AppError(500, 'Intentional failure for rollback demo');
    }
    const value = (counters.get(counter_id) ?? 0) + amount;
    counters.set(counter_id, value);
    return c.json(counterResponse(counter_id, value));
  })

  .post('/counter/reset', validate('query', CounterQuery), (c) => {
    const { counter_id } = c.req.valid('query');
    counters.set(counter_id, 0);
    return c.json(counterResponse(counter_id, 0));
  })

  // Schedule a delayed Telegram notification. Guests have no telegram_id, so they get a 401.
  .post('/notify', getUser, validate('json', NotifyRequest), async (c) => {
    const user = c.get('user');
    if (!user.telegramId) throw new UnauthorizedError('Telegram authentication required for notifications');

    const seconds = Math.max(1, Math.min(60, c.req.valid('json').delay_seconds));
    await c
      .get('services')
      .worker.enqueueJob(
        'send_delayed_notification',
        { telegram_user_id: user.telegramId, delay_seconds: seconds },
        { deferBy: seconds },
      );
    return c.json({
      message: `Notification scheduled! Check Telegram in ${seconds} seconds.`,
      delay_seconds: seconds,
      scheduled_at: isoformat(),
    });
  })

  .get('/items', validate('query', ItemsQuery), async (c) => {
    const { cursor, limit, delay_ms } = c.req.valid('query');
    await delay(delay_ms);
    const end = Math.min(cursor + limit, MOCK_ITEMS.length);
    const nextCursor = end < MOCK_ITEMS.length ? end : null;
    return c.json({
      items: MOCK_ITEMS.slice(cursor, end),
      next_cursor: nextCursor,
      has_more: nextCursor !== null,
      total: MOCK_ITEMS.length,
    });
  })

  .get('/items/:item_id', validate('param', IntParam('item_id')), validate('query', DelayQuery(300)), async (c) => {
    const itemId = Number(c.req.valid('param').item_id);
    await delay(c.req.valid('query').delay_ms);
    const item = MOCK_ITEMS[itemId - 1];
    if (itemId < 1 || itemId > 100 || !item) throw new NotFoundError(`Item ${itemId} not found`);
    return c.json({
      ...item,
      details: `Extended details for ${item.title}. This could include more info, metadata, etc.`,
      fetched_at: isoformat(),
    });
  })

  .get('/time', (c) => {
    const now = new Date();
    return c.json({
      timestamp: isoformat(now),
      unix_ms: now.getTime(),
      formatted: now.toISOString().slice(11, 19),
    });
  })

  // SSE, one character per event, `[DONE]` at the end. No database: the request holds no transaction.
  .get('/stream', (c) => {
    const end = trackStream(c);
    const encoder = new TextEncoder();
    let cancelled = false;
    let index = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (cancelled) return;
        if (index < MOCK_STREAM_TEXT.length) {
          // `for char in text` iterates code points, not UTF-16 units
          const char = String.fromCodePoint(MOCK_STREAM_TEXT.codePointAt(index) as number);
          index += char.length;
          controller.enqueue(encoder.encode(`data: ${char}\n\n`));
          await sleep(30);
          return;
        }
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
        end();
      },
      cancel() {
        cancelled = true;
        end();
      },
    });
    return c.newResponse(body, 200, STREAM_HEADERS);
  })

  .get('/weather', validate('query', WeatherQuery), async (c) => {
    const { city, delay_ms } = c.req.valid('query');
    await delay(delay_ms);
    return c.json({
      city,
      temperature: randint(-10, 35),
      condition: pick(WEATHER_CONDITIONS),
      fetched_at: isoformat(),
    });
  })

  .get('/stock', validate('query', StockQuery), async (c) => {
    const { symbol, delay_ms } = c.req.valid('query');
    await delay(delay_ms);
    return c.json({
      symbol,
      price: round2(100 + uniform(-20, 20)),
      change: round2(uniform(-5, 5)),
      fetched_at: isoformat(),
    });
  })

  .get('/news', validate('query', DelayQuery(700)), async (c) => {
    await delay(c.req.valid('query').delay_ms);
    return c.json({ headline: pick(NEWS_HEADLINES), source: pick(NEWS_SOURCES), fetched_at: isoformat() });
  })

  .get(
    '/error/:status_code',
    validate('param', IntParam('status_code')),
    validate('query', DelayQuery(0)),
    async (c) => {
      const statusCode = Number(c.req.valid('param').status_code);
      await delay(c.req.valid('query').delay_ms);
      if (statusCode < 400 || statusCode > 599) throw new BadRequestError('Status code must be 400-599');
      // biome-ignore lint/suspicious/noExplicitAny: 400-599 is checked above, Hono's union can't express the range
      throw new AppError(statusCode as any, ERROR_MESSAGES[statusCode] ?? `Error with status ${statusCode}`);
    },
  )

  .get('/rbac/me', getUser, (c) => {
    const role = c.get('user').role || 'user';
    return c.json({ role, permissions: permissionsOf(role) });
  })

  // Debug mode only: switch your own role to try the permission levels
  .post('/rbac/set-role', getUser, validate('json', SetRoleRequest), async (c) => {
    if (!settings.debug) throw new ForbiddenError('Role switching only available in debug mode');

    const user = c.get('user');
    const { role } = c.req.valid('json');
    if (!VALID_ROLES.includes(role)) {
      throw new BadRequestError(`Invalid role. Must be one of: [${VALID_ROLES.map((r) => `'${r}'`).join(', ')}]`);
    }
    const oldRole = user.role || 'user';
    await c.get('repos').users.updateUser(user.id, { role });
    return c.json({
      success: true,
      old_role: oldRole,
      new_role: role,
      message: `Role changed from ${oldRole} to ${role}. Refresh to see changes.`,
    });
  })

  .post('/rbac/protected-action', getUser, (c) => {
    const role = c.get('user').role || 'user';
    if (!permissionsOf(role).includes('protected_actions')) {
      throw new ForbiddenError(`This action requires owner role. Your role: ${role}`);
    }
    return c.json({ success: true, message: 'Protected action executed successfully!', your_role: role });
  });
