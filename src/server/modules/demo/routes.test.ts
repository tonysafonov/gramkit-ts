/** Contract tests of `/demo/*`: ported from the template's `contracts/api/test_demo.py`, plus the rest of the router. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../testing';
import { counters } from './data';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.close());
beforeEach(() => counters.clear());

// biome-ignore lint/suspicious/noExplicitAny: test helper over arbitrary JSON
const json = async (res: Response): Promise<any> => res.json();
const uniqueCounterId = () => `test-${Math.random().toString(36).slice(2, 10)}`;

describe('GET /demo/slow', () => {
  it('returns the response with minimal delay', async () => {
    const res = await t.client.get('/demo/slow?delay_ms=100');
    expect(res.status).toBe(200);
    const data = await json(res);
    expect(data.delay_ms).toBe(100);
    expect(data).toHaveProperty('timestamp');
    expect(data.message).toBe('Loaded after 100ms');
  });

  it('waits at least the delay', async () => {
    const started = performance.now();
    await t.client.get('/demo/slow?delay_ms=150');
    expect(performance.now() - started).toBeGreaterThanOrEqual(140);
  });

  it('rejects a delay below the minimum', async () => {
    expect((await t.client.get('/demo/slow?delay_ms=50')).status).toBe(422);
  });

  it('rejects a delay above the maximum', async () => {
    expect((await t.client.get('/demo/slow?delay_ms=20000')).status).toBe(422);
  });

  it('rejects a delay that is not an integer, with FastAPI error items', async () => {
    const res = await t.client.get('/demo/slow?delay_ms=abc');
    expect(res.status).toBe(422);
    const data = await json(res);
    expect(data.detail[0].loc).toEqual(['query', 'delay_ms']);
  });
});

describe('GET /demo/unreliable', () => {
  it('always succeeds with 0% failure rate', async () => {
    const res = await t.client.get('/demo/unreliable?fail_rate=0');
    expect(res.status).toBe(200);
    const data = await json(res);
    expect(data.attempt_succeeded).toBe(true);
    expect(data).toHaveProperty('timestamp');
    expect(data.message).toBe('Request succeeded!');
  });

  it('always fails with 100% failure rate, and prints the rate as Python does', async () => {
    const res = await t.client.get('/demo/unreliable?fail_rate=1');
    expect(res.status).toBe(500);
    expect((await json(res)).detail).toBe('Random failure (fail_rate=1.0)');
  });

  it('rejects a rate below 0', async () => {
    expect((await t.client.get('/demo/unreliable?fail_rate=-0.1')).status).toBe(422);
  });

  it('rejects a rate above 1', async () => {
    expect((await t.client.get('/demo/unreliable?fail_rate=1.5')).status).toBe(422);
  });
});

describe('/demo/counter', () => {
  it('starts at 0 for a new counter_id', async () => {
    const cid = uniqueCounterId();
    const res = await t.client.get(`/demo/counter?counter_id=${cid}`);
    expect(res.status).toBe(200);
    const data = await json(res);
    expect(data.value).toBe(0);
    expect(data.counter_id).toBe(cid);
    expect(data).toHaveProperty('timestamp');
  });

  it('uses the default counter_id', async () => {
    expect((await json(await t.client.get('/demo/counter'))).counter_id).toBe('default');
  });

  it('increments by 1 by default', async () => {
    const cid = uniqueCounterId();
    const res = await t.client.post(`/demo/counter/increment?counter_id=${cid}`);
    expect(res.status).toBe(200);
    const data = await json(res);
    expect(data.value).toBe(1);
    expect(data.counter_id).toBe(cid);
  });

  it('increments by a custom amount', async () => {
    const cid = uniqueCounterId();
    const res = await t.client.post(`/demo/counter/increment?counter_id=${cid}&amount=5`);
    expect((await json(res)).value).toBe(5);
  });

  it('accumulates increments', async () => {
    const cid = uniqueCounterId();
    await t.client.post(`/demo/counter/increment?counter_id=${cid}&amount=3`);
    await t.client.post(`/demo/counter/increment?counter_id=${cid}&amount=2`);
    expect((await json(await t.client.get(`/demo/counter?counter_id=${cid}`))).value).toBe(5);
  });

  it('resets to 0', async () => {
    const cid = uniqueCounterId();
    await t.client.post(`/demo/counter/increment?counter_id=${cid}&amount=10`);
    const res = await t.client.post(`/demo/counter/reset?counter_id=${cid}`);
    expect(res.status).toBe(200);
    expect((await json(res)).value).toBe(0);
    expect((await json(await t.client.get(`/demo/counter?counter_id=${cid}`))).value).toBe(0);
  });

  it('rejects an amount below 1', async () => {
    expect((await t.client.post('/demo/counter/increment?amount=0')).status).toBe(422);
  });

  it('rejects an amount above 100', async () => {
    expect((await t.client.post('/demo/counter/increment?amount=101')).status).toBe(422);
  });

  it('keeps counters with different ids apart', async () => {
    const [cid1, cid2] = [uniqueCounterId(), uniqueCounterId()];
    await t.client.post(`/demo/counter/increment?counter_id=${cid1}&amount=10`);
    expect((await json(await t.client.get(`/demo/counter?counter_id=${cid2}`))).value).toBe(0);
    expect((await json(await t.client.get(`/demo/counter?counter_id=${cid1}`))).value).toBe(10);
  });

  it('works as a whole: get, increment, verify, reset', async () => {
    const cid = uniqueCounterId();
    expect((await json(await t.client.get(`/demo/counter?counter_id=${cid}`))).value).toBe(0);
    expect((await json(await t.client.post(`/demo/counter/increment?counter_id=${cid}&amount=5`))).value).toBe(5);
    expect((await json(await t.client.get(`/demo/counter?counter_id=${cid}`))).value).toBe(5);
    expect((await json(await t.client.post(`/demo/counter/reset?counter_id=${cid}`))).value).toBe(0);
  });
});

describe('counter should_fail (optimistic update demo)', () => {
  it('fails after a delay when should_fail=true', async () => {
    const started = performance.now();
    const res = await t.client.post(`/demo/counter/increment?counter_id=${uniqueCounterId()}&should_fail=true`);
    expect(res.status).toBe(500);
    expect((await json(res)).detail).toContain('rollback demo');
    expect(performance.now() - started).toBeGreaterThanOrEqual(450);
  });

  it('leaves the counter unchanged after a failed increment', async () => {
    const cid = uniqueCounterId();
    await t.client.post(`/demo/counter/increment?counter_id=${cid}&amount=5`);
    await t.client.post(`/demo/counter/increment?counter_id=${cid}&should_fail=true`);
    expect((await json(await t.client.get(`/demo/counter?counter_id=${cid}`))).value).toBe(5);
  });
});

describe('GET /demo/items', () => {
  it('returns the first page with a cursor', async () => {
    const res = await t.client.get('/demo/items?delay_ms=0');
    expect(res.status).toBe(200);
    const data = await json(res);
    expect(data.items).toHaveLength(10);
    expect(data.items[0]).toEqual({ id: 1, title: 'Item 1', description: 'Description for item 1' });
    expect(data.next_cursor).toBe(10);
    expect(data.has_more).toBe(true);
    expect(data.total).toBe(100);
  });

  it('ends at the last page without a cursor', async () => {
    const data = await json(await t.client.get('/demo/items?cursor=95&limit=10&delay_ms=0'));
    expect(data.items.map((i: { id: number }) => i.id)).toEqual([96, 97, 98, 99, 100]);
    expect(data.next_cursor).toBeNull();
    expect(data.has_more).toBe(false);
  });

  it('is empty past the end', async () => {
    const data = await json(await t.client.get('/demo/items?cursor=500&delay_ms=0'));
    expect(data.items).toEqual([]);
    expect(data.next_cursor).toBeNull();
  });

  it('validates cursor, limit and delay', async () => {
    for (const query of ['cursor=-1', 'limit=0', 'limit=51', 'delay_ms=3001']) {
      expect((await t.client.get(`/demo/items?${query}`)).status).toBe(422);
    }
  });
});

describe('GET /demo/items/{item_id}', () => {
  it('returns the item with details', async () => {
    const res = await t.client.get('/demo/items/7?delay_ms=0');
    expect(res.status).toBe(200);
    const data = await json(res);
    expect(data).toMatchObject({ id: 7, title: 'Item 7', description: 'Description for item 7' });
    expect(data.details).toBe('Extended details for Item 7. This could include more info, metadata, etc.');
    expect(data).toHaveProperty('fetched_at');
  });

  it('is 404 outside 1-100', async () => {
    for (const id of [0, 101, -5]) {
      const res = await t.client.get(`/demo/items/${id}?delay_ms=0`);
      expect(res.status).toBe(404);
      expect((await json(res)).detail).toBe(`Item ${id} not found`);
    }
  });

  it('is 422 for a non-integer id', async () => {
    expect((await t.client.get('/demo/items/abc?delay_ms=0')).status).toBe(422);
  });
});

describe('GET /demo/time', () => {
  it('returns the server time', async () => {
    const before = Date.now();
    const data = await json(await t.client.get('/demo/time'));
    expect(data.unix_ms).toBeGreaterThanOrEqual(before);
    expect(data.unix_ms).toBeLessThanOrEqual(Date.now());
    expect(data.formatted).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(new Date(data.timestamp).getTime()).toBeCloseTo(data.unix_ms, -3);
  });
});

describe('GET /demo/stream', () => {
  it('streams one character per SSE event and ends with [DONE]', async () => {
    const res = await t.client.get('/demo/stream');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-cache, no-transform');
    expect(res.headers.get('x-accel-buffering')).toBe('no');

    const body = await res.text();
    const events = body.split('\n\n').filter(Boolean);
    expect(events.at(-1)).toBe('data: [DONE]');
    const text = events
      .slice(0, -1)
      .map((e) => e.slice('data: '.length))
      .join('');
    expect(text.startsWith('Streaming is the art of sending data incrementally,')).toBe(true);
    expect(text.endsWith('prefixed lines from the response.')).toBe(true);
    expect(text).toContain('- [DONE] sentinel to signal completion');
  }, 20_000);
});

describe('parallel query sources', () => {
  it('weather', async () => {
    const data = await json(await t.client.get('/demo/weather?city=Paris&delay_ms=0'));
    expect(data.city).toBe('Paris');
    expect(Number.isInteger(data.temperature)).toBe(true);
    expect(data.temperature).toBeGreaterThanOrEqual(-10);
    expect(data.temperature).toBeLessThanOrEqual(35);
    expect(['Sunny', 'Cloudy', 'Rainy', 'Snowy', 'Windy']).toContain(data.condition);
    expect(data).toHaveProperty('fetched_at');
  });

  it('weather defaults to Moscow', async () => {
    expect((await json(await t.client.get('/demo/weather?delay_ms=0'))).city).toBe('Moscow');
  });

  it('stock', async () => {
    const data = await json(await t.client.get('/demo/stock?symbol=ABC&delay_ms=0'));
    expect(data.symbol).toBe('ABC');
    expect(data.price).toBeGreaterThanOrEqual(80);
    expect(data.price).toBeLessThanOrEqual(120);
    expect(Math.abs(data.change)).toBeLessThanOrEqual(5);
    expect(data).toHaveProperty('fetched_at');
  });

  it('news', async () => {
    const data = await json(await t.client.get('/demo/news?delay_ms=0'));
    expect(typeof data.headline).toBe('string');
    expect(['Reuters', 'Bloomberg', 'AP', 'BBC', 'TechCrunch']).toContain(data.source);
  });

  it('validates the delay', async () => {
    for (const path of ['weather', 'stock', 'news']) {
      expect((await t.client.get(`/demo/${path}?delay_ms=4000`)).status).toBe(422);
    }
  });
});

describe('GET /demo/error/{status_code}', () => {
  it.each([
    [400, 'Bad request - invalid parameters provided'],
    [401, 'Unauthorized - authentication required'],
    [403, "Forbidden - you don't have permission"],
    [404, "Not found - resource doesn't exist"],
    [409, 'Conflict - resource already exists'],
    [422, 'Validation error - check your input'],
    [429, 'Rate limited - too many requests'],
    [500, 'Internal server error - something went wrong'],
    [502, 'Bad gateway - upstream server error'],
    [503, 'Service unavailable - try again later'],
    [504, 'Gateway timeout - upstream server timeout'],
  ])('returns %i', async (status, detail) => {
    const res = await t.client.get(`/demo/error/${status}`);
    expect(res.status).toBe(status);
    expect(await json(res)).toEqual({ detail });
  });

  it('has a generic message for other codes', async () => {
    const res = await t.client.get('/demo/error/418');
    expect(res.status).toBe(418);
    expect((await json(res)).detail).toBe('Error with status 418');
  });

  it('is 400 outside 400-599', async () => {
    for (const code of [200, 399, 600]) {
      const res = await t.client.get(`/demo/error/${code}`);
      expect(res.status).toBe(400);
      expect((await json(res)).detail).toBe('Status code must be 400-599');
    }
  });

  it('is 422 for a non-integer code', async () => {
    expect((await t.client.get('/demo/error/abc')).status).toBe(422);
  });

  it('waits delay_ms first', async () => {
    const started = performance.now();
    await t.client.get('/demo/error/500?delay_ms=120');
    expect(performance.now() - started).toBeGreaterThanOrEqual(110);
  });
});
