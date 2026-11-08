/** The script runner and the common scripts (backup, restore, wipe) against the local Postgres (`make up`). */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { settings } from '../config';
import { users } from '../db/schema';
import { createTestApp, createUser, type TestApp } from '../testing';
import type { TestServices } from '../testing/auth';
import { withAdminConnection } from '../testing/database';
import type { ScriptContext } from './base';
import { BackupDatabaseScript, backupFilename, createBackup, sizeDisplay } from './common/backup-database';
import {
  buildAdminSql,
  extractRoles,
  filterErrors,
  INCOMPATIBLE_LINE_RE,
  maintenanceDb,
  RestoreDatabaseScript,
  restoreBackup,
} from './common/restore-database';
import { WipeDatabaseScript } from './common/wipe-database';
import { loadScript, runScript, scripts } from './runner';

let app: TestApp<TestServices>;
let dir: string;
let ctx: ScriptContext;

beforeAll(async () => {
  app = await createTestApp();
  dir = mkdtempSync(join(tmpdir(), 'gramkit-scripts-'));
  const { bot, redis, queue, producer } = app.fakes;
  ctx = {
    appName: 'gramkit-test',
    dbConfig: { ...settings.db, name: app.databaseName },
    db: app.db,
    bot: bot.bot,
    redis,
    producer,
    queue,
  };
});

afterAll(async () => {
  rmSync(dir, { recursive: true, force: true });
  await app.close();
});

describe('runner', () => {
  it('knows the app script and the common ones', () => {
    expect(Object.keys(scripts).sort()).toEqual([
      'backup_database',
      'demo_user_stats',
      'restore_database',
      'wipe_database',
    ]);
  });

  it('refuses an unknown script', () => {
    expect(() => loadScript('nope')).toThrow("Script 'nope' not found");
    expect(() => loadScript('constructor')).toThrow("Script 'constructor' not found");
  });

  it('runs demo_user_stats against the database', async () => {
    await createUser(app.db);
    const result = (await runScript('demo_user_stats', [], ctx)) as { status: string; total_users: number };
    expect(result.status).toBe('success');
    expect(result.total_users).toBeGreaterThanOrEqual(1);
  });
});

describe('restore helpers', () => {
  it('finds the roles a plain dump references, quoted or not, and skips the pseudo-roles', async () => {
    const file = join(dir, 'roles.sql.gz');
    writeFileSync(
      file,
      gzipSync(
        [
          'ALTER TABLE public.users OWNER TO "magician-scam-flower";',
          'GRANT SELECT ON TABLE users TO app_reader, "Other Role";',
          'REVOKE ALL ON SCHEMA public FROM PUBLIC;',
          'ALTER TABLE x OWNER TO CURRENT_USER;',
          'SELECT 1;',
        ].join('\n'),
      ),
    );
    expect(await extractRoles(file)).toEqual(['Other Role', 'app_reader', 'magician-scam-flower']);
  });

  it('needs no roles for a custom-format dump', async () => {
    expect(await extractRoles('/tmp/x.dump')).toEqual([]);
  });

  it('builds the admin SQL: roles, then terminate, drop, create', () => {
    const db = { ...settings.db, name: 'my"db', user: 'me' };
    const sql = buildAdminSql(db, ["o'wner"], true);
    expect(sql).toContain(`rolname = 'o''wner'`);
    expect(sql).toContain('CREATE ROLE "o\'wner"');
    expect(sql).toContain(`datname = 'my"db'`);
    expect(sql).toContain('DROP DATABASE IF EXISTS "my""db" WITH (FORCE);');
    expect(sql).toContain('CREATE DATABASE "my""db" OWNER "me";');
    expect(buildAdminSql(db, [], false)).toBe('');
  });

  it('connects to template1 when the target is postgres', () => {
    expect(maintenanceDb({ ...settings.db, name: 'postgres' })).toBe('template1');
    expect(maintenanceDb({ ...settings.db, name: 'app' })).toBe('postgres');
  });

  it('keeps the first five meaningful error lines', () => {
    const err = ['NOTICE: x', 'psql: error: one', 'dropping y', 'two', 'three', 'four', 'five', 'six'].join('\n');
    expect(filterErrors(err)).toBe('psql: error: one\ntwo\nthree\nfour\nfive');
  });

  it('strips the pg_dump 17 directives', () => {
    const re = new RegExp(INCOMPATIBLE_LINE_RE);
    expect(re.test('\\restrict abc')).toBe(true);
    expect(re.test('\\unrestrict abc')).toBe(true);
    expect(re.test('SET transaction_timeout = 0;')).toBe(true);
    expect(re.test('SET statement_timeout = 0;')).toBe(false);
  });

  it('reports a missing file', async () => {
    const result = await restoreBackup(ctx.dbConfig, 'x', join(dir, 'missing.sql'));
    expect(result).toMatchObject({ success: false, error: `Backup file not found: ${join(dir, 'missing.sql')}` });
  });

  it('asks for confirmation before replacing data', async () => {
    const file = join(dir, 'empty.sql');
    writeFileSync(file, '');
    expect(await new RestoreDatabaseScript(ctx).execute(file)).toEqual({
      success: false,
      reason: 'confirmation_required',
    });
    expect(await new RestoreDatabaseScript(ctx).execute()).toEqual({
      success: false,
      error: 'backup_file is required',
    });
  });
});

describe('backup and restore', () => {
  it('backs the database up and restores it into a fresh one', async (task) => {
    const user = await createUser(app.db, { username: 'backed_up_user' });
    const backup = await createBackup({ dbConfig: ctx.dbConfig, appName: 'gramkit-test', outputDir: dir });
    // A pg_dump older than the server refuses to dump; the failure itself is covered below
    if (backup.error?.includes('server version mismatch')) return task.skip();
    expect(backup.error).toBeUndefined();
    expect(backup.success).toBe(true);
    expect(backup.compressed).toBe(true);
    expect(backupFilename(backup)).toMatch(/^gramkit-test_\d{8}_\d{6}\.sql\.gz$/);
    expect(backup.tablesCount).toBeGreaterThan(5);
    expect(sizeDisplay(backup)).toMatch(/(KB|MB)$/);

    const target = `gramkit_restore_${randomBytes(4).toString('hex')}`;
    try {
      const restored = await restoreBackup({ ...settings.db, name: target }, 'gramkit-test', backup.filePath);
      expect(restored.error).toBeUndefined();
      expect(restored).toMatchObject({ success: true, recreated: true });

      const sql = postgres({ ...settings.db, database: target, max: 1, onnotice: () => {} });
      try {
        const rows = await sql`select username from users where id = ${user.id}`;
        expect(rows).toEqual([{ username: 'backed_up_user' }]);
      } finally {
        await sql.end();
      }
    } finally {
      await withAdminConnection(
        async (sql) => void (await sql.unsafe(`DROP DATABASE IF EXISTS "${target}" WITH (FORCE)`)),
      );
    }
  });

  it('fails a backup when pg_dump fails, with the error and no file size', async () => {
    const result = await createBackup({
      dbConfig: { ...ctx.dbConfig, name: 'no_such_db_here' },
      appName: 'x',
      outputDir: dir,
    });
    expect(result.success).toBe(false);
    expect(result.sizeBytes).toBe(0);
    expect(result.error).toBeTruthy();
    expect(
      await new BackupDatabaseScript({ ...ctx, dbConfig: { ...ctx.dbConfig, name: 'no_such_db_here' } }).execute(),
    ).toMatchObject({
      success: false,
    });
  });
});

describe('wipe_database', () => {
  it('truncates every table and flushes redis', async () => {
    await createUser(app.db);
    await app.fakes.redis.set('some-key', 'v');
    const before = await app.db.select().from(users);
    expect(before.length).toBeGreaterThan(0);

    const result = (await new WipeDatabaseScript(ctx).execute()) as {
      tables_wiped: number;
      tables: string[];
      redis_flushed: boolean;
    };

    expect(result.redis_flushed).toBe(true);
    expect(result.tables).toContain('users');
    expect(result.tables).not.toContain('alembic_version');
    expect(await app.db.select().from(users)).toEqual([]);
    expect(await app.fakes.redis.get('some-key')).toBeNull();
  });
});
