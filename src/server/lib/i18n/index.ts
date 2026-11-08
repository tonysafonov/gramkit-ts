/**
 * Translations by namespaced key, core strings with the app's merged over them (the app wins).
 *
 *     t('core.user.welcome', 'ru');            // a known locale
 *     t('myapp.welcome_back', 'en', { name });  // with `{name}` interpolation
 *     i18n('core.user.welcome');                // the current request's locale
 *
 * The language of a request lives on the request context: `i18n.setUserLocale(user)` or `i18n.updateLocale(locale)`.
 */
import { getRequestContext } from '../request-context';
import appEn from './locales/app.en.json';
import appRu from './locales/app.ru.json';
import coreEn from './locales/core.en.json';
import coreRu from './locales/core.ru.json';

type Translations = { [key: string]: string | Translations };

function deepMerge(base: Translations, overlay: Translations): Translations {
  const result = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const existing = result[key];
    result[key] = typeof existing === 'object' && typeof value === 'object' ? deepMerge(existing, value) : value;
  }
  return result;
}

const translations: Record<string, Translations> = {
  en: deepMerge(coreEn, appEn),
  ru: deepMerge(coreRu, appRu),
};

/** A locale we have translations for: `ru-RU` → `ru`; anything unknown (`uk`, `de`...) → `en`. */
export function supportedLocale(language: string | null | undefined): string {
  const code = (language ?? '').toLowerCase();
  for (const candidate of [code, code.split('-')[0] ?? '']) {
    if (candidate in translations) return candidate;
  }
  return 'en';
}

/** The translation of a namespaced key, or the key itself when there is none. */
export function getTranslation(key: string, locale = 'en'): string {
  let value: string | Translations | undefined = translations[locale] ?? {};
  for (const part of key.split('.')) {
    if (typeof value !== 'object') return key;
    value = value[part] ?? key;
  }
  return typeof value === 'string' ? value : key;
}

/** `{name}` placeholders, like Python's `str.format`: a template with a missing variable stays as it is. */
function format(template: string, vars: Record<string, unknown>): string {
  const names = template.match(/\{(\w+)\}/g) ?? [];
  if (names.some((name) => !(name.slice(1, -1) in vars))) return template;
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name]));
}

export function t(key: string, locale?: string | null, vars?: Record<string, unknown>): string {
  const translation = getTranslation(key, locale ?? 'en');
  return vars ? format(translation, vars) : translation;
}

interface LocaleSource {
  languageCode?: string | null;
  tgLanguageCode?: string | null;
}

function translate(key: string, options?: { locale?: string; vars?: Record<string, unknown> }): string {
  const locale = getRequestContext()?.locale ?? options?.locale;
  if (!locale) throw new Error('Translation function not set');
  return t(key, locale, options?.vars);
}

/** Translate with the current request's language. */
export const i18n = Object.assign(translate, {
  updateLocale(locale: string): void {
    const ctx = getRequestContext();
    if (ctx) ctx.locale = locale;
  },

  setUserLocale(user: LocaleSource | null | undefined): void {
    i18n.updateLocale(user?.languageCode || user?.tgLanguageCode || 'en');
  },
});
