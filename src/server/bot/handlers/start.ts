import { Composer, type InlineKeyboard } from 'grammy';
import { posthog } from '../../clients/posthog';
import { i18n } from '../../lib/i18n';
import type { BotContext } from '../context';

export interface MenuOptions {
  /** i18n key of the menu text. */
  menuI18nKey?: string;
  keyboardFactory?: () => InlineKeyboard;
}

export interface StartOptions extends MenuOptions {
  /** Custom referral logic instead of `services.users.processReferal`. */
  referralProcessor?: (referralCode: string, userId: string) => Promise<void>;
  posthogEvent?: string;
}

export interface RefOptions {
  /** Base bot URL, e.g. `https://t.me/mybot`. */
  botUrl: string;
  webAppPath?: string;
  referralPrefix?: string;
}

/** Send the menu message to the chat of the update. */
export async function sendMenu(ctx: BotContext, { menuI18nKey = 'tarot.menu', keyboardFactory }: MenuOptions = {}) {
  const text = i18n(menuI18nKey);
  await ctx.reply(text, { reply_markup: keyboardFactory?.() });
}

/**
 * `/start [code]`: analytics, referral or invite code, then the menu.
 *
 * `/start r-123456` has the code `r-123456`. The app's own link codes (`services.internalReferalIds`: notification and
 * broadcast buttons) are never stored as an acquisition source, the same rule `StartService` applies to the Mini
 * App's `?startapp=r-<code>`.
 */
export async function startCommand(
  ctx: BotContext,
  args: string | null,
  { posthogEvent = 'bot_command_start', referralProcessor, ...menu }: StartOptions = {},
) {
  const { user, services } = ctx;
  if (!user) return;

  posthog.capture(String(user.telegramId ?? user.id), posthogEvent, {
    user_id: user.id,
    telegram_id: user.telegramId,
    referral_code: args,
    username: ctx.from?.username,
    language: ctx.from?.language_code,
  });

  // /start after a block means the bot can write again (see users.bot_blocked_at)
  if (user.botBlockedAt !== null) await services.users.clearBotBlocked(user.id);

  let referralCode = args;
  if (referralCode && services.internalReferalIds.has(referralCode)) {
    referralCode = null; // the app's own link brought an existing user back: not acquisition
  }
  if (referralCode) {
    if (referralCode.startsWith('i_')) {
      await services.invites.processInvite(referralCode.slice(2), user.id);
    } else if (referralProcessor) {
      await referralProcessor(referralCode, user.id);
    } else {
      await services.users.processReferal(referralCode, user.id);
    }
  }

  await sendMenu(ctx, menu);
}

/** `/ref [code]`: the bot and Mini App links, with the referral code when given. */
export async function refCommand(
  ctx: BotContext,
  args: string | null,
  { botUrl, webAppPath = '/app', referralPrefix = 'r-' }: RefOptions,
) {
  let botLink = botUrl;
  let appLink = `${botUrl}${webAppPath}`;

  if (args) {
    // The bot stores its /start payload as is, while the app strips the prefix from startapp: the bot link carries
    // the bare code and both record the same one.
    botLink = `${botLink}?start=${args}`;
    appLink = `${appLink}?startapp=${referralPrefix}${args}`;
  }

  await ctx.reply(`${botLink}\n\n${appLink}`, { link_preview_options: { is_disabled: true } });
}

/** A start composer configured for one app. */
export function createStartComposer(start: StartOptions, ref: RefOptions): Composer<BotContext> {
  const composer = new Composer<BotContext>();
  composer.command('start', (ctx) => startCommand(ctx, ctx.match || null, start));
  composer.command('ref', (ctx) => refCommand(ctx, ctx.match || null, ref));
  return composer;
}
