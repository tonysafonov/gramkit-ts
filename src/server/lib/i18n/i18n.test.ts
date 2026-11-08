import { describe, expect, it } from 'vitest';
import { runWithRequestContext } from '../request-context';
import { getTranslation, i18n, supportedLocale, t } from '.';

describe('i18n', () => {
  it('resolves a locale we have', () => {
    expect(supportedLocale('ru-RU')).toBe('ru');
    expect(supportedLocale('RU')).toBe('ru');
    expect(supportedLocale('uk')).toBe('en');
    expect(supportedLocale(null)).toBe('en');
  });

  it('returns the key when there is no translation', () => {
    expect(getTranslation('no.such.key', 'en')).toBe('no.such.key');
    expect(getTranslation('no.such.key', 'xx')).toBe('no.such.key');
  });

  it('merges app strings over core strings, both languages', () => {
    expect(t('app.menu', 'en')).toContain('template bot');
    expect(t('app.menu', 'ru')).not.toBe('app.menu');
    expect(t('app.menu', 'ru')).not.toBe(t('app.menu', 'en'));
  });

  it('interpolates variables, and keeps the template when one is missing', () => {
    const key = 'demo.notification.message';

    expect(t(key, 'en', { delay_seconds: 5 })).toContain('5 seconds');
    expect(t(key, 'en', {})).toContain('{delay_seconds}');
  });

  it('keeps a request locale to that request', async () => {
    const seen = await Promise.all(
      ['ru', 'en'].map((locale) =>
        runWithRequestContext({ requestId: locale }, async () => {
          i18n.updateLocale(locale);
          await new Promise((resolve) => setTimeout(resolve, 5));
          return i18n('app.menu');
        }),
      ),
    );

    expect(seen).toEqual([t('app.menu', 'ru'), t('app.menu', 'en')]);
  });

  it('needs a locale from somewhere', () => {
    expect(() => i18n('app.menu')).toThrow('Translation function not set');
    expect(i18n('app.menu', { locale: 'en' })).toBe(t('app.menu', 'en'));
  });
});
