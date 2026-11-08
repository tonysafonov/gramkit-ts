import { Bot, type Composer, type StorageAdapter, session, type Transformer } from 'grammy';
import { type Clients, getClients } from '../clients';
import { telegramRetry } from '../clients/bot';
import { settings } from '../config';
import type { Database } from '../db/client';
import type { ServicesClass } from '../env';
import { getLogger } from '../lib/logging';
import type { Repos } from '../repos';
import { Services } from '../services';
import type { BotContext, BotSession } from './context';
import { authMiddleware, databaseMiddleware, i18nMiddleware, servicesMiddleware } from './middlewares';
import { RedisSessionStorage } from './storage';

const logger = getLogger('bot');

export interface BotSetup {
  db: Database;
  /** Process clients; the bot uses their producer, redis and queue. */
  clients?: Pick<Clients, 'producer' | 'redis' | 'queue'>;
  composers: Composer<BotContext>[];
  servicesClass?: ServicesClass<Services, Repos>;
  /** Where the FSM state lives: Redis by default. */
  storage?: StorageAdapter<BotSession>;
}

/** Methods with a `parse_mode` parameter that HTML is the default for. */
const PARSE_MODE_METHODS = new Set([
  'sendMessage',
  'editMessageText',
  'sendPhoto',
  'sendVideo',
  'sendAnimation',
  'sendDocument',
  'sendAudio',
  'sendVoice',
  'editMessageCaption',
  'copyMessage',
]);

/** HTML is the default parse mode of this bot's messages; a call can still pass its own or `undefined`. */
const defaultHtml: Transformer = (prev, method, payload, signal) =>
  prev(method, PARSE_MODE_METHODS.has(method) ? { parse_mode: 'HTML', ...payload } : payload, signal);

/** The bot of the bot process: grammY's `Bot` with retries and `parse_mode: HTML`. */
export function createBot(token: string = settings.bot.token): Bot<BotContext> {
  const bot = new Bot<BotContext>(token);
  bot.api.config.use(telegramRetry(), defaultHtml);
  return bot;
}

/**
 * The middleware chain, in the order that matters: Database, Services, Auth, I18n, then the FSM session and the
 * composers. Each update gets its own transaction, services and request context.
 */
export function setupBot(bot: Bot<BotContext>, setup: BotSetup): Bot<BotContext> {
  const { producer, redis, queue } = setup.clients ?? getClients();
  const botId = bot.token.split(':')[0] ?? '';

  bot.use(databaseMiddleware(setup.db));
  bot.use(servicesMiddleware(setup.servicesClass ?? Services, { bot, producer, redis, queue }));
  bot.use(authMiddleware());
  bot.use(i18nMiddleware());
  bot.use(
    session({
      initial: (): BotSession => ({ data: {} }),
      getSessionKey: (ctx) => (ctx.chat && ctx.from ? `${ctx.chat.id}:${ctx.from.id}` : undefined),
      storage: setup.storage ?? new RedisSessionStorage(redis, botId),
    }),
  );
  for (const composer of setup.composers) bot.use(composer);

  // An update that throws is logged and dropped; the polling loop goes on, as aiogram's dispatcher does
  bot.catch((err) => logger.error({ err: err.error }, `Update ${err.ctx.update.update_id} failed: ${err.error}`));
  return bot;
}
