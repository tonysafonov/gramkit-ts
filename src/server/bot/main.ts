/**
 * The bot process: Python's `app/tgbot/bot.py`. Long polling by default; with `BOT__WEBHOOK_URL` set it registers a
 * webhook and serves it on `BOT__WEBHOOK_PORT` (default 8081) at the URL's path, for deployments that want Telegram
 * to push updates. `BOT__WEBHOOK_SECRET` is Telegram's `secret_token`, checked on every request: `config.ts` refuses a
 * webhook URL without one, which would take forged updates from anyone who can reach the port.
 *
 *     bun src/server/bot/main.ts        # dev
 *     node dist/bot.node.js             # prod
 */
import { createServer, type Server } from 'node:http';
import { webhookCallback } from 'grammy';
import pkg from '../../../package.json';
import { closeClients, getClients, posthog } from '../clients';
import { initSentry } from '../clients/sentry';
import { settings } from '../config';
import { createDb } from '../db/client';
import { flushLogs, getLogger } from '../lib/logging';
import { setupRegistries } from '../registries';
import { onShutdownSignal } from '../runtime/supervisor';
import { createComposers } from './handlers';
import { createBot, setupBot } from './setup';

const logger = getLogger('bot');

async function notifyOwners(bot: ReturnType<typeof createBot>): Promise<void> {
  for (const ownerId of settings.rbac.ownerIds) {
    try {
      await bot.api.sendMessage(ownerId, `${settings.appName} has been started`);
    } catch (err) {
      logger.warn({ err }, `Could not send startup message to owner ${ownerId}: ${err}`);
    }
  }
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, resolve);
  });
}

export async function main(): Promise<void> {
  logger.info('Starting bot');
  initSentry(pkg.version);
  posthog.setup(settings.observability.posthogApiKey, settings.observability.posthogHost, pkg.version);
  setupRegistries();

  const db = createDb();
  const bot = setupBot(createBot(), { db: db.db, clients: getClients(), composers: createComposers() });

  let server: Server | undefined;
  const { webhookUrl, webhookPort, webhookSecret } = settings.bot;

  onShutdownSignal(async () => {
    logger.info('Shutting down');
    if (server) await new Promise((resolve) => server?.close(resolve));
    else await bot.stop();
    await closeClients();
    await db.close();
    flushLogs();
  });

  await bot.init();
  await notifyOwners(bot);

  if (webhookUrl) {
    const handle = webhookCallback(bot, 'http', { secretToken: webhookSecret });
    const path = new URL(webhookUrl).pathname;
    server = createServer((req, res) => {
      if (req.method !== 'POST' || req.url !== path) {
        res.writeHead(404).end();
        return;
      }
      handle(req, res).catch((err) => {
        logger.error({ err }, 'Webhook handler failed');
        if (!res.headersSent) res.writeHead(500).end();
      });
    });
    await listen(server, webhookPort);
    await bot.api.setWebhook(webhookUrl, { secret_token: webhookSecret });
    logger.info(`Webhook set: ${webhookUrl}`);
  } else {
    logger.info('Starting polling');
    // Resolves when polling stops
    await bot.start();
  }
}

main().catch((err) => {
  logger.error({ err }, `An error occurred: ${err}`);
  flushLogs();
  process.exit(1);
});
