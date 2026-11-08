/**
 * Create a database backup with pg_dump. Port of `core/scripts/common/backup_database.py`.
 *
 * Used by the `backup_database` script and the worker's backup jobs.
 *
 *     bun src/server/scripts/main.ts backup_database
 *     bun src/server/scripts/main.ts backup_database --no-compress
 *     bun src/server/scripts/main.ts backup_database --name=before_migration
 */
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import { InputFile } from 'grammy';
import { type DbConfig, settings } from '../../config';
import { getLogger } from '../../lib/logging';
import type { Script, ScriptContext } from '../base';

const logger = getLogger('backup');

export interface BackupResult {
  success: boolean;
  filePath: string;
  sizeBytes: number;
  durationSeconds: number;
  tablesCount: number;
  timestamp: Date;
  compressed: boolean;
  appName: string;
  error?: string;
}

export const sizeMb = (result: BackupResult): number => result.sizeBytes / (1024 * 1024);

/** Human-readable size: KB for small files, MB for larger. */
export function sizeDisplay(result: BackupResult): string {
  return result.sizeBytes < 1024 * 100
    ? `${(result.sizeBytes / 1024).toFixed(1)} KB`
    : `${sizeMb(result).toFixed(2)} MB`;
}

export const backupFilename = (result: BackupResult): string => basename(result.filePath);

/** `20260101_120000`, UTC. */
function timestampString(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace('T', '_')
    .replace(/\.\d+Z$/, '');
}

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a command (no shell unless `shell`), optionally feeding stdin. A missing binary is code 127. */
export function run(
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; stdin?: string; shell?: boolean } = {},
): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env: options.env ?? process.env,
      shell: options.shell,
      stdio: [options.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', (error: NodeJS.ErrnoException) => {
      const missing = error.code === 'ENOENT';
      resolve({ code: missing ? 127 : 1, stdout: '', stderr: missing ? `${command} not found` : String(error) });
    });
    child.on('close', (code) =>
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      }),
    );
    if (options.stdin !== undefined) {
      child.stdin?.on('error', () => {});
      child.stdin?.end(options.stdin);
    }
  });
}

/** Count CREATE TABLE statements in the backup, as a rough table count. */
async function countTablesInBackup(file: string, compressed: boolean): Promise<number> {
  try {
    const source = createReadStream(file);
    const input = compressed ? source.pipe(createGunzip()) : source;
    let count = 0;
    for await (const line of createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY })) {
      if (line.includes('CREATE TABLE')) count += 1;
    }
    return count;
  } catch {
    return 0;
  }
}

export interface CreateBackupOptions {
  dbConfig: DbConfig;
  appName: string;
  compress?: boolean;
  backupName?: string | null;
  outputDir?: string;
}

/**
 * Create a backup with pg_dump, which writes the file itself (`-Z` gzips plain-format output), so its exit code is
 * the backup's: a `pg_dump | gzip` pipe reports gzip's 0 even when pg_dump is missing or failed.
 */
export async function createBackup({
  dbConfig,
  appName,
  compress = true,
  backupName = null,
  outputDir = '/tmp',
}: CreateBackupOptions): Promise<BackupResult> {
  const started = Date.now();
  const timestamp = new Date();
  const name = backupName || `${appName}_${timestampString(timestamp)}`;
  const backupFile = join(outputDir, `${name}${compress ? '.sql.gz' : '.sql'}`);

  const args = [
    '-h',
    String(dbConfig.host),
    '-p',
    String(dbConfig.port),
    '-U',
    String(dbConfig.user),
    '-d',
    String(dbConfig.name),
    '--clean',
    '--if-exists',
    '-f',
    backupFile,
  ];
  if (compress) args.push('-Z', '6');

  const { code, stderr } = await run('pg_dump', args, {
    env: { ...process.env, PGPASSWORD: String(dbConfig.password) },
  });
  const durationSeconds = (Date.now() - started) / 1000;
  const base = { filePath: backupFile, durationSeconds, timestamp, compressed: compress, appName };

  if (code !== 0) {
    return { ...base, success: false, sizeBytes: 0, tablesCount: 0, error: stderr.trim() || 'Unknown error' };
  }
  const sizeBytes = existsSync(backupFile) ? statSync(backupFile).size : 0;
  return { ...base, success: true, sizeBytes, tablesCount: await countTablesInBackup(backupFile, compress) };
}

/** The document the jobs send: the file, under its own name. */
export const backupDocument = (result: BackupResult): InputFile =>
  new InputFile(result.filePath, backupFilename(result));

/** Create a backup, optionally send it to the owners. Args: `--name=x`, `--no-compress`, `--send`. */
export class BackupDatabaseScript implements Script {
  constructor(private readonly ctx: ScriptContext) {}

  async execute(...args: string[]): Promise<Record<string, unknown>> {
    const flags = new Set(args.map((arg) => arg.toLowerCase()));
    const name = args.find((arg) => arg.startsWith('--name='))?.slice('--name='.length) || null;
    const compress = !(flags.has('--no-compress') || flags.has('false') || flags.has('no'));
    const sendTelegram = flags.has('--send') || flags.has('true') || flags.has('yes') || flags.has('1');
    const appName = this.ctx.appName;

    logger.info('='.repeat(60));
    logger.info(`Creating database backup for ${appName}...`);
    logger.info('='.repeat(60));

    const result = await createBackup({ dbConfig: this.ctx.dbConfig, appName, compress, backupName: name });
    if (!result.success) {
      logger.error(`Backup failed: ${result.error}`);
      return { success: false, error: result.error };
    }

    logger.info('Backup created successfully!');
    logger.info(`  File: ${result.filePath}`);
    logger.info(`  Size: ${sizeMb(result).toFixed(2)} MB`);
    logger.info(`  Tables: ${result.tablesCount}`);
    logger.info(`  Duration: ${result.durationSeconds.toFixed(1)}s`);
    logger.info(`  Compressed: ${result.compressed}`);

    if (sendTelegram && this.ctx.bot) await this.sendToTelegram(result);

    return {
      success: true,
      file_path: result.filePath,
      size_mb: sizeMb(result),
      tables_count: result.tablesCount,
      duration_seconds: result.durationSeconds,
    };
  }

  private async sendToTelegram(result: BackupResult): Promise<void> {
    const bot = this.ctx.bot;
    if (!bot) return;
    const ownerIds = settings.rbac.ownerIds;
    if (ownerIds.length === 0) {
      logger.warn('No owner_ids configured, skipping Telegram send');
      return;
    }
    const caption =
      `Database Backup\nApp: ${result.appName}\nSize: ${sizeMb(result).toFixed(2)} MB\n` +
      `Tables: ${result.tablesCount}\nTime: ${result.durationSeconds.toFixed(1)}s`;
    for (const ownerId of ownerIds) {
      try {
        await bot.api.sendDocument(ownerId, new InputFile(result.filePath), { caption });
        logger.info(`Backup sent to Telegram user ${ownerId}`);
      } catch (err) {
        logger.error({ err }, `Failed to send to ${ownerId}: ${err}`);
      }
    }
  }
}
