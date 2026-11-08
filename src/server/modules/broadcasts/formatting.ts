/**
 * Shared broadcast formatting helpers: entities to HTML and the broadcast keyboard registry. Port of
 * `core/services/broadcast_formatting.py`.
 *
 * Used by the admin composer, the bots' `/broadcast` flows and the scheduled promo template, so every path produces
 * identical output:
 *
 * - `entitiesToHtml(text, entities)`: a Telegram message's text + entity list (UTF-16 offsets) as the escaped HTML
 *   the send pipeline ships (parse_mode=HTML).
 * - `buildKeyboardMarkup(config, locale)`: a broadcast's inline keyboard from its stored config.
 * - `broadcastContent(data)`: a send-now / bot `/broadcast` payload as the content `send_content` sends.
 *
 * Keyboard registry: a module map plus `registerBroadcastKeyboard`, registered explicitly at startup. Core provides
 * `main` (a URL button that opens the app). Apps register their other types (e.g. `daily`). Builders receive
 * `(buttonText, locale)`; translate with `t(key, locale)`.
 */
import type { InlineKeyboardMarkup } from 'grammy/types';
import { settings } from '../../config';
import { InvalidBroadcastException } from '../../lib/errors';
import { t } from '../../lib/i18n';
import { getLogger } from '../../lib/logging';

const logger = getLogger('broadcast-formatting');

/** A Telegram message entity, as far as the conversion needs it. */
export interface TextEntity {
  type: string;
  offset: number;
  length: number;
  url?: string | null;
}

const escapeText = (value: string): string =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

const escapeAttr = (value: string): string => escapeText(value).replaceAll('"', '&quot;').replaceAll("'", '&#x27;');

/**
 * Wrap one entity's (already escaped) inner HTML in the tag of its type. `raw` is the entity's plain text (for the
 * mention / hashtag / url links). `null` for unsupported types: the caller keeps the inner HTML without a tag.
 */
function wrapEntity(type: string, innerHtml: string, raw: string, url: string | null | undefined): string | null {
  switch (type) {
    case 'bold':
      return `<b>${innerHtml}</b>`;
    case 'italic':
      return `<i>${innerHtml}</i>`;
    case 'code':
      return `<code>${innerHtml}</code>`;
    case 'pre':
      return `<pre>${innerHtml}</pre>`;
    case 'underline':
      return `<u>${innerHtml}</u>`;
    case 'strikethrough':
      return `<s>${innerHtml}</s>`;
    case 'text_link':
      return url ? `<a href="${escapeAttr(url)}">${innerHtml}</a>` : null;
    case 'spoiler':
      return `<span class="tg-spoiler">${innerHtml}</span>`;
    case 'mention':
      return `<a href="https://t.me/${escapeAttr(raw.slice(1))}">${innerHtml}</a>`;
    case 'hashtag':
      return `<a href="https://t.me/hashtag/${escapeAttr(raw.slice(1))}">${innerHtml}</a>`;
    case 'url':
      return `<a href="${escapeAttr(raw)}">${innerHtml}</a>`;
    default:
      return null;
  }
}

/**
 * HTML of `text[start:end]` (UTF-16 code units, which is what JS strings index by) with `entities` (sorted, all
 * starting at >= `start`). An entity's nested entities are the ones that start inside it; one that runs past its
 * parent's end is cut at that end (Telegram only nests, so that never happens in practice).
 */
function render(text: string, entities: TextEntity[], start: number, end: number): string {
  const out: string[] = [];
  let pos = start;
  let i = 0;
  while (i < entities.length) {
    const entity = entities[i] as TextEntity;
    const entityStart = Math.max(entity.offset, pos);
    const entityEnd = Math.min(entity.offset + entity.length, end);
    let j = i + 1;
    while (j < entities.length && (entities[j] as TextEntity).offset < entityEnd) j += 1;
    if (entityStart >= entityEnd) {
      // empty, out of range, or inside an entity already rendered
      i += 1;
      continue;
    }
    out.push(escapeText(text.slice(pos, entityStart)));
    const inner = render(text, entities.slice(i + 1, j), entityStart, entityEnd);
    const wrapped = wrapEntity(entity.type, inner, text.slice(entityStart, entityEnd), entity.url);
    out.push(wrapped ?? inner);
    pos = entityEnd;
    i = j;
  }
  out.push(escapeText(text.slice(pos, end)));
  return out.join('');
}

/**
 * Convert Telegram text + entities to the HTML used by the send pipeline (parse_mode=HTML). Offsets and lengths are
 * UTF-16 code units, as Telegram counts them (an emoji outside the BMP is two). Nested entities (bold around italic)
 * nest their tags. The text is HTML-escaped (`&`, `<`, `>`) and link targets also escape quotes, so a `<` typed in
 * the message can't break the parse.
 *
 * Without entities the text comes back unchanged: the bots only call this for a message that has entities, and the
 * web composer's `/format` preview sends text that is already HTML (tags the admin typed).
 */
export function entitiesToHtml(text: string | null | undefined, entities?: Iterable<TextEntity> | null): string {
  if (!text) return text ?? '';
  const all = [...(entities ?? [])];
  if (all.length === 0) return text;
  // An outer entity before the ones it holds.
  const ordered = all.sort((a, b) => a.offset - b.offset || b.length - a.length);
  return render(text, ordered, 0, text.length);
}

// Keyboard registry -------------------------------------------------------------------------------------------------

/** `(buttonText, locale) => markup`: one keyboard type of a broadcast. */
export type BroadcastKeyboardBuilder = (
  buttonText: string | null | undefined,
  locale: string | null | undefined,
) => InlineKeyboardMarkup | null;

/** The Mini App link the `main` button opens (one seam, so a test can point it elsewhere). */
let appUrl = (): string => settings.web.appUrl;

/** Replace where the `main` button's link comes from. Returns the previous provider. */
export function setBroadcastAppUrl(provider: () => string): () => string {
  const previous = appUrl;
  appUrl = provider;
  return previous;
}

/** `main`: one URL button that opens the app, labelled with the custom text (or "Open App"). */
export function openAppKeyboard(buttonText: string | null | undefined, locale: string | null | undefined) {
  return {
    inline_keyboard: [[{ text: buttonText || t('core.admin.broadcasts.open_app', locale), url: appUrl() }]],
  } satisfies InlineKeyboardMarkup;
}

const keyboards = new Map<string, BroadcastKeyboardBuilder>([['main', openAppKeyboard]]);

/**
 * Register (or replace) the builder for a broadcast `keyboardType`. Call from the app's startup; registering the same
 * type again replaces the builder, so a re-run of the startup code is harmless.
 */
export function registerBroadcastKeyboard(keyboardType: string, builder: BroadcastKeyboardBuilder): void {
  keyboards.set(keyboardType, builder);
}

/** The registry itself, for tests that need an isolated copy (`snapshot` / `restore`). */
export const broadcastKeyboards = {
  snapshot: (): Map<string, BroadcastKeyboardBuilder> => new Map(keyboards),
  restore(saved: Map<string, BroadcastKeyboardBuilder>): void {
    keyboards.clear();
    for (const [type, builder] of saved) keyboards.set(type, builder);
  },
  delete: (keyboardType: string): boolean => keyboards.delete(keyboardType),
};

/** A broadcast's stored keyboard config. */
export interface KeyboardConfig {
  keyboard_type?: string | null;
  keyboard_button_text?: string | null;
}

/**
 * Build a broadcast's inline keyboard from its stored config: `keyboard_type` is `none` / null (no keyboard), `main`
 * (open-app button, optionally with a custom `keyboard_button_text`) or any type an app registered.
 *
 * `null` when no keyboard should be attached, including for a type nobody registered (logged as a warning: the
 * message still goes out, without a button).
 */
export function buildKeyboardMarkup(
  config: KeyboardConfig | null | undefined,
  locale?: string | null,
): InlineKeyboardMarkup | null {
  if (!config) return null;
  const keyboardType = config.keyboard_type;
  if (!keyboardType || keyboardType === 'none') return null;
  const builder = keyboards.get(keyboardType);
  if (!builder) {
    logger.warn(`No broadcast keyboard registered for '${keyboardType}'; sending without a keyboard`);
    return null;
  }
  return builder(config.keyboard_button_text, locale);
}

// Send-now / bot payload to content -----------------------------------------------------------------------------------

const MEDIA_TYPES = new Set(['photo', 'video', 'animation', 'document']);

export type MediaMessageType = 'photo' | 'video' | 'animation' | 'document';

/** What `MessagesService.sendContent` sends (`get_content_for_sending()`'s shape). */
export type BroadcastContent =
  | { type: 'text'; text: string; parse_mode: 'HTML' | null }
  | {
      type: MediaMessageType;
      media_file_id: string;
      caption: string | null;
      parse_mode: 'HTML' | null;
      metadata?: Record<string, unknown>;
    };

/** The payload of `user_broadcast_job` (canonical keys plus the legacy ones of the bots' `/broadcast` flow). */
export interface BroadcastPayload extends KeyboardConfig {
  message_type?: string | null;
  message_text?: string | null;
  message_html?: string | null;
  has_text_formatting?: boolean | null;
  /** Legacy: `has_text_formatting`. */
  has_formatting?: boolean | null;
  media_file_id?: string | null;
  /** Legacy: `media_file_id`, for any media type. */
  photo_file_id?: string | null;
  caption?: string | null;
  caption_html?: string | null;
  has_caption_formatting?: boolean | null;
  media_metadata?: Record<string, unknown> | null;
  run_id?: string;
}

/**
 * Normalize a `user_broadcast_job` payload into the content `sendContent` sends, validating it on the way.
 *
 * Canonical keys (the `BroadcastSendNowRequest` content fields): `message_type` (default `text`), `message_text`,
 * `message_html`, `has_text_formatting`, `media_file_id`, `caption`, `caption_html`, `has_caption_formatting`, plus
 * `media_metadata`. Legacy keys of the bots' `/broadcast` flow and of jobs queued before: `has_formatting` (=
 * `has_text_formatting`) and `photo_file_id` (= `media_file_id`). The bot omits `message_html` / `caption_html` when
 * there's no formatting.
 *
 * Throws `InvalidBroadcastException` when there's nothing to send.
 */
export function broadcastContent(data: BroadcastPayload): BroadcastContent {
  const messageType = data.message_type || 'text';

  if (messageType === 'text') {
    const formatted = Boolean(data.has_text_formatting || data.has_formatting);
    const text = formatted ? data.message_html || data.message_text : data.message_text;
    if (!text) throw new InvalidBroadcastException('Text send-now requires message_text');
    return { type: 'text', text, parse_mode: formatted ? 'HTML' : null };
  }

  if (!MEDIA_TYPES.has(messageType)) throw new InvalidBroadcastException(`Unsupported message type: ${messageType}`);
  const fileId = data.media_file_id || data.photo_file_id;
  if (!fileId) throw new InvalidBroadcastException('Media send-now requires media_file_id');
  const formatted = Boolean(data.has_caption_formatting);
  const caption = formatted ? data.caption_html || data.caption : data.caption;
  return {
    type: messageType as MediaMessageType,
    media_file_id: fileId,
    caption: caption || null,
    parse_mode: formatted ? 'HTML' : null,
    metadata: data.media_metadata || {},
  };
}
