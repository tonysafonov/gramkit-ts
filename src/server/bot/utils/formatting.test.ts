import { describe, expect, it } from 'vitest';
import { formatMessageEntities } from './formatting';

describe('formatMessageEntities', () => {
  it('returns the text as it is without entities', () => {
    expect(formatMessageEntities('Hello', undefined)).toBe('Hello');
    expect(formatMessageEntities('Hello', [])).toBe('Hello');
  });

  it('wraps bold', () => {
    expect(formatMessageEntities('Hello world', [{ type: 'bold', offset: 0, length: 5 }])).toBe('<b>Hello</b> world');
  });

  it('keeps offsets valid with several entities', () => {
    const entities = [
      { type: 'bold' as const, offset: 0, length: 5 },
      { type: 'italic' as const, offset: 6, length: 5 },
      { type: 'code' as const, offset: 12, length: 4 },
    ];
    expect(formatMessageEntities('Hello world code', entities)).toBe('<b>Hello</b> <i>world</i> <code>code</code>');
  });

  it('links, mentions and hashtags', () => {
    expect(formatMessageEntities('go', [{ type: 'text_link', offset: 0, length: 2, url: 'https://x.y' }])).toBe(
      '<a href="https://x.y">go</a>',
    );
    expect(formatMessageEntities('https://x.y', [{ type: 'url', offset: 0, length: 11 }])).toBe(
      '<a href="https://x.y">https://x.y</a>',
    );
    expect(formatMessageEntities('@bob', [{ type: 'mention', offset: 0, length: 4 }])).toBe(
      '<a href="https://t.me/bob">@bob</a>',
    );
    expect(formatMessageEntities('#tag', [{ type: 'hashtag', offset: 0, length: 4 }])).toBe(
      '<a href="https://t.me/hashtag/tag">#tag</a>',
    );
  });

  it('underline, strikethrough, pre, spoiler', () => {
    const wrap = (type: 'underline' | 'strikethrough' | 'pre' | 'spoiler') =>
      formatMessageEntities('x', [{ type, offset: 0, length: 1 }]);
    expect(wrap('underline')).toBe('<u>x</u>');
    expect(wrap('strikethrough')).toBe('<s>x</s>');
    expect(wrap('pre')).toBe('<pre>x</pre>');
    expect(wrap('spoiler')).toBe('<span class="tg-spoiler">x</span>');
  });

  it('leaves an unknown entity and a text_link without a url unformatted', () => {
    expect(formatMessageEntities('x', [{ type: 'cashtag', offset: 0, length: 1 }])).toBe('x');
    expect(formatMessageEntities('x', [{ type: 'text_link', offset: 0, length: 1 } as never])).toBe('x');
  });
});
