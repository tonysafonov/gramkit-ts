/**
 * Runs a script with the full infrastructure: database, Redis, RabbitMQ, bot, queue. Port of `core/scripts/runner.py`
 * and the app's `scripts/__main__.py`.
 *
 *     bun src/server/scripts/main.ts <script_name> [args...]
 *     bun src/server/scripts/main.ts demo_user_stats
 *
 * Python finds a script by importing a module of that name; here the registry below is the list.
 */
import pkg from '../../../package.json';
import { getSharedBot } from '../clients/bot';
import { posthog } from '../clients/posthog';
import { QueueClient } from '../clients/queue';
import { RabbitProducer } from '../clients/rabbit';
import { RedisClient } from '../clients/redis';
import { initSentry } from '../clients/sentry';
import { settings } from '../config';
import { createDb } from '../db/client';
import { flushLogs, getLogger } from '../lib/logging';
import { DemoUserStatsScript } from './app/demo-user-stats';
import type { Script, ScriptContext } from './base';
import { BackupDatabaseScript } from './common/backup-database';
import { RestoreDatabaseScript } from './common/restore-database';
import { WipeDatabaseScript } from './common/wipe-database';

const logger = getLogger('script-runner');

export type ScriptFactory = new (ctx: ScriptContext) => Script;

/** Script name (Python's file name) to class. The app's scripts first, then core's common ones. */
export const scripts: Record<string, ScriptFactory> = {
  demo_user_stats: DemoUserStatsScript,
  backup_database: BackupDatabaseScript,
  restore_database: RestoreDatabaseScript,
  wipe_database: WipeDatabaseScript,
};

export function loadScript(name: string, registry: Record<string, ScriptFactory> = scripts): ScriptFactory {
  const factory = Object.hasOwn(registry, name) ? registry[name] : undefined;
  if (!factory) {
    logger.error(`Failed to load script '${name}'`);
    const available = Object.keys(registry).sort();
    logger.info(available.length ? `Available scripts: ${available.join(', ')}` : 'No scripts found');
    throw new Error(`Script '${name}' not found`);
  }
  return factory;
}

/** Open the clients. A RabbitMQ that can't be reached is a warning, as in Python. */
export async function setupInfrastructure(
  version: string = pkg.version,
): Promise<{ ctx: ScriptContext; close: () => Promise<void> }> {
  logger.info('Setting up infrastructure...');
  initSentry(version);
  posthog.setup(settings.observability.posthogApiKey, settings.observability.posthogHost, version);
  const dbClient = createDb();
  const redis = new RedisClient();
  const producer = new RabbitProducer();
  const queue = new QueueClient();
  try {
    await producer.connect();
    logger.info('RabbitMQ producer connected');
  } catch (err) {
    logger.warn(`RabbitMQ connection failed (will continue without it): ${err}`);
  }
  const ctx: ScriptContext = {
    appName: settings.appName,
    dbConfig: settings.db,
    db: dbClient.db,
    bot: settings.bot.token ? getSharedBot() : null,
    redis,
    producer,
    queue,
  };
  const close = async () => {
    logger.info('Tearing down infrastructure...');
    for (const [name, fn] of [
      ['queue', () => queue.close()],
      ['rabbit', () => producer.close()],
      ['redis', () => redis.close()],
      ['database', () => dbClient.close()],
      ['posthog', () => posthog.close()],
    ] as const) {
      try {
        await fn();
      } catch (err) {
        logger.warn({ err }, `${name} close failed`);
      }
    }
  };
  return { ctx, close };
}

/** Run one script and return its result. Throws when the script is unknown or fails. */
export async function runScript(name: string, args: string[], ctx: ScriptContext): Promise<unknown> {
  const Factory = loadScript(name);
  logger.info(`Executing script: ${name}`);
  const result = await new Factory(ctx).execute(...args);
  if (result !== undefined && result !== null) logger.info(`Script result: ${JSON.stringify(result)}`);
  return result;
}

/** CLI: `<script> [args...]`. Exits 1 when the script fails. */
export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const [name, ...rest] = argv;
  if (!name) {
    console.error('usage: main.ts <script_name> [args...]');
    process.exit(2);
  }
  const args = rest.filter((arg) => arg !== '--');
  let teardown: (() => Promise<void>) | undefined;
  let code = 0;
  try {
    const { ctx, close } = await setupInfrastructure();
    teardown = close;
    await runScript(name, args, ctx);
  } catch (err) {
    logger.error({ err }, `Script execution failed: ${err}`);
    code = 1;
  } finally {
    await teardown?.();
    flushLogs();
  }
  process.exit(code);
}
