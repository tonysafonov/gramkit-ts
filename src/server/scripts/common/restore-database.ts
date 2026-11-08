/**
 * Restore a database from a backup file. Port of `core/scripts/common/restore_database.py`.
 *
 * Robust for the common "older dump onto a more-migrated local DB" case:
 *
 *  1. Pre-create the roles the dump references via OWNER TO / GRANT that the cluster lacks (a prod dump's owner role
 *     doesn't exist on a fresh local cluster, and the load would abort on the first ownership statement).
 *  2. Recreate the target database (terminate connections, DROP DATABASE WITH FORCE, CREATE DATABASE). A plain
 *     `--clean` reload only drops what the dump knows, so tables from newer migrations survive while the migration
 *     table is reset backwards; wiping first lands the DB exactly at the dump's revision.
 *  3. Strip psql directives newer pg_dump (>=17) emits and older servers reject (`\restrict`, `SET transaction_timeout`).
 *  4. Load with ON_ERROR_STOP=1 so a real failure fails.
 *
 * The DB ends at the DUMP's migration; run `make migrate` to fast-forward.
 *
 *     bun src/server/scripts/main.ts restore_database /tmp/dump.sql.gz --confirm
 *     bun src/server/scripts/main.ts restore_database /tmp/dump.sql.gz --confirm --no-recreate
 */
import { existsSync, statSync } from 'node:fs';
import type { DbConfig } from '../../config';
import { getLogger } from '../../lib/logging';
import type { Script, ScriptContext } from '../base';
import { run } from './backup-database';

const logger = getLogger('restore');

/** psql directives newer pg_dump emits that older servers don't understand. */
export const INCOMPATIBLE_LINE_RE = String.raw`^(\\(un)?restrict |SET transaction_timeout)`;

/** Roles referenced by OWNER TO / GRANT / REVOKE. */
const ROLE_RE =
  /(?:OWNER TO|GRANT\b[^;]*?\bTO\b|REVOKE\b[^;]*?\bFROM\b)\s+((?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)(?:\s*,\s*(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*))*)/g;
const IDENT_RE = /"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*/g;
/** Pseudo-roles and keywords that are never real roles to create. */
const ROLE_SKIP = new Set(['PUBLIC', 'CURRENT_USER', 'SESSION_USER', 'CURRENT_ROLE']);

export interface RestoreResult {
  success: boolean;
  backupFile: string;
  durationSeconds: number;
  appName: string;
  recreated: boolean;
  rolesCreated: string[];
  restoredRevision: string | null;
  error?: string;
}

/** Quote a string as a POSIX shell word. */
export const shellQuote = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;
const sqlLit = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const sqlIdent = (value: string): string => `"${value.replaceAll('"', '""')}"`;

/** A database to connect to while (re)creating the target one. */
export const maintenanceDb = (db: DbConfig): string => (db.name === 'postgres' ? 'template1' : 'postgres');

function psqlConn(db: DbConfig, dbname: string): string {
  return (
    `PGPASSWORD=${shellQuote(db.password)} psql -h ${shellQuote(db.host)} -p ${db.port} ` +
    `-U ${shellQuote(db.user)} -d ${shellQuote(dbname)} -v ON_ERROR_STOP=1 -X -q`
  );
}

const shell = (cmd: string, stdin?: string) => run(cmd, [], { shell: true, stdin });

/** Roles referenced by OWNER TO / GRANT / REVOKE in a plain-SQL dump. */
export async function extractRoles(backupFile: string): Promise<string[]> {
  if (backupFile.endsWith('.dump')) return []; // custom-format dumps restore with --no-owner
  const reader = backupFile.endsWith('.gz') ? 'gunzip -c' : 'cat';
  const { stdout } = await shell(`${reader} ${shellQuote(backupFile)} | grep -aE '(OWNER TO|GRANT|REVOKE)' || true`);
  const roles = new Set<string>();
  for (const line of stdout.trim().split('\n')) {
    for (const match of line.matchAll(ROLE_RE)) {
      for (const ident of match[1]?.match(IDENT_RE) ?? []) {
        const name = ident.startsWith('"') ? ident.slice(1, -1) : ident;
        if (!ROLE_SKIP.has(name.toUpperCase())) roles.add(name);
      }
    }
  }
  return [...roles].sort();
}

/** SQL run against the maintenance DB: create the missing roles, optionally recreate the DB. */
export function buildAdminSql(db: DbConfig, roles: string[], recreate: boolean): string {
  const parts = roles.map(
    (role) =>
      `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = ${sqlLit(role)}) ` +
      `THEN CREATE ROLE ${sqlIdent(role)}; END IF; END $$;`,
  );
  if (recreate) {
    parts.push(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity ' +
        `WHERE datname = ${sqlLit(db.name)} AND pid <> pg_backend_pid();`,
      `DROP DATABASE IF EXISTS ${sqlIdent(db.name)} WITH (FORCE);`,
      `CREATE DATABASE ${sqlIdent(db.name)} OWNER ${sqlIdent(db.user)};`,
    );
  }
  return parts.join('\n');
}

/** Keep only the meaningful error lines of psql / pg_restore stderr. */
export function filterErrors(stderr: string): string {
  return stderr
    .split('\n')
    .filter(
      (line) =>
        line && !['notice:', 'dropping', 'does not exist, skipping'].some((x) => line.toLowerCase().includes(x)),
    )
    .slice(0, 5)
    .join('\n');
}

export async function restoreBackup(
  db: DbConfig,
  appName: string,
  backupFile: string,
  recreate = true,
): Promise<RestoreResult> {
  const started = Date.now();
  const elapsed = () => (Date.now() - started) / 1000;
  const failure = (error: string, extra: Partial<RestoreResult> = {}): RestoreResult => ({
    success: false,
    backupFile,
    durationSeconds: elapsed(),
    appName,
    recreated: false,
    rolesCreated: [],
    restoredRevision: null,
    error,
    ...extra,
  });

  if (!existsSync(backupFile)) return failure(`Backup file not found: ${backupFile}`, { durationSeconds: 0 });

  // 1 + 2, over a connection to the maintenance DB (the target may be dropped).
  const roles = await extractRoles(backupFile);
  const adminSql = buildAdminSql(db, roles, recreate);
  if (adminSql) {
    const { code, stderr } = await shell(psqlConn(db, maintenanceDb(db)), adminSql);
    if (code !== 0) {
      return failure(`pre-restore setup failed: ${filterErrors(stderr) || stderr}`, { rolesCreated: roles });
    }
  }

  // 3 + 4
  const quoted = shellQuote(backupFile);
  let cmd: string;
  if (backupFile.endsWith('.dump')) {
    cmd =
      `PGPASSWORD=${shellQuote(db.password)} pg_restore -h ${shellQuote(db.host)} -p ${db.port} ` +
      `-U ${shellQuote(db.user)} -d ${shellQuote(db.name)} --no-owner --clean --if-exists ${quoted}`;
  } else {
    const reader = backupFile.endsWith('.gz') ? 'gunzip -c' : 'cat';
    cmd = `${reader} ${quoted} | grep -avE ${shellQuote(INCOMPATIBLE_LINE_RE)} | ${psqlConn(db, db.name)}`;
  }
  const loaded = await shell(cmd);
  if (loaded.code !== 0) {
    return failure(filterErrors(loaded.stderr) || loaded.stderr || 'psql returned a non-zero exit code', {
      recreated: recreate,
      rolesCreated: roles,
    });
  }

  // 5. The migration revision the dump landed at. Drizzle's journal is not alembic's table: a Python dump carries
  // `alembic_version`, a TS-made one has no such table and the revision stays unknown.
  let restoredRevision: string | null = null;
  const revision = await shell(`${psqlConn(db, db.name)} -t -A`, 'SELECT version_num FROM alembic_version;');
  const first = revision.stdout.trim().split('\n')[0]?.trim();
  if (revision.code === 0 && first) restoredRevision = first;

  return {
    success: true,
    backupFile,
    durationSeconds: elapsed(),
    appName,
    recreated: recreate,
    rolesCreated: roles,
    restoredRevision,
  };
}

/** Restore from a backup file. Args: `<file> --confirm [--no-recreate]`. */
export class RestoreDatabaseScript implements Script {
  constructor(private readonly ctx: ScriptContext) {}

  async execute(backupFile = '', ...flags: string[]): Promise<Record<string, unknown>> {
    const tokens = new Set(flags.map((flag) => flag.toLowerCase()));
    const confirm = ['--confirm', 'confirm', 'true', 'yes', '1'].some((flag) => tokens.has(flag));
    const recreate = !['--no-recreate', 'no-recreate', '--in-place'].some((flag) => tokens.has(flag));
    const appName = this.ctx.appName;

    if (!backupFile) {
      logger.error('Usage: restore_database <backup_file> --confirm');
      return { success: false, error: 'backup_file is required' };
    }
    if (!existsSync(backupFile)) {
      logger.error(`Backup file not found: ${backupFile}`);
      return { success: false, error: `File not found: ${backupFile}` };
    }

    logger.info('='.repeat(60));
    logger.warn('DATABASE RESTORE');
    logger.info(`  App:   ${appName}`);
    logger.info(`  File:  ${backupFile}`);
    logger.info(`  Size:  ${(statSync(backupFile).size / (1024 * 1024)).toFixed(2)} MB`);
    logger.info(`  Mode:  ${recreate ? 'recreate database (wipe first)' : 'load in place (--no-recreate)'}`);

    if (!confirm) {
      logger.warn('This will REPLACE ALL DATA in the database!');
      logger.warn(`To proceed, run with --confirm: restore_database ${backupFile} --confirm`);
      return { success: false, reason: 'confirmation_required' };
    }

    logger.warn('RESTORING DATABASE - THIS WILL OVERWRITE ALL DATA!');
    const result = await restoreBackup(this.ctx.dbConfig, appName, backupFile, recreate);
    if (!result.success) {
      logger.error(`Restore failed: ${result.error}`);
      return { success: false, error: result.error };
    }

    logger.info('Restore completed successfully!');
    logger.info(`  Duration:        ${result.durationSeconds.toFixed(1)}s`);
    if (result.rolesCreated.length) logger.info(`  Roles ensured:   ${result.rolesCreated.join(', ')}`);
    logger.info(`  Recreated DB:    ${result.recreated}`);
    logger.info(`  Restored at rev: ${result.restoredRevision ?? 'unknown'}`);
    logger.warn(`Database is at the dump's migration (${result.restoredRevision ?? 'unknown'}). Run 'make migrate'.`);

    return {
      success: true,
      backup_file: backupFile,
      duration_seconds: result.durationSeconds,
      recreated: result.recreated,
      roles_created: result.rolesCreated,
      restored_revision: result.restoredRevision,
    };
  }
}
