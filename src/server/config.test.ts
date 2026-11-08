import { describe, expect, it } from 'vitest';
import { parseSettings } from './config';

describe('bot webhook settings', () => {
  it('long polling needs no secret', () => {
    expect(parseSettings({}).bot).toMatchObject({ webhookUrl: '', webhookSecret: '' });
  });

  it('a webhook URL without a secret is refused: the endpoint would take forged updates', () => {
    expect(() => parseSettings({ BOT__WEBHOOK_URL: 'https://example.com/bot' })).toThrow(/BOT__WEBHOOK_SECRET/);
    expect(() => parseSettings({ BOT__WEBHOOK_URL: 'https://example.com/bot', BOT__WEBHOOK_SECRET: '' })).toThrow(
      /BOT__WEBHOOK_SECRET/,
    );
  });

  it('a webhook URL with a secret is accepted', () => {
    const { bot } = parseSettings({ BOT__WEBHOOK_URL: 'https://example.com/bot', BOT__WEBHOOK_SECRET: 'a-b_C9' });
    expect(bot).toMatchObject({ webhookUrl: 'https://example.com/bot', webhookSecret: 'a-b_C9' });
  });

  it("a secret Telegram's secret_token rejects is refused", () => {
    expect(() =>
      parseSettings({ BOT__WEBHOOK_URL: 'https://example.com/bot', BOT__WEBHOOK_SECRET: 'has space' }),
    ).toThrow();
    expect(() => parseSettings({ BOT__WEBHOOK_SECRET: 'x'.repeat(257) })).toThrow();
  });
});
