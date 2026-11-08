/**
 * Read-only helpers for admin list endpoints: search, date filter, whitelisted sort, pagination.
 *
 * Pure builders over Drizzle columns: no database access. The key safety property: `sortBy` is only honoured when
 * it is a key of the endpoint's `sortable` whitelist, so a client can never sort by (or inject) an arbitrary column.
 */
import { and, asc, desc, gte, lte, or, type SQL, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { AdminListParams } from './schemas';

export interface AdminListSpec {
  /** `sort_by` value -> column. The FIRST entry is the default sort when `sort_by` is missing or unknown. */
  sortable: Record<string, AnyPgColumn>;
  /** Columns OR-ed together with ILIKE for the free-text `search`, matched literally. */
  searchable?: AnyPgColumn[];
  /** The column `date_from` / `date_to` apply to. */
  dateColumn?: AnyPgColumn;
}

/** Escape LIKE metacharacters so a search term matches literally. The backslash goes first: it is the escape char. */
export const escapeLike = (term: string): string =>
  term.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');

/** Search and date-range conditions (the same for the page and for the total). `undefined` when nothing filters. */
export function adminListWhere(
  params: AdminListParams,
  { searchable = [], dateColumn }: Pick<AdminListSpec, 'searchable' | 'dateColumn'>,
  ...extra: (SQL | undefined)[]
): SQL | undefined {
  const conditions: (SQL | undefined)[] = [...extra];
  if (params.search && searchable.length > 0) {
    const pattern = `%${escapeLike(params.search)}%`;
    conditions.push(or(...searchable.map((column) => sql`${column} ilike ${pattern} escape '\\'`)));
  }
  if (dateColumn) {
    if (params.dateFrom) conditions.push(gte(dateColumn, params.dateFrom));
    if (params.dateTo) conditions.push(lte(dateColumn, params.dateTo));
  }
  return and(...conditions);
}

/** The whitelisted ORDER BY: an unknown `sortBy` falls back to the first entry of `sortable`. */
export function adminListOrder(params: AdminListParams, sortable: Record<string, AnyPgColumn>): SQL | undefined {
  const fallback = Object.values(sortable)[0];
  if (!fallback) return undefined;
  const column =
    (params.sortBy && Object.hasOwn(sortable, params.sortBy) ? sortable[params.sortBy] : undefined) ?? fallback;
  return params.sortDir === 'desc' ? desc(column) : asc(column);
}
