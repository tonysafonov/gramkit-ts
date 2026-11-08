/**
 * Broadcast formatting helpers: entities to HTML parity and the keyboard registry. Pure unit tests: no DB, no app.
 *
 * `entitiesToHtml` was extracted from the bot's inline `/broadcast` + `/promo` entity-to-HTML loop. The parity test
 * re-implements the bot's PREVIOUS logic and asserts byte-for-byte equality on the plain-ASCII cases it handled
 * right; that old loop didn't escape and broke nested entities, which the tests after it cover.
 */
import type { InlineKeyboardMarkup } from 'grammy/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InvalidBroadcastException } from '../../lib/errors';
import { t } from '../../lib/i18n';
import {
  type BroadcastKeyboardBuilder,
  type BroadcastPayload,
  broadcastContent,
  broadcastKeyboards,
  buildKeyboardMarkup,
  entitiesToHtml,
  registerBroadcastKeyboard,
  setBroadcastAppUrl,
  type TextEntity,
} from './formatting';

const APP_URL = 'https://t.me/test_bot/app';

let restoreAppUrl: () => string;
let savedKeyboards: Map<string, BroadcastKeyboardBuilder>;

beforeEach(() => {
  // The `main` button's link without depending on the environment's settings; an isolated registry (core's `main` only).
  restoreAppUrl = setBroadcastAppUrl(() => APP_URL);
  savedKeyboards = broadcastKeyboards.snapshot();
  broadcastKeyboards.delete('daily');
});

afterEach(() => {
  setBroadcastAppUrl(restoreAppUrl);
  broadcastKeyboards.restore(savedKeyboards);
});

const entity = (type: string, offset: number, length: number, url: string | null = null): TextEntity => ({
  type,
  offset,
  length,
  url,
});

/** The bot's ORIGINAL inline implementation (copied before extraction). */
function legacyEntitiesToHtml(text: string, entities: TextEntity[]): string {
  let messageHtml = text;
  for (const e of [...entities].sort((a, b) => b.offset - a.offset)) {
    const part = text.slice(e.offset, e.offset + e.length);
    let replacement: string;
    if (e.type === 'bold') replacement = `<b>${part}</b>`;
    else if (e.type === 'italic') replacement = `<i>${part}</i>`;
    else if (e.type === 'code') replacement = `<code>${part}</code>`;
    else if (e.type === 'pre') replacement = `<pre>${part}</pre>`;
    else if (e.type === 'underline') replacement = `<u>${part}</u>`;
    else if (e.type === 'strikethrough') replacement = `<s>${part}</s>`;
    else if (e.type === 'text_link' && e.url) replacement = `<a href="${e.url}">${part}</a>`;
    else if (e.type === 'spoiler') replacement = `<span class="tg-spoiler">${part}</span>`;
    else if (e.type === 'mention') replacement = `<a href="https://t.me/${part.slice(1)}">${part}</a>`;
    else if (e.type === 'hashtag') replacement = `<a href="https://t.me/hashtag/${part.slice(1)}">${part}</a>`;
    else if (e.type === 'url') replacement = `<a href="${part}">${part}</a>`;
    else continue;
    messageHtml = messageHtml.slice(0, e.offset) + replacement + messageHtml.slice(e.offset + e.length);
  }
  return messageHtml;
}

describe('entitiesToHtml parity with the bot loop', () => {
  it.each<[string, TextEntity[]]>([
    ['bold here', [entity('bold', 0, 4)]],
    ['italic word', [entity('italic', 0, 6)]],
    ['a code b', [entity('code', 2, 4)]],
    ['strike me', [entity('strikethrough', 0, 6)]],
    ['under here', [entity('underline', 0, 5)]],
    ['click link', [entity('text_link', 6, 4, 'https://x.io')]],
    ['@username here', [entity('mention', 0, 9)]],
    ['tag #news now', [entity('hashtag', 4, 5)]],
    ['visit https://t.me x', [entity('url', 6, 12)]],
    ['spoil this', [entity('spoiler', 0, 5)]],
    // Multiple, overlapping offsets (reverse processing must keep them stable).
    ['bold and italic', [entity('bold', 0, 4), entity('italic', 9, 6)]],
    // Unsupported entity type is skipped (no change).
    ['mystery type', [entity('custom_emoji', 0, 7)]],
  ])('matches the legacy output for %j', (text, entities) => {
    expect(entitiesToHtml(text, entities)).toBe(legacyEntitiesToHtml(text, entities));
  });

  it('empty text', () => {
    expect(entitiesToHtml('', null)).toBe('');
  });

  it('none entities passthrough', () => {
    expect(entitiesToHtml('plain text', null)).toBe('plain text');
  });

  it('known bold output', () => {
    expect(entitiesToHtml('hi there', [entity('bold', 0, 2)])).toBe('<b>hi</b> there');
  });
});

/** Telegram counts UTF-16 code units, which is also what a JS string indexes by. */
const utf16Len = (text: string): number => text.length;

describe('entitiesToHtml UTF-16', () => {
  it('astral emoji before the entity', () => {
    const text = '🔥🔥 Sale today';
    const offset = utf16Len('🔥🔥 ');
    expect(entitiesToHtml(text, [entity('bold', offset, 4)])).toBe('🔥🔥 <b>Sale</b> today');
  });

  it('astral emoji inside the entity', () => {
    const text = 'Go 🎉 now!';
    expect(entitiesToHtml(text, [entity('italic', 3, utf16Len('🎉 now'))])).toBe('Go <i>🎉 now</i>!');
  });

  it('cyrillic', () => {
    expect(entitiesToHtml('Привет, мир', [entity('bold', 8, 3)])).toBe('Привет, <b>мир</b>');
  });

  it('text link after an emoji', () => {
    const e = entity('text_link', utf16Len('🔥 '), 'Скидка'.length, 'https://x.io/a');
    expect(entitiesToHtml('🔥 Скидка дня', [e])).toBe('🔥 <a href="https://x.io/a">Скидка</a> дня');
  });

  it('nested bold and italic', () => {
    const entities = [entity('italic', 5, 3), entity('bold', 0, 15)];
    expect(entitiesToHtml('bold and italic', entities)).toBe('<b>bold <i>and</i> italic</b>');
  });

  it('same start nests the longer outside', () => {
    const text = '🌙 moon light';
    const entities = [entity('italic', 0, utf16Len('🌙 moon')), entity('bold', 0, utf16Len(text))];
    expect(entitiesToHtml(text, entities)).toBe('<b><i>🌙 moon</i> light</b>');
  });

  it('unsupported entity keeps the nested ones', () => {
    const text = '⭐ star';
    const entities = [entity('custom_emoji', 0, 1), entity('bold', 0, utf16Len(text))];
    expect(entitiesToHtml(text, entities)).toBe('<b>⭐ star</b>');
  });
});

describe('entitiesToHtml escaping', () => {
  it('text around and inside entities is escaped', () => {
    expect(entitiesToHtml('a < b & c > d', [entity('bold', 4, 5)])).toBe('a &lt; <b>b &amp; c</b> &gt; d');
  });

  it('text link url is attribute escaped', () => {
    const url = 'https://x.io/?a=1&b="2"<';
    expect(entitiesToHtml('click', [entity('text_link', 0, 5, url)])).toBe(
      '<a href="https://x.io/?a=1&amp;b=&quot;2&quot;&lt;">click</a>',
    );
  });

  it('url entity is escaped in href and text', () => {
    const text = 'see https://x.io/?a=1&b=2';
    expect(entitiesToHtml(text, [entity('url', 4, text.length - 4)])).toBe(
      'see <a href="https://x.io/?a=1&amp;b=2">https://x.io/?a=1&amp;b=2</a>',
    );
  });

  it('without entities text is returned as is', () => {
    // The web composer's preview sends HTML the admin typed, with no entities.
    expect(entitiesToHtml('<b>typed</b> & sent', null)).toBe('<b>typed</b> & sent');
  });
});

function onlyButton(markup: InlineKeyboardMarkup | null) {
  expect(markup).not.toBeNull();
  const rows = (markup as InlineKeyboardMarkup).inline_keyboard;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toHaveLength(1);
  return (rows[0] as InlineKeyboardMarkup['inline_keyboard'][number])[0] as { text: string; url?: string };
}

describe('keyboard registry', () => {
  it.each([null, {}, { keyboard_type: null }, { keyboard_type: 'none' }])('no keyboard for %j', (config) => {
    expect(buildKeyboardMarkup(config, 'en')).toBeNull();
  });

  it('main uses the custom text and opens the app', () => {
    const button = onlyButton(buildKeyboardMarkup({ keyboard_type: 'main', keyboard_button_text: 'Go!' }, 'en'));
    expect(button.text).toBe('Go!');
    expect(button.url).toBe(APP_URL);
  });

  it.each(['en', 'ru', null])('main without text has a localized fallback label (%s)', (locale) => {
    const button = onlyButton(buildKeyboardMarkup({ keyboard_type: 'main' }, locale));
    expect(button.text).toBe(t('core.admin.broadcasts.open_app', locale));
    expect(button.url).toBe(APP_URL);
  });

  it('the fallback label is translated', () => {
    expect(t('core.admin.broadcasts.open_app', 'en')).toBe('Open App');
    expect(t('core.admin.broadcasts.open_app', 'ru')).not.toBe('Open App');
  });

  it('an unregistered type sends no keyboard', () => {
    expect(buildKeyboardMarkup({ keyboard_type: 'daily' }, 'en')).toBeNull();
  });

  it('a registered builder gets text and locale', () => {
    const calls: [string | null | undefined, string | null | undefined][] = [];
    registerBroadcastKeyboard('daily', (buttonText, locale) => {
      calls.push([buttonText, locale]);
      return { inline_keyboard: [[{ text: `daily-${locale}`, url: 'https://example.com/daily' }]] };
    });

    const button = onlyButton(buildKeyboardMarkup({ keyboard_type: 'daily', keyboard_button_text: 'x' }, 'ru'));

    expect(calls).toEqual([['x', 'ru']]);
    expect(button.text).toBe('daily-ru');
  });

  it('registering again replaces the builder', () => {
    registerBroadcastKeyboard('daily', () => null);
    registerBroadcastKeyboard('daily', () => ({ inline_keyboard: [] }));
    expect(buildKeyboardMarkup({ keyboard_type: 'daily' }, 'en')).toEqual({ inline_keyboard: [] });
  });
});

describe('broadcastContent', () => {
  it('plain text', () => {
    expect(broadcastContent({ message_type: 'text', message_text: 'hi' })).toEqual({
      type: 'text',
      text: 'hi',
      parse_mode: null,
    });
  });

  it('formatted text uses the html', () => {
    const content = broadcastContent({
      message_type: 'text',
      message_text: 'hi',
      message_html: '<b>hi</b>',
      has_text_formatting: true,
    });
    expect(content).toEqual({ type: 'text', text: '<b>hi</b>', parse_mode: 'HTML' });
  });

  it("the bot's legacy text payload with only html", () => {
    // `has_formatting` and the HTML, no plain-text requirement.
    const content = broadcastContent({ message_type: 'text', message_html: '<b>Bold</b>', has_formatting: true });
    expect(content).toEqual({ type: 'text', text: '<b>Bold</b>', parse_mode: 'HTML' });
  });

  it('message type defaults to text', () => {
    expect(broadcastContent({ message_text: 'x' }).type).toBe('text');
  });

  it.each(['photo', 'video', 'animation', 'document'])('every media type: %s', (mediaType) => {
    const content = broadcastContent({
      message_type: mediaType,
      media_file_id: 'f1',
      caption: 'c',
      media_metadata: { w: 1 },
    });
    expect(content).toEqual({
      type: mediaType,
      media_file_id: 'f1',
      caption: 'c',
      parse_mode: null,
      metadata: { w: 1 },
    });
  });

  it('legacy photo_file_id and a formatted caption', () => {
    const content = broadcastContent({
      message_type: 'photo',
      photo_file_id: 'AgAC',
      caption: 'c',
      caption_html: '<i>c</i>',
      has_caption_formatting: true,
    });
    expect(content).toMatchObject({ media_file_id: 'AgAC', caption: '<i>c</i>', parse_mode: 'HTML' });
  });

  it.each<[BroadcastPayload, string]>([
    [{ message_type: 'text' }, 'Text send-now requires message_text'],
    [{ message_type: 'text', message_html: '<b>x</b>' }, 'Text send-now requires message_text'],
    [{ message_type: 'video', caption: 'c' }, 'Media send-now requires media_file_id'],
    [{ message_type: 'sticker', media_file_id: 'x' }, 'Unsupported message type: sticker'],
  ])('invalid payload %j raises', (data, message) => {
    expect(() => broadcastContent(data)).toThrow(InvalidBroadcastException);
    expect(() => broadcastContent(data)).toThrow(message);
  });
});
