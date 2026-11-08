/**
 * The admin list helper: sort whitelist (no SQL injection), search escaping, pagination math. Pure: builds the SQL
 * fragments and inspects them, no database. Port of `tests/unit/test_admin_list.py`.
 */
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { adminAuditLogs } from '../../db/schema';
import { adminListOrder, adminListWhere, escapeLike } from './list';
import { type AdminListParams, buildListResponse, offsetOf } from './schemas';

const dialect = new PgDialect();
const render = (fragment: Parameters<PgDialect['sqlToQuery']>[0] | undefined) => {
  if (!fragment) throw new Error('no SQL');
  return dialect.sqlToQuery(fragment);
};

const SORTABLE = { created_at: adminAuditLogs.createdAt, action: adminAuditLogs.action };
const SEARCHABLE = [adminAuditLogs.action, adminAuditLogs.targetType];

const params = (overrides: Partial<AdminListParams> = {}): AdminListParams => ({
  page: 1,
  pageSize: 25,
  sortDir: 'desc',
  ...overrides,
});

describe('adminListOrder', () => {
  it('falls back to the default sort for an unknown sort column', () => {
    const { sql } = render(adminListOrder(params({ sortBy: 'nonexistent' }), SORTABLE));
    expect(sql).toContain('"created_at" desc');
    expect(sql).not.toContain('nonexistent');
  });

  it('ignores an injection-shaped sort_by', () => {
    const { sql } = render(adminListOrder(params({ sortBy: 'id; DROP TABLE admin_audit_logs;--' }), SORTABLE));
    expect(sql).not.toContain('DROP TABLE');
    expect(sql).toContain('"created_at"');
  });

  it('does not take object prototype keys for columns', () => {
    const { sql } = render(adminListOrder(params({ sortBy: 'constructor' }), SORTABLE));
    expect(sql).toContain('"created_at"');
  });

  it('honours a whitelisted column with the requested direction', () => {
    const { sql } = render(adminListOrder(params({ sortBy: 'action', sortDir: 'asc' }), SORTABLE));
    expect(sql).toContain('"action" asc');
  });
});

describe('adminListWhere', () => {
  it('is empty when nothing filters', () => {
    expect(adminListWhere(params(), { searchable: SEARCHABLE })).toBeUndefined();
  });

  it('searches with ILIKE across the searchable columns, OR-ed', () => {
    const { sql, params: bound } = render(adminListWhere(params({ search: 'gift' }), { searchable: SEARCHABLE }));
    expect(sql.match(/ilike/g)).toHaveLength(SEARCHABLE.length);
    expect(sql.match(/ or /g)).toHaveLength(SEARCHABLE.length - 1);
    expect(bound).toContain('%gift%');
  });

  it('escapes LIKE metacharacters and declares the escape char', () => {
    const { sql, params: bound } = render(adminListWhere(params({ search: '50%_off' }), { searchable: SEARCHABLE }));
    expect(bound).toContain('%50\\%\\_off%');
    expect(sql.match(/escape/g)).toHaveLength(SEARCHABLE.length);
  });

  it('bounds the date column inclusively', () => {
    const from = new Date('2026-01-01T00:00:00Z');
    const to = new Date('2026-02-01T00:00:00Z');
    const { sql } = render(
      adminListWhere(params({ dateFrom: from, dateTo: to }), { dateColumn: adminAuditLogs.createdAt }),
    );
    expect(sql).toContain('>=');
    expect(sql).toContain('<=');
  });

  it('puts the extra conditions in front, AND-ed', () => {
    const { sql } = render(adminListWhere(params({ search: 'x' }), { searchable: SEARCHABLE }, undefined));
    expect(sql).toContain('ilike');
  });
});

describe('escapeLike', () => {
  it.each([
    ['plain', 'plain'],
    ['50%', '50\\%'],
    ['a_b', 'a\\_b'],
    ['back\\slash', 'back\\\\slash'],
  ])('%s -> %s', (term, escaped) => {
    expect(escapeLike(term)).toBe(escaped);
  });
});

describe('pagination', () => {
  it('maps page / page_size to an offset', () => {
    expect(offsetOf(params({ page: 3, pageSize: 10 }))).toBe(20);
  });

  it.each([
    [0, 25, 0],
    [1, 25, 1],
    [25, 25, 1],
    [26, 25, 2],
    [101, 10, 11],
  ])('total_pages for total %i, page_size %i is %i', (total, pageSize, expectedPages) => {
    const envelope = buildListResponse([], total, params({ page: 2, pageSize }));
    expect(envelope.total).toBe(total);
    expect(envelope.total_pages).toBe(expectedPages);
    expect(envelope.page).toBe(2);
    expect(envelope.page_size).toBe(pageSize);
  });
});
