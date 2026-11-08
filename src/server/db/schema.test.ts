import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../testing';

/**
 * `docs/python-contract/schema-snapshot.txt` is `scripts/schema-snapshot.sql` run against a database migrated with
 * Python's alembic head. The migrated TypeScript schema must describe itself the same, line for line.
 */
describe('the database schema', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(() => t.close());

  it('is the one Python migrates to', async () => {
    const queries = readFileSync('scripts/schema-snapshot.sql', 'utf8')
      .replace(/^--.*$/gm, '')
      .split(';')
      .map((query) => query.trim())
      .filter(Boolean);

    const { sql } = t.api.state.db;
    const lines: string[] = [];
    for (const query of queries) {
      const rows = await sql.unsafe(query).values();
      lines.push(...rows.map((row) => String(row[0])));
    }

    const expected = readFileSync('docs/python-contract/schema-snapshot.txt', 'utf8').trim().split('\n');
    expect(lines.sort()).toEqual(expected.sort());
  });
});
