/**
 * This app's entries in the shared registries. Port of template-vue's `tests/business/test_broadcast_keyboards.py`:
 * the admin preview, send-now, the bot's `/broadcast` and the scheduled slot all build the keyboard through
 * `buildKeyboardMarkup`, so they show the same localized button.
 */
import type { InlineKeyboardMarkup } from 'grammy/types';
import { afterAll, describe, expect, it } from 'vitest';
import { createAppApi } from './api';
import { dailyNotificationKeyboard } from './bot/keyboards';
import { settings } from './config';
import { t } from './lib/i18n';
import { runWithRequestContext } from './lib/request-context';
import { buildKeyboardMarkup } from './modules/broadcasts/formatting';

const button = (markup: InlineKeyboardMarkup | null) => {
  const [[only] = []] = markup?.inline_keyboard ?? [];
  if (!only) throw new Error('no button');
  return only as { text: string; url?: string };
};

describe('broadcast keyboards', () => {
  const unregistered = buildKeyboardMarkup({ keyboard_type: 'daily' }, 'en');
  const api = createAppApi();
  afterAll(() => api.state.db.close());

  it('building the API registers them', () => {
    expect(unregistered).toBeNull();
    expect(buildKeyboardMarkup({ keyboard_type: 'daily' }, 'en')).not.toBeNull();
  });

  it.each(['en', 'ru'])('daily is registered and localized: %s', (locale) => {
    const markup = buildKeyboardMarkup({ keyboard_type: 'daily' }, locale);

    expect(markup).toEqual(dailyNotificationKeyboard(locale));
    expect(button(markup).text).toBe(t('app.open_app_button', locale));
    expect(button(markup).url).toBe(`${settings.web.appUrl}?startapp=r-dailynotification`);
  });

  it('daily ignores the language of the request around it', () => {
    const markup = runWithRequestContext({ requestId: 'x', locale: 'en' }, () =>
      buildKeyboardMarkup({ keyboard_type: 'daily' }, 'ru'),
    );

    expect(button(markup).text).toBe(t('app.open_app_button', 'ru'));
  });

  it('main opens the app with the custom text', () => {
    const markup = buildKeyboardMarkup({ keyboard_type: 'main', keyboard_button_text: 'Go' }, 'en');

    expect([button(markup).text, button(markup).url]).toEqual(['Go', settings.web.appUrl]);
  });
});
