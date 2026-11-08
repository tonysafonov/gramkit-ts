/**
 * Admin notifications: Telegram-HTML formatting helpers + a sender that never drops an alert.
 *
 * Every admin message is Telegram HTML (`parse_mode: "HTML"`). Anything that comes from users, products or exceptions
 * MUST go through `esc()`: a stray `<` makes Telegram reject the whole message.
 *
 * A message may also carry a Rich Message body (Bot API 10.1 `sendRichMessage`, "Rich HTML": tables, `<details>`,
 * `<footer>`). Delivery degrades step by step so formatting can never cost us an alert:
 *
 *     richHtml  --rejected-->  text as HTML  --rejected-->  text as plain (tags stripped)
 */
import { type Bot, GrammyError } from 'grammy';
import { getSharedBot } from '../../clients/bot';
import { settings } from '../../config';
import { getLogger } from '../../lib/logging';

const logger = getLogger('admin-messages');

const CURRENCY_SYMBOLS: Record<string, string> = { RUB: '₽', USD: '$', EUR: '€', XTR: '⭐' };
export const NBSP = ' '; // narrow no-break space: thousands separator that won't wrap

/** Classic messages are capped at 4096 chars; keep long user lists well under it. */
export const MAX_LIST_LINES = 25;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Escape a value for Telegram HTML (text and attribute context), as Python's `html.escape(quote=True)`. */
export function esc(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#x27;');
}

export function fmtInt(value: number): string {
  return Math.trunc(value).toLocaleString('en-US').replaceAll(',', NBSP);
}

export function fmtMoney(amount: number, currency: string): string {
  const symbol = CURRENCY_SYMBOLS[currency] ?? currency;
  const number = Number.isInteger(amount)
    ? fmtInt(amount)
    : amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replaceAll(',', NBSP);
  return `${number}${NBSP}${symbol}`;
}

/** Per-currency amounts, largest first. Currencies are never summed together. */
export function fmtMoneyMap(amounts: Record<string, number>, empty = '0'): string {
  const parts = Object.entries(amounts)
    .sort(([, a], [, b]) => b - a)
    .filter(([, v]) => v)
    .map(([c, v]) => fmtMoney(v, c));
  return parts.length ? parts.join(' + ') : empty;
}

/** '25 Sep' (or '25 Sep 2027' outside the current year). */
export function fmtDate(value: Date): string {
  const day = value.getUTCDate();
  const month = value.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  const text = `${day} ${month}`;
  return value.getUTCFullYear() === new Date().getUTCFullYear() ? text : `${text} ${value.getUTCFullYear()}`;
}

export function fmtAgo(value: Date | null | undefined): string {
  if (!value) return '?';
  const seconds = (Date.now() - value.getTime()) / 1000;
  if (seconds < 3600) return `${Math.max(Math.floor(seconds / 60), 0)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

/** '▲12%' / '▼5%' / '=' / 'new': compact change vs the previous period. */
export function fmtDelta(current: number, previous: number): string {
  if (previous === 0) return current ? 'new' : '=';
  const change = ((current - previous) / previous) * 100;
  if (Math.abs(change) < 0.5) return '=';
  return `${change > 0 ? '▲' : '▼'}${Math.abs(change).toFixed(0)}%`;
}

/** What `userRef` and `userTag` read: a user row (or `UserSchema`) with whichever fields it has. */
export interface UserLike {
  tgUsername?: string | null;
  username?: string | null;
  displayName?: string | null;
  tgFirstName?: string | null;
  telegramId?: number | null;
  id?: string | null;
}

/**
 * Tappable mention for a user, HTML-escaped. Falls back through tg handle, app username, name, short id, so users
 * without a Telegram @username don't render as `@null`.
 */
export function userRef(user: UserLike): string {
  const handle = user.tgUsername || user.username;
  const label = handle
    ? `@${handle}`
    : user.displayName || user.tgFirstName || `user ${String(user.id ?? '?').slice(0, 8)}`;
  if (user.telegramId) return `<a href="tg://user?id=${Math.trunc(user.telegramId)}">${esc(label)}</a>`;
  return esc(label);
}

/**
 * '#purchase #u_anna': tappable in Telegram (tap = search this chat for the tag). Hashtags allow only letters,
 * digits and '_', so anything else becomes '_'. Convention: put the tag line last; event tag first, then user tags;
 * '#critical' on alerts.
 */
export function tags(...names: (string | null | undefined)[]): string {
  return names
    .filter((name): name is string => !!name)
    .map((name) => `#${name.replace(/\W/gu, '_')}`)
    .join(' ');
}

/** 'u_anna': per-user tag name (pass to `tags`) so one tap shows a user's whole history. */
export function userTag(user: UserLike): string {
  const handle = user.tgUsername || user.username;
  return handle
    ? `u_${handle}`
    : `u_${String(user.id ?? '')
        .replaceAll('-', '')
        .slice(0, 8)}`;
}

/** '• line' per item, truncated with a '…and N more' tail. */
export function bulletList(lines: Iterable<string>, limit = MAX_LIST_LINES): string {
  const all = [...lines];
  const shown = all.slice(0, limit).map((line) => `• ${line}`);
  if (all.length > limit) shown.push(`<i>…and ${all.length - limit} more</i>`);
  return shown.join('\n');
}

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function unescapeHtml(text: string): string {
  return text.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number(body.slice(1));
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body] ?? whole;
  });
}

/** Last-resort fallback: strip tags and unescape entities. */
export function htmlToPlain(text: string): string {
  return unescapeHtml(text.replace(/<br\s*\/?>/g, '\n').replace(/<[^>]+>/g, ''));
}

async function deliver(
  bot: Bot,
  chatId: number,
  text: string,
  richHtml: string | null,
  silent: boolean,
): Promise<void> {
  if (richHtml) {
    try {
      await bot.api.sendRichMessage(chatId, { html: richHtml }, { disable_notification: silent });
      return;
    } catch (err) {
      if (!(err instanceof GrammyError)) throw err;
      logger.warn(`Rich admin message rejected for ${chatId}, falling back to HTML: ${err.message}`);
    }
  }
  try {
    await bot.api.sendMessage(chatId, text, { parse_mode: 'HTML', disable_notification: silent });
  } catch (err) {
    if (!(err instanceof GrammyError) || err.error_code !== 400) throw err;
    logger.warn(`HTML admin message rejected for ${chatId}, falling back to plain text: ${err.message}`);
    await bot.api.sendMessage(chatId, htmlToPlain(text), { parse_mode: undefined, disable_notification: silent });
  }
}

export interface AdminMessageOptions {
  /** A Rich Message body; `text` is its fallback. */
  richHtml?: string | null;
  /** Deliver without a notification sound (routine / informational messages). */
  silent?: boolean;
  /** Default: all owners. */
  chatIds?: Iterable<number> | null;
}

/**
 * Send an admin message to `chatIds` (default: all owners). Returns the delivered count. `text` is Telegram HTML and
 * is always required: it is the fallback for `richHtml`.
 */
export async function sendAdminMessage(bot: Bot, text: string, options: AdminMessageOptions = {}): Promise<number> {
  const { richHtml = null, silent = false, chatIds = null } = options;
  const targets = chatIds ? [...chatIds] : [...settings.rbac.ownerIds];
  let sent = 0;
  for (const chatId of targets) {
    try {
      await deliver(bot, chatId, text, richHtml, silent);
      sent += 1;
    } catch (err) {
      logger.error({ err }, `Failed to send admin message to ${chatId}: ${err}`);
    }
    await sleep(50);
  }
  return sent;
}

/**
 * '🚀 myapp 1.2.0 · worker started' to the owners, silently, when a process starts in prod.
 *
 * One per process (webhook / worker / bot) on each deploy: all of them showing the new version means the rollout
 * finished; the same one repeating means a restart loop. Skipped in debug: local hot reload restarts on every save.
 * Never throws: startup must not depend on Telegram.
 */
export async function announceStart(service: string, version: string, bot: Bot | null = null): Promise<void> {
  if (settings.debug) return;
  try {
    const text =
      `🚀 <b>${esc(settings.appName)} ${esc(version)}</b> · ${esc(service)} started` +
      ` <i>(${esc(settings.observability.environment)})</i>\n${tags('deploy')}`;
    await sendAdminMessage(bot ?? getSharedBot(), text, { silent: true });
  } catch (err) {
    logger.error({ err }, `Failed to announce ${service} start: ${err}`);
  }
}

/**
 * Send an alert to the owners, with sound, from code that has no bot at hand (e.g. a failed payment webhook). Uses
 * the process-wide fallback bot (`getSharedBot`), not a new client per alert. Skipped in debug (local runs and tests
 * would message the real owners). Never throws.
 */
export async function alertOwners(text: string): Promise<void> {
  if (settings.debug) return;
  try {
    await sendAdminMessage(getSharedBot(), text);
  } catch (err) {
    logger.error({ err }, `Failed to alert owners: ${err}`);
  }
}
