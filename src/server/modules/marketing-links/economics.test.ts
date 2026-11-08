/** Port of core's `tests/unit/test_marketing_links_economics.py`: the economics and the code rules, no DB, no app. */
import { describe, expect, it } from 'vitest';
import { MarketingLinkCreateRequest } from './schemas';
import { appLink, botLink, economics } from './service';

const DAY = 86_400_000;
const stats = (users: number, revenueRub: number) => ({ users, revenueRub });

describe('economics', () => {
  it('no price gives no CAC, ROAS or verdict', () => {
    expect(economics(null, stats(4, 200), new Date(), [])).toEqual({
      cacRub: null,
      ltvRub: 50,
      roas: null,
      payback: null,
      paybackDays: null,
    });
  });

  it('no users gives no CAC or LTV', () => {
    const result = economics(1000, stats(0, 0), new Date(), []);
    expect([result.cacRub, result.ltvRub, result.roas]).toEqual([null, null, 0]);
  });

  it('paid back on the day the running revenue covers the price', () => {
    const start = new Date(Date.now() - 30 * DAY);
    const payments: [Date, number][] = [
      [new Date(start.getTime() + 2 * DAY), 400],
      [new Date(start.getTime() + 5 * DAY + 3 * 3_600_000), 700],
    ];
    const result = economics(1000, stats(3, 1100), start, payments);
    expect(result.payback).toBe('paid_back');
    expect(result.paybackDays).toBe(6); // day 1 is the start date
    expect(result.cacRub).toBe(333.33); // rounded to kopecks
    expect(result.roas).toBe(1.1);
  });

  it('a payment before the start counts as day one', () => {
    const start = new Date();
    const result = economics(100, stats(1, 100), start, [[new Date(start.getTime() - 2 * DAY), 100]]);
    expect([result.payback, result.paybackDays]).toEqual(['paid_back', 1]);
  });

  it('in progress within 14 days, then not paid back', () => {
    const fresh = economics(1000, stats(1, 10), new Date(Date.now() - 13 * DAY), []);
    const late = economics(1000, stats(1, 10), new Date(Date.now() - 14 * DAY - 60_000), []);
    expect(fresh.payback).toBe('in_progress');
    expect(late.payback).toBe('not_paid_back');
  });

  it('an unknown start stays in progress', () => {
    expect(economics(1000, stats(0, 0), null, []).payback).toBe('in_progress');
  });
});

describe('links', () => {
  it('link shapes', () => {
    expect(appLink('https://t.me/bot/app', 'post_1')).toBe('https://t.me/bot/app?startapp=r-post_1');
    expect(botLink('https://t.me/bot', 'post_1')).toBe('https://t.me/bot?start=post_1');
  });
});

describe('code rules', () => {
  const parse = (body: unknown) => MarketingLinkCreateRequest.safeParse(body);

  it('the code is stripped and lowercased', () => {
    expect(parse({ code: ' Ab_1 ' }).data?.code).toBe('ab_1');
  });

  it.each(['a-b', 'a', 'x'.repeat(41), 'with space', 'кот_1', ''])('bad code %j is rejected', (bad) => {
    expect(parse({ code: bad }).success).toBe(false);
  });

  it('channel and price limits', () => {
    expect(parse({ code: 'ok_1', channel: 'x'.repeat(121) }).success).toBe(false);
    expect(parse({ code: 'ok_1', price_rub: -0.01 }).success).toBe(false);
  });
});
