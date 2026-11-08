/** Daily admin digest rendering: pure, no DB. Port of `tests/unit/test_admin_digest.py`. */
import { describe, expect, it } from 'vitest';
import { NBSP } from '../messages/admin-messages';
import { type DailyDigest, dailyDigest, digestPeriod, isPartial, renderError, renderRich, renderText } from './digest';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function digest(overrides: Partial<DailyDigest> = {}): DailyDigest {
  const end = new Date('2026-09-26T01:55:00Z');
  return dailyDigest({
    windowStart: new Date(end.getTime() - 23 * HOUR - 55 * MINUTE),
    windowEnd: end,
    day: digestPeriod({ revenue: { RUB: 1490 }, newUsers: 3, purchases: 1, renewals: 2 }),
    week: digestPeriod({ revenue: { RUB: 4980, XTR: 150 }, newUsers: 18, purchases: 4, renewals: 5 }),
    prevWeek: digestPeriod({ revenue: { RUB: 4450 }, newUsers: 19, purchases: 4, renewals: 3 }),
    dau: 6,
    wau: 27,
    mau: 59,
    activeSubs: 7,
    appTitle: 'Demo',
    ...overrides,
  });
}

const labels = (rich: string): string[] => [...rich.matchAll(/<tr><td>([^<]*)<\/td>/g)].map((m) => m[1] as string);

describe('digest rendering', () => {
  it('has a rich table with weekly context', () => {
    const rich = renderRich(digest());

    expect(rich.startsWith('<h3>📊 Demo · Fri 25 Sep</h3>')).toBe(true);
    expect(rich).toContain('<table bordered striped compact>');
    expect(rich).toContain('<tr><th></th><th>Day</th><th>7d</th><th>Δ</th></tr>');
    // Revenue: day, 7d (currencies kept apart), delta on the main currency (RUB 4980 vs 4450).
    expect(rich).toContain(`<td>Revenue</td><td align="right">1${NBSP}490${NBSP}₽</td>`);
    expect(rich).toContain(`4${NBSP}980${NBSP}₽ + 150${NBSP}⭐`);
    expect(rich).toContain('▲12%');
    expect(rich).toContain('<p>👥 DAU 6 · WAU 27 · MAU 59</p><p>💎 7 active subs</p>');
    expect(rich).toContain('<footer>#digest · Δ = last 7 days vs the 7 days before</footer>');
    expect(labels(rich)).toEqual(['Revenue', 'New users', 'Purchases', 'Renewals', 'Expired']);
  });

  it('reserves bold for the title', () => {
    const text = renderText(digest());

    expect(renderRich(digest())).not.toContain('<b>'); // title is an <h3>
    expect(text.split('<b>').length - 1).toBe(1);
    expect(text.startsWith('<b>📊 Demo · Fri 25 Sep</b>')).toBe(true);
  });

  it('falls back to an aligned monospace table', () => {
    const text = renderText(digest({ rows: [[30, { label: 'Orders', day: 3, week: 20, prevWeek: 18 }]] }));
    const table = text.slice(text.indexOf('<pre>') + 5, text.indexOf('</pre>')).split('\n');

    expect(new Set(table.map((line) => [...line].length)).size).toBe(1); // every row padded to the same width
    expect((table[0] as string).split(/\s+/).filter(Boolean)).toEqual(['Day', '7d', 'Δ']);
    expect(table.slice(1).map((line) => line.split(/\s+/)[0])).toEqual([
      'Revenue',
      'New',
      'Orders',
      'Purchases',
      'Renewals',
      'Expired',
    ]);
  });

  it('merges app rows into the table by order', () => {
    const rows: DailyDigest['rows'] = [
      [30, { label: 'Orders', day: 3, week: 20, prevWeek: 18 }],
      [99, { label: 'Refunds', day: 0, week: 1, prevWeek: 0 }],
    ];
    const rich = renderRich(digest({ rows }));

    expect(labels(rich)).toEqual(['Revenue', 'New users', 'Orders', 'Purchases', 'Renewals', 'Expired', 'Refunds']);
    expect(rich).toContain(
      '<td>Orders</td><td align="right">3</td><td align="right">20</td><td align="right">▲11%</td>',
    );
  });

  it('renders an app line under the table', () => {
    const rich = renderRich(digest({ rows: [[100, { label: '', line: '⭐ <i>12</i> reviews' }]] }));

    expect(rich).toContain('<p>💎 7 active subs</p><p>⭐ <i>12</i> reviews</p>');
    expect(labels(rich)).toEqual(['Revenue', 'New users', 'Purchases', 'Renewals', 'Expired']);
  });

  it('puts app warnings before core ones', () => {
    const rich = renderRich(
      digest({ week: digestPeriod(), pastDue: 2, rows: [[30, { label: 'Orders', warning: 'No orders today' }]] }),
    );

    const block = rich.slice(rich.indexOf('<blockquote>'), rich.indexOf('</blockquote>'));
    expect(block.indexOf('No orders today')).toBeLessThan(block.indexOf('No revenue in 7 days'));
    expect(block.indexOf('No revenue in 7 days')).toBeLessThan(block.indexOf('2 subscriptions'));
    expect(block).toContain('2 subscriptions past due — revenue at risk');
  });

  it('uses the singular for one past due subscription', () => {
    expect(renderRich(digest({ pastDue: 1 }))).toContain('1 subscription past due');
  });

  it('escapes an app label and warning', () => {
    const rich = renderRich(digest({ rows: [[30, { label: 'A<B', warning: 'x < y & z' }]] }));

    expect(rich).toContain('<td>A&lt;B</td>');
    expect(rich).toContain('⚠️ x &lt; y &amp; z');
  });

  it('appends canceled today to the subs line', () => {
    expect(renderText(digest({ canceledDay: 2 }))).toContain('💎 7 active subs · 2 turned off auto-renew');
  });

  it('labels a partial day', () => {
    const now = new Date('2026-09-25T12:00:00Z');
    const partial = digest({ windowStart: new Date(now.getTime() - 10 * HOUR), windowEnd: now });

    expect(renderRich(partial)).toContain('(so far)');
    expect(isPartial(partial)).toBe(true);
    expect(isPartial(digest())).toBe(false);
  });

  it('escapes the exception in an error digest', () => {
    const text = renderError(digest({ error: 'relation <users> does not exist' }));

    expect(text).toContain('❌ Failed to gather statistics:');
    expect(text).toContain('&lt;users&gt;');
  });

  it('escapes the app title', () => {
    expect(renderRich(digest({ appTitle: 'A&B' })).startsWith('<h3>📊 A&amp;B · ')).toBe(true);
  });

  it.each(['en', 'ru'])('resolves every text in the %s locale', (locale) => {
    const full = digest({ week: digestPeriod(), pastDue: 1, canceledDay: 1 });
    const partial = digest({ windowEnd: new Date(digest().windowStart.getTime() + HOUR) });

    for (const rendered of [
      renderRich(full, locale),
      renderText(full, locale),
      renderRich(partial, locale),
      renderError(digest({ error: 'boom' }), locale),
    ]) {
      expect(rendered).not.toContain('core.admin.digest');
    }
  });

  it('translates the Russian digest', () => {
    const rich = renderRich(digest({ pastDue: 3 }), 'ru');

    expect(rich).toContain('<td>Выручка</td>');
    expect(rich).toContain('Подписок с просроченной оплатой: 3');
  });
});
