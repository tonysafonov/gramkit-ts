import { eq } from 'drizzle-orm';
import type { ExpectStatic } from 'vitest';
import { users } from '../db/schema';
import type { TestApp } from './app';
import { createUser } from './factories';

const SHARED_TELEGRAM_ID = 424242;

/**
 * Two test files run this at the same time and take the same unique telegram id. In a shared database one of them
 * would fail on the constraint, or count the other's row. The pause keeps both inserts in flight together.
 */
export async function assertOwnDatabase(t: TestApp, expect: ExpectStatic): Promise<void> {
  await createUser(t.db, { telegramId: SHARED_TELEGRAM_ID });
  await new Promise((resolve) => setTimeout(resolve, 300));

  const rows = await t.db.select().from(users).where(eq(users.telegramId, SHARED_TELEGRAM_ID));
  expect(rows).toHaveLength(1);

  const { sql } = t.api.state.db;
  const [row] = await sql<{ name: string }[]>`select current_database() as name`;
  expect(row?.name).toBe(t.databaseName);
}
