/**
 * The process's grammY bots. `new Bot()` makes no request, but a bot is still built once per process, never per
 * request, so retries and defaults live in one place.
 *
 * - `getBot()`: the bot of this process, `parse_mode: Markdown` by default. `null` without `BOT__TOKEN`.
 * - `getSharedBot()`: for code with no bot at hand (scripts, alerts). No default parse mode: callers pass their own.
 */
import { Bot, HttpError, type Transformer } from 'grammy';
import { settings } from '../config';
import { getLogger } from '../lib/logging';

const logger = getLogger('telegram');

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface RetryOptions {
  attempts?: number;
  baseDelay?: number;
  maxRetryAfter?: number;
}

/**
 * Retries for Bot API requests.
 *
 * Retried: network errors and Telegram 5xx, `attempts` tries in total, waiting `baseDelay` seconds, then twice that;
 * a flood limit (429) Telegram asks to wait at most `maxRetryAfter` seconds for. Longer waits go to the caller, so a
 * request is never held for minutes here.
 *
 * Not retried: client errors (they won't change) and `getUpdates` (the polling loop has its own backoff). A timed-out
 * send may still have reached Telegram, so a retry can, rarely, deliver a message twice.
 */
export function telegramRetry({ attempts = 3, baseDelay = 1, maxRetryAfter = 30 }: RetryOptions = {}): Transformer {
  return async (prev, method, payload, signal) => {
    if (method === 'getUpdates') return prev(method, payload, signal);

    for (let attempt = 1; ; attempt++) {
      let delay: number;
      try {
        const result = await prev(method, payload, signal);
        if (result.ok) return result;
        const retryAfter = result.parameters?.retry_after;
        const isFlood = result.error_code === 429 && retryAfter !== undefined;
        if (attempt === attempts) return result;
        if (isFlood && retryAfter <= maxRetryAfter) delay = retryAfter;
        else if (result.error_code >= 500) delay = baseDelay * 2 ** (attempt - 1);
        else return result;
        logger.warn(`Telegram ${method} failed (attempt ${attempt}/${attempts}): ${result.description}`);
      } catch (err) {
        if (!(err instanceof HttpError) || attempt === attempts) throw err;
        delay = baseDelay * 2 ** (attempt - 1);
        logger.warn(`Telegram ${method} failed (attempt ${attempt}/${attempts}): ${err.message}`);
      }
      await sleep(delay * 1000);
    }
  };
}

/** Methods with a `parse_mode` parameter: aiogram's `DefaultBotProperties(parse_mode=...)` covers these. */
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

const defaultParseMode =
  (parseMode: string): Transformer =>
  (prev, method, payload, signal) => {
    const withDefault = PARSE_MODE_METHODS.has(method) ? { parse_mode: parseMode, ...payload } : payload;
    return prev(method, withDefault, signal);
  };

let bot: Bot | null | undefined;
let sharedBot: Bot | undefined;

export function getBot(): Bot | null {
  if (bot === undefined) {
    const { token } = settings.bot;
    bot = token ? new Bot(token) : null;
    bot?.api.config.use(telegramRetry(), defaultParseMode('Markdown'));
  }
  return bot;
}

export function getSharedBot(): Bot {
  if (!sharedBot) {
    sharedBot = new Bot(settings.bot.token);
    sharedBot.api.config.use(telegramRetry());
  }
  return sharedBot;
}
