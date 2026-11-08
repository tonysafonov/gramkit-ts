import type { Composer } from 'grammy';
import { settings } from '../../config';
import { authComposer } from '../../modules/auth/bot';
import { paymentsComposer } from '../../modules/payments/bot';
import { telegramLinkComposer } from '../../modules/telegram-link/bot';
import type { BotContext } from '../context';
import { commandKeyboard } from '../keyboards';
import { coreAdminComposer } from './admin';
import { appAdminComposer } from './app-admin';
import { createStartComposer } from './start';

/**
 * The composers, in the order they are registered: the first one that handles an update wins. `authComposer` and
 * `telegramLinkComposer` MUST come before the start composer to catch `/start auth_<token>` and `/start link_<token>`.
 */
export function createComposers(): Composer<BotContext>[] {
  return [
    authComposer,
    telegramLinkComposer,
    createStartComposer(
      { menuI18nKey: 'app.menu', keyboardFactory: commandKeyboard, posthogEvent: 'bot_command_start' },
      { botUrl: settings.bot.url, webAppPath: '/app', referralPrefix: 'r-' },
    ),
    appAdminComposer,
    coreAdminComposer, // core admin commands (/backup, /stats)
    paymentsComposer,
  ];
}
