import type { MessageEntity } from 'grammy/types';

/**
 * Convert Telegram message entities to HTML, keeping bold, italic, code, links and so on. Returns `text` as it is
 * without entities. Offsets are UTF-16 code units, which is how JS strings are indexed too.
 *
 * Entities are replaced from the end to the beginning so earlier offsets stay valid.
 */
export function formatMessageEntities(text: string, entities: MessageEntity[] | null | undefined): string {
  if (!entities?.length) return text;

  let formatted = text;
  for (const entity of [...entities].sort((a, b) => b.offset - a.offset)) {
    const part = text.slice(entity.offset, entity.offset + entity.length);
    formatted = formatted.slice(0, entity.offset) + wrap(entity, part) + formatted.slice(entity.offset + entity.length);
  }
  return formatted;
}

function wrap(entity: MessageEntity, part: string): string {
  switch (entity.type) {
    case 'bold':
      return `<b>${part}</b>`;
    case 'italic':
      return `<i>${part}</i>`;
    case 'code':
      return `<code>${part}</code>`;
    case 'pre':
      return `<pre>${part}</pre>`;
    case 'underline':
      return `<u>${part}</u>`;
    case 'strikethrough':
      return `<s>${part}</s>`;
    case 'text_link':
      return entity.url ? `<a href="${entity.url}">${part}</a>` : part;
    case 'url':
      return `<a href="${part}">${part}</a>`;
    case 'mention':
      return `<a href="https://t.me/${part.replace(/^@/, '')}">${part}</a>`;
    case 'hashtag':
      return `<a href="https://t.me/hashtag/${part.replace(/^#/, '')}">${part}</a>`;
    case 'spoiler':
      return `<span class="tg-spoiler">${part}</span>`;
    default:
      return part;
  }
}
