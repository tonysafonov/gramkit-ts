import { InlineKeyboard } from 'grammy';
import { settings } from '../config';
import { i18n, t } from '../lib/i18n';
import { registerBroadcastKeyboard } from '../modules/broadcasts/formatting';

/** The open-app button under the bot's menu. */
export function commandKeyboard(): InlineKeyboard {
  return new InlineKeyboard().webApp(i18n('app.open_app_button'), settings.web.frontendUrl);
}

/** A notification keyboard with one button that opens the Mini App with `startapp`. */
export function createNotificationKeyboard(key: string, startappParam: string, locale?: string | null): InlineKeyboard {
  // With a locale, translate into it: `i18n(key, locale)` ignores the locale whenever the request has one set
  // (a webhook request sets one, e.g. for a preview).
  const text = locale ? t(key, locale) : i18n(key);
  return new InlineKeyboard().url(text, `${settings.web.appUrl}?startapp=${startappParam}`);
}

/** Example notification keyboard. */
export const dailyNotificationKeyboard = (locale?: string | null): InlineKeyboard =>
  createNotificationKeyboard('app.open_app_button', 'r-dailynotification', locale);

/**
 * Register this app's broadcast keyboard types with the broadcast formatter (call at startup). `daily`: the open-app
 * button with the daily-notification link. Add your own types here.
 */
export function registerBroadcastKeyboards(): void {
  registerBroadcastKeyboard('daily', (_buttonText, locale) => dailyNotificationKeyboard(locale));
}
