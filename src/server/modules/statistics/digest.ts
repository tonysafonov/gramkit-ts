/**
 * Daily admin digest: data shape + Telegram formatting.
 *
 * Answers "how did the last day go?" in a few seconds: one table putting every number next to its 7-day context,
 * plus a few summary lines. Rendered twice from the same data:
 *
 * - `renderRich`: Bot API 10.1 Rich Message (real table, `<footer>`)
 * - `renderText`: classic Telegram HTML fallback (monospace table)
 *
 * Revenue stays per-currency everywhere; the headline delta is taken on the currency that earned the most this week.
 * Apps add rows, summary lines and warnings through `registerDigestRow`; they arrive here as `DailyDigest.rows`.
 * Texts come from `core.admin.digest.*` (en / ru).
 */
import { t } from '../../lib/i18n';
import { esc, fmtDelta, fmtInt, fmtMoneyMap } from '../messages/admin-messages';
import type { DigestRow } from './metrics';

// Orders of core's table rows; app rows registered with an order in between land in between.
export const ROW_ORDER_REVENUE = 10;
export const ROW_ORDER_NEW_USERS = 20;
export const ROW_ORDER_PURCHASES = 40;
export const ROW_ORDER_RENEWALS = 50;
export const ROW_ORDER_EXPIRED = 60;

export interface DigestPeriod {
  revenue: Record<string, number>;
  newUsers: number;
  purchases: number;
  renewals: number;
  expired: number;
}

export const digestPeriod = (overrides: Partial<DigestPeriod> = {}): DigestPeriod => ({
  revenue: {},
  newUsers: 0,
  purchases: 0,
  renewals: 0,
  expired: 0,
  ...overrides,
});

export interface DailyDigest {
  windowStart: Date;
  windowEnd: Date;
  day: DigestPeriod;
  week: DigestPeriod;
  prevWeek: DigestPeriod;
  dau: number;
  wau: number;
  mau: number;
  activeSubs: number;
  pastDue: number;
  canceledDay: number;
  /** App rows from the digest registry: `[order, row]`, already in order. */
  rows: [number, DigestRow][];
  appTitle: string;
  error: string | null;
}

export function dailyDigest(
  fields: Pick<DailyDigest, 'windowStart' | 'windowEnd' | 'day' | 'week' | 'prevWeek'> & Partial<DailyDigest>,
): DailyDigest {
  return {
    dau: 0,
    wau: 0,
    mau: 0,
    activeSubs: 0,
    pastDue: 0,
    canceledDay: 0,
    rows: [],
    appTitle: 'app',
    error: null,
    ...fields,
  };
}

/** True for a manual /stats mid-day: the window isn't a full day yet. */
export const isPartial = (d: DailyDigest): boolean =>
  (d.windowEnd.getTime() - d.windowStart.getTime()) / 1000 < 23 * 3600;

type Cells = [string, string, string, string];

const tr = (key: string, locale: string, vars?: Record<string, unknown>): string =>
  t(`core.admin.digest.${key}`, locale, vars);

/** The change of the main currency: the one with the largest amount (this week, else the week before). */
function mainCurrencyDelta(current: Record<string, number>, previous: Record<string, number>): string {
  const merged = { ...previous, ...current };
  const currencies = Object.keys(merged);
  if (currencies.length === 0) return '=';
  let main = currencies[0] as string;
  let best = Number.NEGATIVE_INFINITY;
  for (const currency of currencies) {
    const score = current[currency] || previous[currency] || 0;
    if (score > best) {
      best = score;
      main = currency;
    }
  }
  return fmtDelta(current[main] ?? 0, previous[main] ?? 0);
}

const countCells = (label: string, day: number, week: number, prevWeek: number): Cells => [
  label,
  fmtInt(day),
  fmtInt(week),
  fmtDelta(week, prevWeek),
];

/** App rows that render as table rows: a label and no `line`. */
const tableRows = (d: DailyDigest): [number, DigestRow][] => d.rows.filter(([, row]) => !row.line && row.label);

/** (label, day, 7d, vs prev 7d): shared by both renderings. Core and app rows merged by order. */
function rows(d: DailyDigest, locale: string): Cells[] {
  const coreRow = (key: string, attr: 'newUsers' | 'purchases' | 'renewals' | 'expired'): Cells =>
    countCells(tr(key, locale), d.day[attr], d.week[attr], d.prevWeek[attr]);

  const revenue: Cells = [
    tr('revenue', locale),
    fmtMoneyMap(d.day.revenue),
    fmtMoneyMap(d.week.revenue),
    mainCurrencyDelta(d.week.revenue, d.prevWeek.revenue),
  ];
  // [order, 0 = core first on a tie, position, cells]
  const entries: [number, number, number, Cells][] = [
    [ROW_ORDER_REVENUE, 0, 0, revenue],
    [ROW_ORDER_NEW_USERS, 0, 1, coreRow('new_users', 'newUsers')],
    [ROW_ORDER_PURCHASES, 0, 2, coreRow('purchases', 'purchases')],
    [ROW_ORDER_RENEWALS, 0, 3, coreRow('renewals', 'renewals')],
    [ROW_ORDER_EXPIRED, 0, 4, coreRow('expired', 'expired')],
  ];
  tableRows(d).forEach(([order, row], position) => {
    entries.push([order, 1, position, countCells(esc(row.label), row.day ?? 0, row.week ?? 0, row.prevWeek ?? 0)]);
  });
  return entries.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]).map((entry) => entry[3]);
}

function warnings(d: DailyDigest, locale: string): string[] {
  // App warnings first (they are usually the most specific), then core's.
  const result = d.rows.filter(([, row]) => row.warning).map(([, row]) => esc(row.warning));
  if (Object.keys(d.week.revenue).length === 0 && Object.keys(d.prevWeek.revenue).length > 0) {
    result.push(tr('warn_no_revenue', locale));
  }
  if (d.pastDue) {
    result.push(tr(d.pastDue === 1 ? 'warn_past_due_one' : 'warn_past_due_other', locale, { count: d.pastDue }));
  }
  return result;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function title(d: DailyDigest, locale: string): string {
  const s = d.windowStart;
  const date = `${WEEKDAYS[s.getUTCDay()]} ${s.getUTCDate()} ${MONTHS[s.getUTCMonth()]}`;
  return `📊 ${esc(d.appTitle)} · ${date}${isPartial(d) ? tr('so_far', locale) : ''}`;
}

/** Plain-HTML lines under the table (users, subs, then the app's lines). */
function summaryLines(d: DailyDigest, locale: string): string[] {
  let subs = tr('active_subs', locale, { count: fmtInt(d.activeSubs) });
  if (d.canceledDay) subs += tr('turned_off', locale, { count: d.canceledDay });
  return [
    tr('users_line', locale, { dau: fmtInt(d.dau), wau: fmtInt(d.wau), mau: fmtInt(d.mau) }),
    subs,
    ...d.rows.flatMap(([, row]) => (row.line ? [row.line] : [])),
  ];
}

const header = (locale: string): Cells => ['', tr('day', locale), tr('week', locale), tr('delta', locale)];

/** Rich HTML body for sendRichMessage. */
export function renderRich(d: DailyDigest, locale = 'en'): string {
  const [, dayH, weekH, deltaH] = header(locale);
  const table = [
    '<table bordered striped compact>',
    `<tr><th></th><th>${dayH}</th><th>${weekH}</th><th>${deltaH}</th></tr>`,
  ];
  for (const [label, day, week, delta] of rows(d, locale)) {
    table.push(
      `<tr><td>${label}</td><td align="right">${day}</td><td align="right">${week}</td><td align="right">${delta}</td></tr>`,
    );
  }
  table.push('</table>');

  const parts = [`<h3>${title(d, locale)}</h3>`, table.join('')];
  parts.push(...summaryLines(d, locale).map((line) => `<p>${line}</p>`));
  const warns = warnings(d, locale);
  if (warns.length > 0) parts.push(`<blockquote>${warns.map((w) => `⚠️ ${w}`).join('<br>')}</blockquote>`);
  parts.push(`<footer>${tr('footnote', locale)}</footer>`);
  return parts.join('');
}

/** Classic Telegram HTML fallback: the same table in monospace. */
export function renderText(d: DailyDigest, locale = 'en'): string {
  const all = [header(locale), ...rows(d, locale)];
  const widths = [0, 1, 2, 3].map((i) => Math.max(...all.map((row) => [...row[i as 0 | 1 | 2 | 3]].length)));
  const pad = (cell: string, i: number): string => {
    const gap = ' '.repeat(Math.max((widths[i] as number) - [...cell].length, 0));
    return i === 0 ? cell + gap : gap + cell;
  };
  const table = all.map((row) => row.map((cell, i) => pad(cell, i)).join('  ')).join('\n');

  const parts = [`<b>${title(d, locale)}</b>`, `<pre>${table}</pre>`, ...summaryLines(d, locale)];
  const warns = warnings(d, locale);
  if (warns.length > 0) parts.push('', ...warns.map((w) => `⚠️ ${w}`));
  parts.push('', `<i>${tr('footnote', locale)}</i>`);
  return parts.join('\n');
}

export function renderError(d: DailyDigest, locale = 'en'): string {
  return `<b>${title(d, locale)}</b>\n\n${tr('failed', locale)}\n<pre>${esc(d.error)}</pre>`;
}
