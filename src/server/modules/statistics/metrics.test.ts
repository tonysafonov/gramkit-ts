/** StatWindows and the Overview-card / digest-row registries. Port of `tests/unit/test_admin_metrics.py`. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type DigestRow,
  type DigestRowFn,
  digestRowFns,
  digestRows,
  type OverviewCardFn,
  overviewCardFns,
  overviewCards,
  registerDigestRow,
  registerOverviewCard,
  StatWindows,
} from './metrics';
import { overviewCard } from './schemas';

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

let savedCards: [string, OverviewCardFn][];
let savedRows: [string, { order: number; fn: DigestRowFn }][];

beforeEach(() => {
  savedCards = [...overviewCards];
  savedRows = [...digestRows];
  overviewCards.clear();
  digestRows.clear();
});
afterEach(() => {
  overviewCards.clear();
  digestRows.clear();
  for (const [key, value] of savedCards) overviewCards.set(key, value);
  for (const [key, value] of savedRows) digestRows.set(key, value);
});

const card =
  (key: string): OverviewCardFn =>
  async () =>
    overviewCard({ key, section: 's', label: key, value: 1 });

const row =
  (label: string): DigestRowFn =>
  async (): Promise<DigestRow | null> => ({ label });

describe('StatWindows', () => {
  it('starts the day yesterday before two am', () => {
    const windows = StatWindows.anchored(new Date('2026-09-26T01:59:00Z'));

    expect(windows.todayStart).toEqual(new Date('2026-09-25T02:00:00Z'));
    expect(windows.todayStr).toBe('2026-09-25');
  });

  it('starts the day today from two am', () => {
    const windows = StatWindows.anchored(new Date('2026-09-26T02:00:00Z'));

    expect(windows.todayStart).toEqual(new Date('2026-09-26T02:00:00Z'));
    expect(windows.weekAgoStart.getTime()).toBe(windows.todayStart.getTime() - 7 * DAY);
    expect(windows.monthAgoStart.getTime()).toBe(windows.todayStart.getTime() - 30 * DAY);
  });

  it('ends the previous windows where the current ones start', () => {
    const windows = StatWindows.anchored(new Date('2026-09-26T12:00:00Z'));

    expect(windows.prevDayStart.getTime()).toBe(windows.todayStart.getTime() - DAY);
    expect(windows.prevWeekStart.getTime()).toBe(windows.weekAgoStart.getTime() - 7 * DAY);
    expect(windows.prevMonthStart.getTime()).toBe(windows.monthAgoStart.getTime() - 30 * DAY);
  });

  it('is partial until twenty three hours in', () => {
    const start = new Date('2026-09-25T02:00:00Z').getTime();

    expect(StatWindows.anchored(new Date(start + 10 * HOUR)).partial).toBe(true);
    expect(StatWindows.anchored(new Date(start + 23 * HOUR + 55 * 60_000)).partial).toBe(false);
  });
});

describe('registries', () => {
  it('keeps cards in registration order and a key replaces', () => {
    const [first, second, replacement] = [card('a'), card('b'), card('a2')] as [
      OverviewCardFn,
      OverviewCardFn,
      OverviewCardFn,
    ];
    registerOverviewCard('a', first);
    registerOverviewCard('b', second);
    registerOverviewCard('a', replacement);

    expect(overviewCardFns()).toEqual([replacement, second]);
  });

  it('sorts rows by order, then registration', () => {
    const [late, early, tieOne, tieTwo] = [row('late'), row('early'), row('t1'), row('t2')] as [
      DigestRowFn,
      DigestRowFn,
      DigestRowFn,
      DigestRowFn,
    ];
    registerDigestRow('late', late, { order: 90 });
    registerDigestRow('tie1', tieOne, { order: 30 });
    registerDigestRow('early', early, { order: 5 });
    registerDigestRow('tie2', tieTwo, { order: 30 });

    expect(digestRowFns()).toEqual([
      [5, early],
      [30, tieOne],
      [30, tieTwo],
      [90, late],
    ]);
  });

  it('replaces a row registered again', () => {
    const [old, replacement] = [row('old'), row('new')] as [DigestRowFn, DigestRowFn];
    registerDigestRow('x', old, { order: 30 });
    registerDigestRow('x', replacement, { order: 70 });

    expect(digestRowFns()).toEqual([[70, replacement]]);
  });
});
